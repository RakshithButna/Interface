#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Everything is one process: the agent loop, the replay engine, the operator
 * console and the browser. That is a deliberate choice, and the brief
 * explicitly invites it ("single process vs. services... Simpler is fine if
 * justified").
 *
 * The justification: the load-bearing constraint in this system is that a human
 * must be able to take control of the SAME live browser session the automation
 * was using. Splitting the console into its own service would mean brokering
 * that session across a process boundary -- a real design problem in production
 * (you would put the browser behind a session service and address it by id) but
 * one that would add plumbing here without exercising any of the ideas being
 * evaluated. The seam that matters is `SessionController`; it is already the
 * only thing that decides who may act, so moving it behind an RPC later changes
 * one file rather than the architecture.
 */

import { join } from 'node:path';
import {
  parseArgs,
  flagString,
  flagBool,
  flagNumber,
  loadEnv,
  loadPolicy,
  confirm,
  armInjection,
  assertAppReachable,
  type Args,
} from './context.ts';
import { PlaywrightWebSurface } from '../surface/web/playwright-surface.ts';
import { Guard } from '../policy/guard.ts';
import { RunContext, newRunId } from '../observability/run-context.ts';
import { SessionController } from '../escalation/session-control.ts';
import { startOperatorConsole } from '../escalation/operator-console.ts';
import { HumanActionRecorder } from '../escalation/human-actions.ts';
import { runDiscovery } from '../agent/loop.ts';
import { createProvider, MissingApiKeyError } from '../agent/llm/factory.ts';
import { recordArtifact, type ParamDeclaration } from '../record/recorder.ts';
import { loadOutcomeLibrary } from '../record/outcome-library.ts';
import { replayCapability } from '../replay/engine.ts';
import { loadTenantOverride, listConfiguredTenants } from '../runtime/tenant-store.ts';
import { CapabilityStore, approvalReadiness } from '../catalog/store.ts';
import { toToolDefinition, toToolCatalog, summarizeCapability, describeCapability, toolNameFor } from '../catalog/catalog.ts';
import { summarize, exitCodeFor } from '../schema/result.ts';
import type { Scalar } from '../runtime/bindings.ts';

const EVIDENCE_ROOT = 'evidence';
const DEFAULT_ORIGIN = 'http://127.0.0.1:4173';

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'discover':
      return void (await cmdDiscover(args));
    case 'replay':
      return void (await cmdReplay(args));
    case 'catalog':
      return void (await cmdCatalog(args));
    case 'operator':
      return void (await cmdOperator(args));
    default:
      printHelp();
  }
}

/* ============================================================== discover */

async function cmdDiscover(args: Args): Promise<void> {
  const origin = flagString(args, 'origin', DEFAULT_ORIGIN);
  const tenant = flagString(args, 'tenant', 'westside');
  const baseUrl = `${origin}/t/${tenant}`;
  const entryUrl = flagString(args, 'entry', `${baseUrl}/`);
  const goal = flagString(args, 'goal', '');
  const name = flagString(args, 'name', '');

  if (!goal || !name) {
    console.error('discover requires --goal "..." and --name capability.dotted_name');
    process.exit(2);
  }

  await assertAppReachable(origin);

  let provider;
  try {
    provider = createProvider();
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      console.error(`\n${err.message}\n`);
      process.exit(3);
    }
    throw err;
  }

  const policy = loadPolicy();
  // Discovery is human-initiated and human-supervised, so it runs attended.
  const guard = new Guard(policy, 'attended');
  const ctx = new RunContext({ runId: newRunId('discovery'), kind: 'discovery', root: EVIDENCE_ROOT, policy });
  const controller = new SessionController();

  const secrets: Record<string, string> = {
    operatorUsername: process.env['MFC_OPERATOR_USER'] ?? 'svc_agent',
    operatorPassword: process.env['MFC_OPERATOR_PASSWORD'] ?? 'demo-only-not-a-real-secret',
  };

  console.log(`\n  discovery run ${ctx.runId}`);
  console.log(`  goal      ${goal}`);
  console.log(`  target    ${entryUrl}`);
  console.log(`  model     ${provider.name}/${provider.model}`);
  console.log(`  params    ${JSON.stringify(args.params)}`);
  console.log(`  evidence  ${ctx.dir}\n`);

  const surface = await PlaywrightWebSurface.launch(ctx.runId, {
    headless: flagBool(args, 'headless', false),
    slowMoMs: flagNumber(args, 'slow-mo', 0),
  });

  let console_: { url: string; close: () => Promise<void> } | undefined;
  if (flagBool(args, 'console', false)) {
    console_ = await startOperatorConsole({
      port: flagNumber(args, 'console-port', Number(process.env['OPERATOR_CONSOLE_PORT'] ?? 4180)),
      controller,
      getSurface: () => surface,
      onEvent: (event, data) => ctx.log(event, data),
    });
    console.log(`  operator console: ${console_.url}\n`);
  }

  const autoApprove = flagBool(args, 'yes', false);

  try {
    const outcome = await runDiscovery(
      {
        goal,
        entryUrl,
        tenantId: tenant,
        params: args.params,
        secrets,
        maxSteps: flagNumber(args, 'max-steps', policy.limits.maxDiscoverySteps),
      },
      {
        surface,
        provider,
        guard,
        ctx,
        approveRiskyStep: async (info) => {
          if (autoApprove) {
            ctx.log('human_approval_auto', { label: info.label, reason: info.reason });
            console.log(`\n  [risky step auto-approved via --yes] ${info.label} — ${info.reason}\n`);
            return true;
          }
          console.log(`\n  ${'-'.repeat(70)}`);
          console.log(`  HUMAN APPROVAL REQUIRED`);
          console.log(`  action:  ${info.label}`);
          console.log(`  intent:  ${info.intent}`);
          console.log(`  reason:  ${info.reason}`);
          console.log(`  ${'-'.repeat(70)}`);
          return confirm('  Allow this action?');
        },
      },
    );

    ctx.writeJson('transcript.json', {
      status: outcome.status,
      goal: outcome.goal,
      summary: outcome.summary,
      checkpointText: outcome.checkpointText,
      outputs: outcome.outputs,
      llmCalls: outcome.llmCalls,
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
      actions: outcome.actions.map((a) => ({
        seq: a.seq,
        kind: a.kind,
        intent: a.intent,
        risk: a.risk,
        riskReason: a.riskReason,
        control: a.node ? { role: a.node.role, name: a.node.name, field: a.node.formFieldName } : undefined,
        value: a.value,
        outputName: a.outputName,
        extractedValue: a.extractedValue,
        urlBefore: a.urlBefore,
        urlAfter: a.urlAfter,
      })),
    });

    if (outcome.status !== 'succeeded') {
      console.log(`\n  discovery ended: ${outcome.status}`);
      if (outcome.stuckReason) console.log(`  reason: ${outcome.stuckReason}`);
      if (outcome.failureMessage) console.log(`  detail: ${outcome.failureMessage}`);

      // A stuck discovery run is exactly the escalation case from section 3.6.
      if (outcome.status === 'stuck') {
        const evidence = await ctx.captureEvidence(surface, 'discovery-stuck');
        const req = controller.raise({
          kind: 'stuck',
          runId: ctx.runId,
          goal,
          tenantId: tenant,
          reason: outcome.stuckReason ?? 'The agent could not make progress',
          ...(outcome.stuckNeeds ? { detail: outcome.stuckNeeds } : {}),
          currentUrl: surface.currentUrl(),
          evidence,
        });
        ctx.log('escalation_raised', { interventionId: req.id, kind: 'stuck' });
        console.log(`\n  raised intervention ${req.id}`);
        if (console_) {
          const recorder = new HumanActionRecorder(surface.livePage(), (a) =>
            controller.recordHumanAction(req.id, a),
          );
          await recorder.start();
          console.log(`  waiting for an operator at ${console_.url}/i/${req.id} ...`);
          const resolution = await controller.awaitResolution(req.id, flagNumber(args, 'wait', 600) * 1000);
          console.log(`  operator resolution: ${resolution}`);
          ctx.log('escalation_resolved', { interventionId: req.id, resolution, humanActions: req.humanActions.length });
          ctx.writeJson('intervention.json', controller.get(req.id));
        }
      }

      ctx.finish({ status: outcome.status, goal });
      process.exitCode = 1;
      return;
    }

    /* --- record ------------------------------------------------------- */

    const declarations = parseParamDeclarations(args);
    const { artifact, warnings } = recordArtifact(outcome, {
      name,
      version: flagString(args, 'version', '1.0.0'),
      title: flagString(args, 'title', name),
      description: flagString(args, 'description', goal),
      productId: flagString(args, 'product', 'memberfirst-core'),
      productVersion: flagString(args, 'product-version', '7.2.1'),
      baseUrl,
      entryUrl,
      tenantId: tenant,
      params: args.params,
      paramDeclarations: declarations,
      secretNames: Object.keys(secrets),
      runId: ctx.runId,
      provider: provider.name,
      model: provider.model,
      evidencePath: ctx.dir,
      outcomeLibrary: loadOutcomeLibrary(flagString(args, 'product', 'memberfirst-core')),
    });

    const store = new CapabilityStore();
    const path = store.save(artifact);
    ctx.writeJson('artifact.json', artifact);

    console.log(`\n  ${'='.repeat(70)}`);
    console.log(`  RECORDED  ${artifact.name}@${artifact.version}  (status: ${artifact.status})`);
    console.log(`  ${artifact.steps.length} steps, ${artifact.inputs.length} inputs, ${artifact.outputs.length} outputs`);
    console.log(`  saved to  ${path}`);
    console.log(`  evidence  ${ctx.dir}`);
    if (warnings.length) {
      console.log(`\n  review warnings:`);
      for (const w of warnings) console.log(`    - ${w}`);
    }
    console.log(`  ${'='.repeat(70)}\n`);

    ctx.finish({ status: 'succeeded', capability: `${artifact.name}@${artifact.version}`, warnings });
  } finally {
    await console_?.close();
    await surface.close();
  }
}

/**
 * `--declare memberId:string:pii:"The member's account identifier"`
 * Lets the operator type the parameter contract at record time rather than
 * hand-editing the artifact afterwards.
 */
function parseParamDeclarations(args: Args): ParamDeclaration[] {
  const out: ParamDeclaration[] = [];
  for (const entry of args.lists['declare'] ?? []) {
    const [name, type, sensitivity, ...rest] = entry.split(':');
    if (!name) continue;
    const decl: ParamDeclaration = { name };
    if (type) decl.type = type as ParamDeclaration['type'];
    if (sensitivity) decl.sensitivity = sensitivity as ParamDeclaration['sensitivity'];
    const description = rest.join(':').replace(/^"|"$/g, '');
    if (description) decl.description = description;
    out.push(decl);
  }
  return out;
}

/* ================================================================ replay */

async function cmdReplay(args: Args): Promise<void> {
  const ref = args.positional[0];
  if (!ref) {
    console.error('replay requires a capability reference, e.g. `replay member.lookup_savings_balance`');
    process.exit(2);
  }

  const store = new CapabilityStore();
  const artifact = store.get(ref);
  if (!artifact) {
    console.error(`No capability '${ref}' in the catalogue. Try: npm run cli -- catalog list`);
    process.exit(2);
  }

  const origin = flagString(args, 'origin', DEFAULT_ORIGIN);
  await assertAppReachable(origin);

  const inject = flagString(args, 'inject', '');
  if (inject) {
    await armInjection(origin, inject);
    console.log(`  armed fault injection: ${inject}`);
  }

  const policy = loadPolicy();
  const mode = flagString(args, 'mode', 'unattended') === 'attended' ? 'attended' : 'unattended';
  const guard = new Guard(policy, mode);
  const ctx = new RunContext({ runId: newRunId('replay'), kind: 'replay', root: EVIDENCE_ROOT, policy });
  const controller = new SessionController();

  const tenant = flagString(args, 'tenant', artifact.provenance.recordedOnTenant);
  const params: Record<string, Scalar> = { ...args.params };

  // Product-level tenant configuration: one file per tenant, shared by every
  // capability recorded against that product.
  const tenantOverride = loadTenantOverride(artifact.app.productId, tenant);

  const secrets: Record<string, string> = {
    operatorUsername: process.env['MFC_OPERATOR_USER'] ?? 'svc_agent',
    operatorPassword: process.env['MFC_OPERATOR_PASSWORD'] ?? 'demo-only-not-a-real-secret',
  };
  // Credentials are declared inputs of the capability but are never supplied by
  // the calling agent -- they come from the runtime's secret store, keyed by
  // tenant. Strip them from `params` so validation sees them as bound.
  for (const key of Object.keys(secrets)) delete params[key];

  console.log(`\n  replay ${artifact.name}@${artifact.version}  (${artifact.status})`);
  console.log(`  tenant    ${tenant}${tenantOverride ? ' (override configured)' : ''}`);
  console.log(`  mode      ${mode}`);
  console.log(`  params    ${JSON.stringify(args.params)}`);
  console.log(`  evidence  ${ctx.dir}`);
  console.log(`  NOTE: no LLM is constructed on this path.\n`);

  const surface = await PlaywrightWebSurface.launch(ctx.runId, {
    headless: flagBool(args, 'headless', false),
    slowMoMs: flagNumber(args, 'slow-mo', 0),
  });

  const waitSeconds = flagNumber(args, 'wait-human', 0);
  let console_: { url: string; close: () => Promise<void> } | undefined;
  if (waitSeconds > 0 || flagBool(args, 'console', false)) {
    console_ = await startOperatorConsole({
      port: flagNumber(args, 'console-port', Number(process.env['OPERATOR_CONSOLE_PORT'] ?? 4180)),
      controller,
      getSurface: () => surface,
      onEvent: (event, data) => ctx.log(event, data),
    });
    console.log(`  operator console: ${console_.url}\n`);

    // Start capturing human actions up front: an intervention can be raised at
    // any step, and installing listeners only afterwards would miss the first
    // thing the operator does.
    const recorder = new HumanActionRecorder(surface.livePage(), (a) => {
      const open = controller.open()[0];
      if (open) controller.recordHumanAction(open.id, a);
      ctx.log('human_action', { ...a });
    });
    await recorder.start();
    controller.onChange((i) => {
      if (i.status === 'open') console.log(`\n  >>> intervention ${i.id} raised: ${i.reason}`);
      if (console_) console.log(`  >>> operate at ${console_.url}/i/${i.id}\n`);
    });
  }

  try {
    const result = await replayCapability({
      artifact,
      params,
      secrets,
      tenantId: tenant,
      tenantOverride,
      mode,
      surface,
      guard,
      ctx,
      controller,
      ...(waitSeconds > 0 ? { waitForHuman: { timeoutMs: waitSeconds * 1000 } } : {}),
    });

    ctx.writeJson('result.json', result);
    for (const i of controller.list()) ctx.writeJson(`intervention-${i.id}.json`, i);

    const updated = store.recordReplay(artifact, result);

    console.log(`\n  ${'='.repeat(70)}`);
    console.log(`  ${summarize(result)}`);
    if (result.warnings.length) {
      console.log('');
      for (const w of result.warnings) console.log(`  warning [${w.code}] ${w.message}`);
    }
    if (result.status === 'failed') {
      console.log('');
      console.log(`  step      ${result.error.stepId ?? '-'}`);
      if (result.error.expected) console.log(`  expected  ${result.error.expected}`);
      if (result.error.observed) console.log(`  observed  ${result.error.observed}`);
      if (result.error.evidence?.screenshotPath) {
        console.log(`  screenshot ${join(ctx.dir, result.error.evidence.screenshotPath)}`);
      }
    }
    console.log(`\n  stability now: ${updated.stability.successes}/${updated.stability.replays} successful`);
    console.log(`  evidence  ${ctx.dir}`);
    console.log(`  ${'='.repeat(70)}\n`);

    ctx.finish({ status: result.status, capability: `${artifact.name}@${artifact.version}`, tenant });
    process.exitCode = exitCodeFor(result);
  } finally {
    await console_?.close();
    await surface.close();
  }
}

/* =============================================================== catalog */

async function cmdCatalog(args: Args): Promise<void> {
  const store = new CapabilityStore();
  const sub = args.positional[0] ?? 'list';

  if (sub === 'list') {
    const items = store.list();
    if (items.length === 0) {
      console.log('\n  No capabilities recorded yet. Run a discovery first.\n');
      return;
    }
    console.log('');
    for (const a of items) console.log(`  ${summarizeCapability(a)}`);
    console.log('');
    return;
  }

  if (sub === 'show') {
    const a = store.get(args.positional[1] ?? '');
    if (!a) return void console.error('No such capability.');
    const tenants = listConfiguredTenants(a.app.productId);
    console.log(`\n${describeCapability(a)}`);
    console.log(`\nCONFIGURED TENANTS (product-level overrides)`);
    console.log(`  ${tenants.length ? tenants.join(', ') : '(none)'}`);
    console.log('');
    return;
  }

  if (sub === 'tools') {
    // The agent-facing view: exactly what a function-calling model would be
    // handed. No steps, no selectors -- just the contract.
    console.log(JSON.stringify(toToolCatalog(store.list()), null, 2));
    return;
  }

  if (sub === 'approve') {
    const a = store.get(args.positional[1] ?? '');
    if (!a) return void console.error('No such capability.');
    const readiness = approvalReadiness(a);
    console.log(`\n  ${a.name}@${a.version}`);
    console.log(`  stability: ${a.stability.successes}/${a.stability.replays} successful replays`);
    if (readiness.reasons.length) {
      console.log('  considerations:');
      for (const r of readiness.reasons) console.log(`    - ${r}`);
    }
    if (!readiness.ready && !flagBool(args, 'force', false)) {
      console.log(`\n  Not approving: this capability has not demonstrated a clean replay yet.`);
      console.log(`  Replay it successfully first, or pass --force to approve anyway.\n`);
      process.exitCode = 1;
      return;
    }
    const updated = store.setStatus(a, 'approved');
    console.log(`\n  approved ${updated.name}@${updated.version} for unattended invocation\n`);
    return;
  }

  if (sub === 'invoke') {
    // Demonstrates an agent calling a capability by name with typed args --
    // the same path an AI agent would take through the tool catalogue.
    const toolName = args.positional[1] ?? '';
    const artifact = store.list().find((a) => toolNameFor(a) === toolName || a.name === toolName);
    if (!artifact) return void console.error(`No capability exposed as tool '${toolName}'.`);

    const rawArgs = flagString(args, 'args', '{}');
    let parsed: Record<string, Scalar>;
    try {
      parsed = JSON.parse(rawArgs) as Record<string, Scalar>;
    } catch {
      return void console.error('--args must be valid JSON');
    }

    console.log(`\n  agent invokes tool: ${toolNameFor(artifact)}`);
    console.log(`  arguments: ${JSON.stringify(parsed)}`);
    console.log(`  tool schema the agent was given:`);
    console.log(`${JSON.stringify(toToolDefinition(artifact), null, 2).replace(/^/gm, '    ')}\n`);

    const replayArgs = parseArgs([
      'replay',
      `${artifact.name}@${artifact.version}`,
      ...Object.entries(parsed).flatMap(([k, v]) => ['--param', `${k}=${String(v)}`]),
      ...(args.flags['tenant'] ? ['--tenant', String(args.flags['tenant'])] : []),
      ...(args.flags['headless'] ? ['--headless'] : []),
      '--mode',
      String(args.flags['mode'] ?? 'unattended'),
    ]);
    await cmdReplay(replayArgs);
    return;
  }

  console.error(`Unknown catalog subcommand '${sub}'. Try: list, show, tools, approve, invoke`);
}

/* ============================================================== operator */

async function cmdOperator(args: Args): Promise<void> {
  const controller = new SessionController();
  const c = await startOperatorConsole({
    port: flagNumber(args, 'port', Number(process.env['OPERATOR_CONSOLE_PORT'] ?? 4180)),
    controller,
    getSurface: () => undefined,
  });
  console.log(`\n  Operator console listening at ${c.url}`);
  console.log(`  (standalone: no run is attached, so this only shows the UI.`);
  console.log(`   To see a live intervention, run a replay with --wait-human.)\n`);
}

/* ================================================================== help */

function printHelp(): void {
  console.log(`
computer-use automation

  An LLM discovers how to complete a task in a real UI once; the run is recorded
  as a typed capability artifact; the artifact replays deterministically with no
  model in the loop.

USAGE
  npm run app                       start the target application (separate terminal)
  npm run cli -- <command> [flags]

COMMANDS
  discover      Drive the app with an LLM to accomplish a goal, then record the
                successful run as a capability artifact.
    --goal "..."            the natural-language task              (required)
    --name a.b              dotted capability name                 (required)
    --param k=v             an input value for this run            (repeatable)
    --declare n:type:sens:"desc"   parameter contract metadata     (repeatable)
    --tenant westside       which tenant to record against
    --version 1.0.0         capability version
    --headless              run without a visible browser
    --console               start the operator console for escalations
    --yes                   auto-approve risky steps (unattended discovery)
    --max-steps 30          cap on agent turns

  replay <name[@version]>   Re-run a saved capability with no LLM involved.
    --param k=v             input values                           (repeatable)
    --tenant lakeshore      run against a different tenant's install
    --mode attended|unattended   default unattended
    --headless
    --wait-human 300        block for an operator on escalation, seconds
    --console               start the operator console
    --inject <mode>         arm a fault in the demo app before replaying:
                            interstitial | session_expired | app_error | slow

  catalog list                      list recorded capabilities
  catalog show <ref>                full reviewable description
  catalog tools                     JSON tool schemas for an AI agent
  catalog approve <ref> [--force]   allow unattended invocation
  catalog invoke <tool> --args '{}' invoke by name as an agent would

  operator [--port 4180]            run the operator console standalone
`);
}

main().catch((err: unknown) => {
  console.error(`\nfatal: ${(err as Error).message}\n`);
  if (process.env['DEBUG']) console.error(err);
  process.exit(1);
});
