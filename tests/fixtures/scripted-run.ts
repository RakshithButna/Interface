/**
 * A SCRIPTED stand-in for the discovery loop, used only by tests.
 *
 * To be unambiguous about what this is: the capability artifact committed to
 * this repository was produced by a real LLM discovery run, and the evidence
 * for that run is in /evidence/. This file is not that. It performs the same
 * sequence of surface actions the model performs, and produces the same
 * `DiscoveryOutcome` shape, so that the RECORD and REPLAY layers can be tested
 * end to end without spending an API call or depending on model behaviour in
 * CI.
 *
 * That separation is worth having on its own terms. The recorder, the
 * targeting capture, the replay engine and the error taxonomy are deterministic
 * code and deserve deterministic tests; only the discovery loop genuinely needs
 * a model. Coupling all of it to a live LLM would mean the test suite could
 * fail for reasons that have nothing to do with the code under test.
 */

import type { DiscoveryOutcome, RecordedAction } from '../../src/agent/loop.ts';
import type { Surface, UiNode, Observation } from '../../src/surface/types.ts';
import { classifyRisk } from '../../src/policy/risk.ts';

export interface ScriptStep {
  kind: 'click' | 'fill' | 'select' | 'extract';
  /** Locates the node in the current observation. */
  find: (obs: Observation) => UiNode | undefined;
  value?: string;
  secretRef?: string;
  outputName?: string;
  intent: string;
}

export interface ScriptedRunOptions {
  surface: Surface;
  entryUrl: string;
  goal: string;
  steps: ScriptStep[];
  checkpointText: string;
  summary: string;
  /** Real values for `secretRef` steps. Typed into the UI, never recorded. */
  secrets?: Record<string, string>;
}

export async function runScripted(opts: ScriptedRunOptions): Promise<DiscoveryOutcome> {
  const { surface } = opts;
  const actions: RecordedAction[] = [];
  const outputs: Record<string, string> = {};
  let seq = 0;

  await surface.perform({ kind: 'navigate', url: opts.entryUrl });
  await surface.settle(5000);

  for (const step of opts.steps) {
    const observation = await surface.observe();
    const node = step.find(observation);
    if (!node) {
      throw new Error(
        `scripted run: could not find the node for "${step.intent}" at ${observation.url}. ` +
          `Interactive nodes: ${observation.nodes
            .filter((n) => n.interactive)
            .map((n) => `${n.role}:${n.name}`)
            .join(', ')}`,
      );
    }

    const urlBefore = surface.currentUrl();
    let extractedValue: string | undefined;

    switch (step.kind) {
      case 'click':
        await surface.perform({ kind: 'click', ref: node.ref });
        break;
      case 'fill': {
        // Mirrors the live loop: the real secret is typed into the UI, while
        // only the placeholder is ever recorded.
        const actual = step.secretRef ? (opts.secrets?.[step.secretRef] ?? '') : (step.value ?? '');
        if (step.secretRef && !actual) {
          throw new Error(`scripted run: no secret supplied for '${step.secretRef}'`);
        }
        await surface.perform({ kind: 'fill', ref: node.ref, value: actual, clearFirst: true });
        break;
      }
      case 'select':
        await surface.perform({ kind: 'select', ref: node.ref, value: step.value ?? '' });
        break;
      case 'extract':
        extractedValue = (await surface.read(node.ref, 'text')) ?? '';
        outputs[step.outputName!] = extractedValue;
        break;
    }

    if (step.kind !== 'extract') await surface.settle(5000);

    const { risk, reason } = classifyRisk({
      actionType: step.kind === 'extract' ? 'extract' : step.kind,
      node,
    });

    seq += 1;
    const action: RecordedAction = {
      seq,
      kind: step.kind,
      intent: step.intent,
      risk,
      riskReason: reason,
      node,
      observation,
      urlBefore,
      urlAfter: surface.currentUrl(),
      observationAfter: await surface.observe(),
    };
    // The secret placeholder is what gets recorded, never the real value --
    // exactly as the live loop does it.
    if (step.secretRef) {
      action.value = `{{secret:${step.secretRef}}}`;
      action.secretRef = step.secretRef;
    } else if (step.value !== undefined) {
      action.value = step.value;
    }
    if (step.outputName) action.outputName = step.outputName;
    if (extractedValue !== undefined) action.extractedValue = extractedValue;

    actions.push(action);
  }

  return {
    status: 'succeeded',
    goal: opts.goal,
    actions,
    outputs,
    summary: opts.summary,
    checkpointText: opts.checkpointText,
    finalObservation: await surface.observe(),
    llmCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
  };
}

/* ------------------------------------------------- node-finding helpers */

export const find = {
  field:
    (name: string) =>
    (obs: Observation): UiNode | undefined =>
      obs.nodes.find((n) => n.formFieldName === name),

  button:
    (label: string) =>
    (obs: Observation): UiNode | undefined =>
      obs.nodes.find((n) => n.role === 'button' && n.name === label),

  link:
    (label: string) =>
    (obs: Observation): UiNode | undefined =>
      obs.nodes.find((n) => n.role === 'link' && n.name === label),

  /** The identically-labelled link on the row for a given member. */
  rowLink:
    (label: string, memberId: string) =>
    (obs: Observation): UiNode | undefined =>
      obs.nodes.find(
        (n) => n.role === 'link' && n.name === label && n.table?.rowCells[0] === memberId,
      ),

  /** A cell in a named column, on the row whose type column matches. */
  cellInRow:
    (column: string, rowMatch: string) =>
    (obs: Observation): UiNode | undefined =>
      obs.nodes.find(
        (n) =>
          n.role === 'cell' &&
          n.table?.columnHeader === column &&
          n.table.rowCells.includes(rowMatch),
      ),
};
