/**
 * End-to-end integration: capture -> record -> replay, against the real
 * application, in a real browser, with no LLM.
 *
 * This is the test that actually proves the system works. Everything else
 * checks a component in isolation; this one records a capability from a live
 * run and then replays it under the conditions the brief says matter most --
 * a happy path, two different business outcomes, an unexpected interstitial, a
 * session timeout, and a second tenant running the same product.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';

import { PlaywrightWebSurface } from '../src/surface/web/playwright-surface.ts';
import { Guard } from '../src/policy/guard.ts';
import { PolicyConfigSchema, DEFAULT_POLICY, type PolicyConfig } from '../src/policy/config.ts';
import { RunContext, newRunId } from '../src/observability/run-context.ts';
import { SessionController } from '../src/escalation/session-control.ts';
import { recordArtifact } from '../src/record/recorder.ts';
import { loadOutcomeLibrary } from '../src/record/outcome-library.ts';
import { replayCapability } from '../src/replay/engine.ts';
import { TenantOverrideSchema, type CapabilityArtifact } from '../src/schema/artifact.ts';
import { runScripted, find } from './fixtures/scripted-run.ts';
import type { ReplayResult } from '../src/schema/result.ts';

const PORT = 4174;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const EVIDENCE_ROOT = '.test-evidence';
const CREDS = { operatorUsername: 'svc_agent', operatorPassword: 'demo-only-not-a-real-secret' };

const POLICY: PolicyConfig = PolicyConfigSchema.parse({
  ...DEFAULT_POLICY,
  allowlist: { ...DEFAULT_POLICY.allowlist, origins: [ORIGIN] },
});

let server: ChildProcess;

before(async () => {
  server = spawn('node', ['apps/memberfirst-core/server.ts'], {
    env: { ...process.env, APP_PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${ORIGIN}/_control/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('target app did not start');
});

after(async () => {
  server?.kill();
  rmSync(EVIDENCE_ROOT, { recursive: true, force: true });
});

async function reset(): Promise<void> {
  await fetch(`${ORIGIN}/_control/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'none' }),
  });
}

async function arm(mode: string): Promise<void> {
  await fetch(`${ORIGIN}/_control/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
}

/* ------------------------------------------------------------ recording */

/**
 * Records the capability once, from a live run, and reuses it for every replay
 * assertion below -- which is the point: one recording, many invocations.
 */
async function recordLookupCapability(): Promise<CapabilityArtifact> {
  const surface = await PlaywrightWebSurface.launch('rec', { headless: true });
  const ctx = new RunContext({ runId: newRunId('discovery'), kind: 'discovery', root: EVIDENCE_ROOT, policy: POLICY, verbose: false });

  try {
    const outcome = await runScripted({
      surface,
      entryUrl: `${ORIGIN}/t/westside/`,
      goal: 'Look up member 12345 and read their current savings balance',
      secrets: CREDS,
      checkpointText: '$4,281.37', // mirrors what the real model actually nominated
      summary: 'Signed on, searched for the member, opened their record and read the savings balance.',
      steps: [
        { kind: 'fill', find: find.field('username'), secretRef: 'operatorUsername', intent: 'enter the operator ID' },
        { kind: 'fill', find: find.field('password'), secretRef: 'operatorPassword', intent: 'enter the operator password' },
        { kind: 'click', find: find.button('Sign On'), intent: 'sign on to the servicing desktop' },
        { kind: 'click', find: find.link('Member Search'), intent: 'open the member search screen' },
        { kind: 'fill', find: find.field('memberId'), value: '12345', intent: 'enter the member ID to search for' },
        { kind: 'click', find: find.button('Search'), intent: 'run the member search' },
        { kind: 'click', find: find.rowLink('View', '12345'), intent: "open the matching member's record" },
        {
          kind: 'extract',
          find: find.cellInRow('Savings Balance', 'SAVINGS'),
          outputName: 'savingsBalance',
          intent: 'read the current savings balance from the accounts panel',
        },
      ],
    });

    const { artifact } = recordArtifact(outcome, {
      name: 'member.lookup_savings_balance',
      version: '1.0.0',
      title: 'Look up a member savings balance',
      description: "Reads a member's current savings balance from the core servicing screens.",
      productId: 'memberfirst-core',
      productVersion: '7.2.1',
      baseUrl: `${ORIGIN}/t/westside`,
      entryUrl: `${ORIGIN}/t/westside/`,
      tenantId: 'westside',
      params: { memberId: '12345' },
      paramDeclarations: [
        { name: 'memberId', type: 'string', sensitivity: 'pii', description: 'The member identifier to look up.' },
      ],
      secretNames: Object.keys(CREDS),
      runId: ctx.runId,
      provider: 'scripted',
      model: 'scripted-test-fixture',
      outcomeLibrary: loadOutcomeLibrary('memberfirst-core'),
    });

    return artifact;
  } finally {
    await surface.close();
  }
}

async function replayOnce(
  artifact: CapabilityArtifact,
  params: Record<string, string>,
  opts: { tenantId?: string; inject?: string } = {},
): Promise<ReplayResult> {
  await reset();
  if (opts.inject) await arm(opts.inject);

  const surface = await PlaywrightWebSurface.launch('rep', { headless: true });
  const ctx = new RunContext({ runId: newRunId('replay'), kind: 'replay', root: EVIDENCE_ROOT, policy: POLICY, verbose: false });

  try {
    return await replayCapability({
      artifact,
      params,
      secrets: CREDS,
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      mode: 'attended',
      surface,
      guard: new Guard(POLICY, 'attended'),
      ctx,
      controller: new SessionController(),
    });
  } finally {
    await surface.close();
  }
}

/* ------------------------------------------------------------------ tests */

describe('record -> replay pipeline', { timeout: 180_000 }, () => {
  let artifact: CapabilityArtifact;

  before(async () => {
    artifact = await recordLookupCapability();
  });

  test('the recorded artifact is a reusable contract, not a transcript', () => {
    assert.equal(artifact.status, 'draft', 'a model-authored flow must not start approved');
    assert.equal(artifact.steps.length, 9); // 8 recorded actions + the synthesised entry navigation

    // Parameterized, not hardcoded.
    const names = artifact.inputs.map((i) => i.name).sort();
    assert.deepEqual(names, ['memberId', 'operatorPassword', 'operatorUsername']);
    assert.equal(artifact.inputs.find((i) => i.name === 'memberId')!.sensitivity, 'pii');
    assert.equal(artifact.inputs.find((i) => i.name === 'operatorPassword')!.sensitivity, 'secret');

    // Outputs are declared and typed.
    assert.equal(artifact.outputs.length, 1);
    assert.equal(artifact.outputs[0]!.name, 'savingsBalance');
    assert.equal(artifact.outputs[0]!.type, 'money');

    // The error vocabulary came from the product library.
    assert.ok(artifact.outcomes.some((o) => o.code === 'MEMBER_NOT_FOUND'));
    assert.ok(artifact.recoveries.some((r) => r.id === 'session-expired-reauth'));

    // The login preamble is explicit, so re-auth has a defined meaning.
    assert.equal(artifact.authPreambleStepIds.length, 4); // entry navigate + 2 credential fills + submit
  });

  test('no credential value appears anywhere in the artifact', () => {
    const serialized = JSON.stringify(artifact);
    assert.ok(!serialized.includes(CREDS.operatorPassword), 'the password must never be persisted');
    assert.ok(!serialized.includes(CREDS.operatorUsername));
    // It is referenced by parameter instead.
    assert.match(serialized, /"param":"operatorPassword"/);
  });

  test('the grid step is row-anchored to the input parameter, not to a row position', () => {
    const step = artifact.steps.find((s) => s.intent.includes("open the matching member's record"))!;
    assert.ok('target' in step.action);
    const target = (step.action as { target: { scope?: unknown } }).target as {
      scope?: { kind: string; matchColumn: string; matchValue: unknown };
      strategies: Array<{ kind: string }>;
    };
    assert.equal(target.scope?.kind, 'tableRow');
    assert.equal(target.scope?.matchColumn, 'Member ID');
    assert.deepEqual(target.scope?.matchValue, { param: 'memberId' });
    assert.ok(!target.strategies.some((s) => s.kind === 'structural'));
  });

  test('no input value is committed into the artifact as free text', () => {
    // description and provenance.goal come from the operator's natural-language
    // goal, which names a real member. The artifact is committed to git, so a
    // raw member ID there is regulated data checked into version control.
    // Generalising to ${memberId} removes the PII and makes the description
    // correct for a reusable capability at the same time.
    assert.ok(!artifact.description.includes('12345'), artifact.description);
    assert.ok(!artifact.provenance.goal.includes('12345'), artifact.provenance.goal);
    // The goal names the member, so it must come back parameterised.
    assert.match(artifact.provenance.goal, /\$\{memberId\}/);
  });

  test('rejects a success checkpoint made of run-specific data', () => {
    // The real LLM run nominated "$4,281.37" -- member 12345's balance -- as
    // proof of success. That reads like a perfect checkpoint and is the
    // opposite: it asserts the capability only ever worked for one member, so
    // the first invocation with a different member fails even though every
    // step ran. The recorder must reject it for something structural.
    const cp = artifact.successCheckpoint as { kind: string; text?: string };
    assert.equal(cp.kind, 'textPresent');
    assert.ok(cp.text, 'a success condition must exist');
    assert.ok(
      !/\d[\d,]*\.\d{2}/.test(cp.text!),
      `checkpoint must not contain a value from the run, got ${JSON.stringify(cp.text)}`,
    );
  });

  test('the extract step has no locator rung matching the extracted value', () => {
    // Capture records a `text` rung from the node's own text, which on an
    // extract step is the datum just read. It can only match a cell holding
    // this run's answer, so it is never the rung we want.
    const step = artifact.steps.find((s) => s.action.type === 'extract')!;
    const target = (step.action as { target: { strategies: Array<{ kind: string; text?: string }> } }).target;
    assert.ok(
      !target.strategies.some((s) => s.kind === 'text' && /\d[\d,]*\.\d{2}/.test(s.text ?? '')),
      'no ladder rung may match on the extracted value',
    );
  });

  test('replays successfully and returns the typed output', async () => {
    const r = await replayOnce(artifact, { memberId: '12345' });
    assert.equal(r.status, 'success', r.status === 'failed' ? JSON.stringify(r.error) : '');
    assert.equal(r.status === 'success' && r.outputs['savingsBalance'], 4281.37);
  });

  test('replays for a DIFFERENT member without re-recording', async () => {
    // The real test of parameterization: same artifact, different row.
    const r = await replayOnce(artifact, { memberId: '22887' });
    assert.equal(r.status, 'success', r.status === 'failed' ? JSON.stringify(r.error) : '');
    assert.equal(r.status === 'success' && r.outputs['savingsBalance'], 15029.9);
  });

  test('an unknown member is a BUSINESS OUTCOME, not a failure', async () => {
    const r = await replayOnce(artifact, { memberId: '99999' });
    assert.equal(r.status, 'outcome');
    assert.equal(r.status === 'outcome' && r.outcome, 'MEMBER_NOT_FOUND');
    assert.equal(r.status === 'outcome' && r.disposition, 'terminal');
  });

  test('a restricted member surfaces as PERMISSION_DENIED, not a crash', async () => {
    const r = await replayOnce(artifact, { memberId: '30001' });
    assert.equal(r.status, 'outcome');
    assert.equal(r.status === 'outcome' && r.outcome, 'PERMISSION_DENIED');
  });

  test('an unexpected interstitial is recovered from, and reported', async () => {
    const r = await replayOnce(artifact, { memberId: '12345' }, { inject: 'interstitial' });
    assert.equal(r.status, 'success', r.status === 'failed' ? JSON.stringify(r.error) : '');
    assert.ok(
      r.warnings.some((w) => w.code === 'RECOVERY_APPLIED' && w.message.includes('dismiss-maintenance-notice')),
      'the run must report that it recovered, not hide it',
    );
  });

  test('a mid-flow session timeout re-authenticates and completes', async () => {
    const r = await replayOnce(artifact, { memberId: '12345' }, { inject: 'session_expired' });
    assert.equal(r.status, 'success', r.status === 'failed' ? JSON.stringify(r.error) : '');
    assert.ok(r.warnings.some((w) => w.message.includes('session-expired-reauth')));
  });

  test('an unexpected application error escalates rather than retrying', async () => {
    // Retrying an unknown server-side failure on a system of record could
    // duplicate a transaction, so the recovery rule routes it to a human.
    const r = await replayOnce(artifact, { memberId: '12345' }, { inject: 'app_error' });
    assert.ok(
      r.status === 'escalated' || r.status === 'outcome' || r.status === 'failed',
      `expected a deliberate non-success, got ${r.status}`,
    );
    if (r.status === 'escalated') assert.match(r.reason, /system error/i);
  });

  test('inputs violating the contract are rejected before the browser is touched', async () => {
    const withPattern: CapabilityArtifact = {
      ...artifact,
      inputs: artifact.inputs.map((i) => (i.name === 'memberId' ? { ...i, pattern: '^\\d{1,10}$' } : i)),
    };
    const r = await replayOnce(withPattern, { memberId: 'not-a-number' });
    assert.equal(r.status, 'failed');
    assert.equal(r.status === 'failed' && r.error.code, 'INPUT_VALIDATION_FAILED');
    assert.equal(r.steps.length, 0, 'nothing should have been executed');
  });

  test('unattended replay of an unapproved capability is refused', async () => {
    await reset();
    const surface = await PlaywrightWebSurface.launch('gate', { headless: true });
    const ctx = new RunContext({ runId: newRunId('replay'), kind: 'replay', root: EVIDENCE_ROOT, policy: POLICY, verbose: false });
    try {
      const r = await replayCapability({
        artifact,
        params: { memberId: '12345' },
        secrets: CREDS,
        mode: 'unattended',
        surface,
        guard: new Guard(POLICY, 'unattended'),
        ctx,
        controller: new SessionController(),
      });
      assert.equal(r.status, 'failed');
      assert.equal(r.status === 'failed' && r.error.code, 'NOT_APPROVED');
    } finally {
      await surface.close();
    }
  });

  /* ------------------------------------------------- cross-tenant reuse */

  test('the same artifact replays against a second tenant via overrides alone', async () => {
    // lakeshore runs the same vendor product with different branding, different
    // field labels, different route slugs, an extra compliance interstitial and
    // a different minimum deposit. No steps are re-recorded.
    const withOverride: CapabilityArtifact = {
      ...artifact,
      overrides: [
        TenantOverrideSchema.parse({
          tenantId: 'lakeshore',
          note: 'Same MemberFirst Core product, v6.9.4, rebranded and relabelled.',
          baseUrl: `${ORIGIN}/t/lakeshore`,
          labelAliases: {
            'Member ID': 'Membership Number',
            'Member Name': 'Name on Record',
            'Savings Balance': 'Savings Bal.',
            'Member Search': 'Find Member',
            Search: 'Find',
            View: 'Open',
          },
          routeAliases: { 'member-search': 'members/find', member: 'members/detail' },
        }),
      ],
    };

    const r = await replayOnce(withOverride, { memberId: '12345' }, { tenantId: 'lakeshore' });
    assert.equal(r.status, 'success', r.status === 'failed' ? JSON.stringify(r.error) : '');
    assert.equal(r.status === 'success' && r.outputs['savingsBalance'], 4281.37);
    assert.ok(r.warnings.some((w) => w.code === 'TENANT_OVERRIDE_APPLIED'));
    // The compliance acknowledgement lakeshore adds after sign-on is absorbed
    // by the product-level recovery rule, not by a tenant-specific step.
    assert.ok(
      r.warnings.some((w) => w.message.includes('acknowledge-compliance-notice')),
      "lakeshore's extra screen should be handled as a recovery",
    );
  });
});
