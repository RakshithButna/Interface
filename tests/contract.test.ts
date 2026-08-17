import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateInputs, transformExtracted, coerceOutput } from '../src/replay/inputs.ts';
import { CapabilityArtifactSchema, inputsToJsonSchema, type CapabilityArtifact } from '../src/schema/artifact.ts';
import { toToolDefinition } from '../src/catalog/catalog.ts';
import { approvalReadiness } from '../src/catalog/store.ts';
import { isConclusive, exitCodeFor, summarize, type ReplayResult } from '../src/schema/result.ts';

function artifact(overrides: Partial<CapabilityArtifact> = {}): CapabilityArtifact {
  return CapabilityArtifactSchema.parse({
    schemaVersion: '1.0.0',
    name: 'member.lookup_savings_balance',
    version: '1.0.0',
    title: 'Look up savings balance',
    description: "Reads a member's current savings balance.",
    app: { productId: 'memberfirst-core', baseUrl: 'http://app.test/t/westside' },
    inputs: [
      { name: 'memberId', type: 'string', description: 'Member identifier', pattern: '^\\d{1,10}$', sensitivity: 'pii', example: '12345' },
      { name: 'operatorPassword', type: 'string', description: 'Credential', sensitivity: 'secret', example: 'hunter2' },
      { name: 'note', type: 'string', description: 'Optional note', required: false },
    ],
    outputs: [{ name: 'savingsBalance', type: 'money', description: 'Current balance', producedByStep: 's04_extract' }],
    outcomes: [{ code: 'MEMBER_NOT_FOUND', description: 'No such member', disposition: 'terminal' }],
    steps: [{ id: 's01', intent: 'go', action: { type: 'navigate', url: { literal: '/' } } }],
    successCheckpoint: { kind: 'textPresent', text: 'Member Detail', match: 'contains', caseSensitive: false },
    provenance: {
      discoveryRunId: 'run1',
      recordedAt: '2026-01-01T00:00:00Z',
      model: 'test',
      provider: 'test',
      goal: 'g',
      recordedOnTenant: 'westside',
    },
    ...overrides,
  });
}

describe('input contract', () => {
  const a = artifact();

  test('accepts valid inputs and applies the declared types', () => {
    const r = validateInputs(a, { memberId: '12345', operatorPassword: 'x' });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.values['memberId'], '12345');
  });

  test('rejects a value that violates the declared pattern before touching the UI', () => {
    const r = validateInputs(a, { memberId: 'abc', operatorPassword: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.failures[0]!.problem : '', /pattern/);
  });

  test('rejects a missing required input', () => {
    const r = validateInputs(a, { operatorPassword: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.failures[0]!.param, 'memberId');
  });

  test('rejects an undeclared parameter rather than silently dropping it', () => {
    const r = validateInputs(a, { memberId: '1', operatorPassword: 'x', memberID: '2' });
    assert.equal(r.ok, false);
    assert.ok(r.ok === false && r.failures.some((f) => f.param === 'memberID'));
  });

  test('optional inputs may be omitted', () => {
    assert.equal(validateInputs(a, { memberId: '1', operatorPassword: 'x' }).ok, true);
  });

  test('enum inputs are constrained to their declared values', () => {
    const withEnum = artifact({
      inputs: [{ name: 'productType', type: 'enum', enumValues: ['SHARE_SAVINGS', 'VACATION_CLUB'], description: 'p', required: true, sensitivity: 'none' }],
    });
    assert.equal(validateInputs(withEnum, { productType: 'SHARE_SAVINGS' }).ok, true);
    assert.equal(validateInputs(withEnum, { productType: 'NOT_A_PRODUCT' }).ok, false);
  });
});

describe('output coercion', () => {
  test('money becomes a number the caller can compute with', () => {
    assert.deepEqual(coerceOutput({ name: 'b', type: 'money', description: '', producedByStep: 's', required: true, sensitivity: 'none' }, '$4,281.37'), { value: 4281.37 });
  });

  test('a value that does not fit its declared type is reported, not coerced to NaN', () => {
    const r = coerceOutput({ name: 'b', type: 'money', description: '', producedByStep: 's', required: true, sensitivity: 'none' }, 'not a balance');
    assert.ok('problem' in r);
  });

  test('extractPattern pulls a capture group out of surrounding text', () => {
    assert.deepEqual(
      transformExtracted('Confirmation reference 12345-71.', 'trim', 'reference ([\\d-]+)'),
      { value: '12345-71' },
    );
  });

  test('a non-matching extractPattern is an error rather than a silent empty string', () => {
    const r = transformExtracted('nothing here', 'trim', 'reference ([\\d-]+)');
    assert.ok('problem' in r);
  });
});

describe('agent-facing tool schema', () => {
  test('exposes the contract and hides the implementation', () => {
    const tool = toToolDefinition(artifact());
    assert.equal(tool.name, 'member__lookup_savings_balance');

    const json = JSON.stringify(tool);
    assert.ok(!json.includes('steps'), 'the calling agent must not be handed the flow');
    assert.ok(!json.includes('strategies'));
    assert.ok(!json.includes('frame'));

    // It MUST be told about business outcomes, or it cannot handle them.
    assert.match(tool.description, /MEMBER_NOT_FOUND/);
    assert.match(tool.description, /NOT errors/);
    assert.match(tool.description, /savingsBalance/);
  });

  test('never publishes an example for a sensitive parameter', () => {
    const schema = inputsToJsonSchema(artifact()) as {
      properties: Record<string, { examples?: unknown[] }>;
      required: string[];
    };
    assert.equal(schema.properties['operatorPassword']!.examples, undefined, 'no example for a secret');
    assert.equal(schema.properties['memberId']!.examples, undefined, 'no example for PII either');
    assert.deepEqual(schema.required.sort(), ['memberId', 'operatorPassword']);
  });
});

describe('result contract', () => {
  const base = {
    runId: 'r',
    capability: 'a.b',
    capabilityVersion: '1.0.0',
    tenantId: 't',
    startedAt: 'now',
    durationMs: 1,
    steps: [],
    warnings: [],
    evidence: {},
  };

  test('a business outcome is a successful invocation, not a failure', () => {
    const r: ReplayResult = { ...base, status: 'outcome', outcome: 'MEMBER_NOT_FOUND', message: 'no such member', disposition: 'terminal', partialOutputs: {} };
    assert.equal(isConclusive(r), true);
    assert.equal(exitCodeFor(r), 0, 'a legitimate business answer must not look like a crash to a caller');
    assert.match(summarize(r), /OUTCOME/);
  });

  test('a hard failure is distinguishable and exits non-zero', () => {
    const r: ReplayResult = { ...base, status: 'failed', partialOutputs: {}, error: { code: 'TARGET_NOT_FOUND', message: 'x', stepId: 's01' } };
    assert.equal(isConclusive(r), false);
    assert.equal(exitCodeFor(r), 1);
  });

  test('an escalation is neither success nor failure', () => {
    const r: ReplayResult = { ...base, status: 'escalated', interventionId: 'int_1', reason: 'needs a human', resumable: true };
    assert.equal(isConclusive(r), false);
    assert.equal(exitCodeFor(r), 2);
  });
});

describe('approval gating', () => {
  test('a never-replayed capability is not ready for unattended use', () => {
    const r = approvalReadiness(artifact());
    assert.equal(r.ready, false);
    assert.ok(r.reasons.includes('never replayed'));
  });

  test('a clean replay makes it ready', () => {
    const r = approvalReadiness(artifact({ stability: { replays: 1, successes: 1, businessOutcomes: 0, failures: 0, escalations: 0, driftingSteps: [] } }));
    assert.equal(r.ready, true);
  });

  test('any outright failure blocks approval', () => {
    const r = approvalReadiness(artifact({ stability: { replays: 2, successes: 1, businessOutcomes: 0, failures: 1, escalations: 0, driftingSteps: [] } }));
    assert.equal(r.ready, false);
  });

  test('business outcomes count as working, not as flakiness', () => {
    const r = approvalReadiness(artifact({ stability: { replays: 3, successes: 0, businessOutcomes: 3, failures: 0, escalations: 0, driftingSteps: [] } }));
    assert.equal(r.ready, true, 'returning MEMBER_NOT_FOUND three times is a capability working correctly');
  });

  test('observed drift is surfaced to the approver', () => {
    const r = approvalReadiness(artifact({ stability: { replays: 1, successes: 1, businessOutcomes: 0, failures: 0, escalations: 0, driftingSteps: ['s03_click'] } }));
    assert.ok(r.reasons.some((x) => x.includes('s03_click')));
  });
});
