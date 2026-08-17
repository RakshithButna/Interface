/**
 * The agent-facing capability catalogue.
 *
 * This is where the framing the brief keeps returning to becomes concrete: a
 * saved artifact is not a script, it is a CAPABILITY an AI agent can discover
 * by name and invoke with typed arguments. The catalogue is what makes that
 * literal rather than rhetorical -- it emits the same tool/function-calling
 * schema an agent would be given for any other tool, generated from the
 * artifact's declared contract.
 *
 * The important property is that the tool description tells the calling agent
 * everything it needs WITHOUT exposing the flow. It sees what the capability
 * does, what arguments it takes, what it returns, and -- critically -- the set
 * of business outcomes it may answer with. It never sees a step, a selector or
 * a frame path, because none of that is its business. Swapping the recording
 * underneath for a different one, or for a real API when the vendor finally
 * ships one, changes nothing for the caller.
 */

import type { CapabilityArtifact } from '../schema/artifact.ts';
import { inputsToJsonSchema, artifactRef } from '../schema/artifact.ts';
import type { ToolDefinition } from '../agent/llm/provider.ts';

/** Tool name safe for function calling: dots are not universally accepted. */
export function toolNameFor(a: CapabilityArtifact): string {
  return a.name.replace(/\./g, '__');
}

export function toToolDefinition(a: CapabilityArtifact): ToolDefinition {
  const outputLines = a.outputs.map((o) => `  - ${o.name} (${o.type}): ${o.description}`);
  const secretCount = a.inputs.filter((i) => i.sensitivity === 'secret').length;
  const outcomeLines = a.outcomes.map(
    (o) => `  - ${o.code} (${o.disposition}): ${o.description}`,
  );

  const description = [
    a.description,
    '',
    `Runs against: ${a.app.productId}${a.app.productVersion ? ` v${a.app.productVersion}` : ''}.`,
    `Status: ${a.status}.`,
    outputLines.length ? `Returns on success:\n${outputLines.join('\n')}` : 'Returns no data on success.',
    outcomeLines.length
      ? `May instead answer with one of these business outcomes, which are NOT errors:\n${outcomeLines.join('\n')}`
      : '',
    secretCount > 0
      ? `Credentials (${secretCount}) are injected by the runtime from the tenant's secret store and are not parameters you supply.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    name: toolNameFor(a),
    description,
    parameters: inputsToJsonSchema(a),
  };
}

/** The whole catalogue as a tool array, ready to hand to a function-calling model. */
export function toToolCatalog(artifacts: CapabilityArtifact[]): ToolDefinition[] {
  return artifacts.map(toToolDefinition);
}

/** Human-readable one-liner for `catalog list`. */
export function summarizeCapability(a: CapabilityArtifact): string {
  const inputs = a.inputs.map((i) => `${i.name}${i.required ? '' : '?'}: ${i.type}`).join(', ');
  const outs = a.outputs.map((o) => o.name).join(', ') || '-';
  const s = a.stability;
  const stats = s.replays === 0 ? 'never replayed' : `${s.successes}/${s.replays} ok`;
  return `${artifactRef(a).padEnd(38)} [${a.status.padEnd(8)}] (${inputs}) -> ${outs}   ${stats}`;
}

/** Detailed, reviewer-facing rendering for `catalog show`. */
export function describeCapability(a: CapabilityArtifact): string {
  const L: string[] = [];
  L.push(`${a.title}`);
  L.push(`${artifactRef(a)}  status=${a.status}  schema=${a.schemaVersion}`);
  L.push('');
  L.push(a.description);
  L.push('');
  L.push(`APP        ${a.app.productId}${a.app.productVersion ? ` v${a.app.productVersion}` : ''} (${a.app.surface})`);
  L.push(`BASE URL   ${a.app.baseUrl}`);
  L.push(`RECORDED   ${a.provenance.recordedAt} by ${a.provenance.provider}/${a.provenance.model}`);
  L.push(`           on tenant '${a.provenance.recordedOnTenant}', run ${a.provenance.discoveryRunId}`);
  L.push(`GOAL       "${a.provenance.goal}"`);

  L.push('');
  L.push('INPUTS');
  if (a.inputs.length === 0) L.push('  (none)');
  for (const i of a.inputs) {
    const flags = [i.required ? 'required' : 'optional', i.sensitivity !== 'none' ? i.sensitivity : '']
      .filter(Boolean)
      .join(', ');
    L.push(`  ${i.name} : ${i.type}  [${flags}]`);
    L.push(`      ${i.description}`);
    if (i.pattern) L.push(`      pattern: /${i.pattern}/`);
  }

  L.push('');
  L.push('OUTPUTS');
  if (a.outputs.length === 0) L.push('  (none)');
  for (const o of a.outputs) L.push(`  ${o.name} : ${o.type}  <- ${o.producedByStep}   ${o.description}`);

  L.push('');
  L.push('BUSINESS OUTCOMES (legitimate non-success answers)');
  if (a.outcomes.length === 0) L.push('  (none declared)');
  for (const o of a.outcomes) L.push(`  ${o.code} (${o.disposition})  ${o.description}`);

  L.push('');
  L.push(`STEPS (${a.steps.length})`);
  for (const s of a.steps) {
    const risk = s.risk === 'safe' ? '' : `  [!${s.risk}]`;
    L.push(`  ${s.id.padEnd(18)} ${s.action.type.padEnd(9)} ${s.intent}${risk}`);
    if ('target' in s.action && s.action.target) {
      const t = s.action.target;
      const ladder = t.strategies.map((x) => x.kind).join(' > ');
      L.push(`  ${''.padEnd(18)}   target: ${t.description}`);
      L.push(`  ${''.padEnd(18)}   ladder: ${ladder}`);
      if (t.scope?.kind === 'tableRow') {
        const v = t.scope.matchValue;
        const shown = 'param' in v ? `\${${v.param}}` : 'literal' in v ? JSON.stringify(v.literal) : '(expr)';
        L.push(`  ${''.padEnd(18)}   scope:  row where '${t.scope.matchColumn}' = ${shown}`);
      }
    }
    if (s.checkpoint) L.push(`  ${''.padEnd(18)}   checkpoint: ${describeShort(s.checkpoint)}`);
  }

  L.push('');
  L.push(`AUTH PREAMBLE  ${a.authPreambleStepIds.join(', ') || '(none)'}`);
  L.push(`RECOVERIES     ${a.recoveries.map((r) => r.id).join(', ') || '(none)'}`);
  L.push(`OVERRIDES      ${a.overrides.map((o) => o.tenantId).join(', ') || '(none)'}`);

  L.push('');
  L.push('STABILITY');
  const s = a.stability;
  L.push(
    `  replays=${s.replays} success=${s.successes} outcome=${s.businessOutcomes} ` +
      `escalated=${s.escalations} failed=${s.failures}`,
  );
  if (s.driftingSteps.length) L.push(`  drifting steps: ${s.driftingSteps.join(', ')}`);

  return L.join('\n');
}

function describeShort(a: { kind: string } & Record<string, unknown>): string {
  if (a.kind === 'textPresent') return `text "${String(a['text'])}"`;
  if (a.kind === 'urlMatches') return `url /${String(a['pattern'])}/`;
  return a.kind;
}
