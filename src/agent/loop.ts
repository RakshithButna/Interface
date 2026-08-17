/**
 * The discovery loop: observe -> decide -> act, until the goal is met or a
 * stopping condition fires.
 *
 * This is the only place in the system where a model decides anything. It runs
 * once per capability, produces a transcript, and is then out of the picture
 * forever -- replay never comes back here.
 *
 * Three things this loop does that a naive version would not:
 *
 * 1. It records the OBSERVATION each decision was made from, not just the
 *    action taken. The recorder needs the node's role, name, form field and
 *    table row to build a durable descriptor, and that information only exists
 *    in the observation the model was looking at. Reconstructing it afterwards
 *    from the final page state does not work.
 *
 * 2. Secrets are never shown to the model. Credentials are referenced by
 *    placeholder (`{{secret:operatorPassword}}`) and substituted inside this
 *    loop, immediately before the value reaches the surface. The model's
 *    transcript, the run log, and the resulting artifact therefore contain the
 *    placeholder and never the value -- which is what makes "never persist
 *    secrets into artifacts or logs" true by construction rather than by
 *    discipline.
 *
 * 3. `done` is verified, not trusted. A model declaring success is a claim; the
 *    loop checks the claimed checkpoint text is actually on screen before
 *    accepting it. Models are quite willing to announce completion from the
 *    wrong page.
 */

import type { Surface, Observation, UiNode } from '../surface/types.ts';
import type { LlmProvider, LlmMessage, ToolCall } from './llm/provider.ts';
import type { Guard } from '../policy/guard.ts';
import type { ActionType } from '../policy/config.ts';
import type { Risk } from '../schema/artifact.ts';
import type { RunContext } from '../observability/run-context.ts';
import { AGENT_TOOLS } from './tools.ts';
import { renderObservation } from './render.ts';
import { classifyRisk } from '../policy/risk.ts';

export const SECRET_PATTERN = /^\{\{secret:([a-zA-Z_][a-zA-Z0-9_]*)\}\}$/;

export interface DiscoveryInput {
  goal: string;
  entryUrl: string;
  tenantId: string;
  /** Concrete parameter values for this run. Become typed inputs on the artifact. */
  params: Record<string, string>;
  /** Values the model may reference only by placeholder. Never sent to it. */
  secrets: Record<string, string>;
  maxSteps?: number;
}

export type ActionKind = 'navigate' | 'click' | 'fill' | 'select' | 'extract' | 'wait';

/**
 * One accepted action, paired with the state it was decided from. This is the
 * raw material the recorder turns into a `Step`.
 */
export interface RecordedAction {
  seq: number;
  kind: ActionKind;
  intent: string;
  risk: Risk;
  riskReason: string;
  /** The node acted upon, as it appeared in `observation`. */
  node?: UiNode;
  /** The observation the decision was made from. */
  observation: Observation;
  /** Literal value typed/selected, already secret-substituted OUT. */
  value?: string;
  /** Set when `value` was a secret placeholder; names the secret. */
  secretRef?: string;
  /** For extract actions. */
  outputName?: string;
  extractedValue?: string;
  urlBefore: string;
  urlAfter: string;
  /** State immediately after the action; used to synthesise checkpoints. */
  observationAfter: Observation;
}

export interface DiscoveryOutcome {
  status: 'succeeded' | 'stuck' | 'exhausted' | 'failed';
  goal: string;
  actions: RecordedAction[];
  outputs: Record<string, string>;
  summary?: string;
  /** Text the model nominated as proof of success; becomes the checkpoint. */
  checkpointText?: string;
  stuckReason?: string;
  stuckNeeds?: string;
  failureMessage?: string;
  finalObservation: Observation;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
}

export interface DiscoveryDeps {
  surface: Surface;
  provider: LlmProvider;
  guard: Guard;
  ctx: RunContext;
  /**
   * Called when policy requires a human decision before a risky step.
   * Returning false aborts the step. Supplied by the CLI, which prompts the
   * operator; this is the human-in-the-loop path during discovery.
   */
  approveRiskyStep: (info: { intent: string; label: string; reason: string }) => Promise<boolean>;
}

const SYSTEM_PROMPT = `You are operating a bank back-office web application on behalf of a service agent, in order to accomplish one specific task.

You perceive the screen as an accessibility-tree listing: a set of CONTROLS with refs, TABLES with rows, and PAGE TEXT. You act by calling tools with a control's ref.

Rules that matter:

- Only use refs that appear in the CURRENT observation. Refs change every turn. Never guess or reuse an old one.
- Work through the visible UI the way a human operator would. Do not try to shortcut the flow by constructing URLs.
- This application is laid out with frames and tables. A control's frame is shown; content is often inside a subframe.
- When a results grid has several rows, read the row values before choosing which one to act on. Rows often contain identically-labelled links.
- Some values are secrets. You will be told which secret placeholders exist. To enter one, pass the placeholder itself (for example "{{secret:operatorPassword}}") as the value. You will never be shown the real value and must not attempt to guess it.
- Call 'extract' for every value the goal asks you to read back. Extraction is how the task returns data.
- Call 'done' only when the screen actually shows the completed end state, and supply text visible on that screen that proves it.
- If you are blocked, confused, or would have to guess at something consequential, call 'stuck'. On a banking system, stopping is always better than guessing.

Everything you do is being recorded as a reusable automation that will later run without you. Prefer the stable, obvious path over a clever one.`;

/** Keep this many recent observations verbatim; older ones are elided. */
const OBSERVATION_WINDOW = 3;

export async function runDiscovery(input: DiscoveryInput, deps: DiscoveryDeps): Promise<DiscoveryOutcome> {
  const { surface, provider, guard, ctx } = deps;
  const maxSteps = input.maxSteps ?? guard.limits.maxDiscoverySteps;
  const deadline = Date.now() + guard.limits.maxDiscoveryMs;

  const actions: RecordedAction[] = [];
  const outputs: Record<string, string> = {};
  const messages: LlmMessage[] = [];
  let llmCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let seq = 0;

  // Register secrets with the redactor before anything can be logged.
  for (const [name, value] of Object.entries(input.secrets)) {
    ctx.redactor.register(name, value, 'secret');
  }

  ctx.log('discovery_started', {
    goal: input.goal,
    entryUrl: input.entryUrl,
    tenant: input.tenantId,
    params: input.params,
    secretNames: Object.keys(input.secrets),
    provider: provider.name,
    model: provider.model,
    maxSteps,
  });

  // Entry navigation is performed by us, not the model: the entry point is an
  // input to the run, and making the model rediscover it wastes a turn and
  // invites it to invent a URL.
  const entryDecision = guard.checkUrl(input.entryUrl);
  if (!entryDecision.allow) {
    const obs = await surface.observe();
    ctx.log('policy_blocked', { stage: 'entry', url: input.entryUrl, reason: entryDecision.reason });
    return fail(`Entry URL rejected by policy: ${entryDecision.reason}`, obs);
  }
  await surface.perform({ kind: 'navigate', url: input.entryUrl });
  await surface.settle(5_000);

  const paramBlock = Object.entries(input.params)
    .map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`)
    .join('\n');
  const secretBlock = Object.keys(input.secrets)
    .map((k) => `  {{secret:${k}}}`)
    .join('\n');

  messages.push({
    role: 'user',
    content: [
      `GOAL: ${input.goal}`,
      '',
      paramBlock ? `PARAMETER VALUES FOR THIS RUN:\n${paramBlock}` : 'PARAMETER VALUES FOR THIS RUN: (none)',
      '',
      secretBlock
        ? `SECRET PLACEHOLDERS AVAILABLE (pass the placeholder text as the value):\n${secretBlock}`
        : '',
      '',
      'Begin. The current screen follows.',
    ]
      .filter(Boolean)
      .join('\n'),
  });

  let observation = await surface.observe();

  for (let step = 1; step <= maxSteps; step++) {
    if (Date.now() > deadline) {
      ctx.log('discovery_timeout', { step });
      return {
        ...base('exhausted', observation),
        failureMessage: 'Discovery exceeded its time budget',
      };
    }
    if (llmCalls >= guard.limits.maxLlmCalls) {
      ctx.log('discovery_llm_budget_exhausted', { llmCalls });
      return { ...base('exhausted', observation), failureMessage: 'LLM call budget exhausted' };
    }

    const rendered = renderObservation(observation);
    messages.push({ role: 'user', content: rendered });
    trimObservations(messages);

    ctx.log('observation', {
      step,
      url: observation.url,
      httpStatus: observation.httpStatus,
      frames: observation.frames.length,
      interactiveNodes: observation.nodes.filter((n) => n.interactive).length,
    });

    let response;
    try {
      response = await provider.complete({ system: SYSTEM_PROMPT, messages, tools: AGENT_TOOLS });
    } catch (err) {
      ctx.log('llm_error', { step, message: (err as Error).message });
      return fail(`LLM call failed: ${(err as Error).message}`, observation);
    }
    llmCalls += 1;
    promptTokens += response.usage?.promptTokens ?? 0;
    completionTokens += response.usage?.completionTokens ?? 0;

    const call = response.toolCalls[0];
    ctx.log('llm_decision', {
      step,
      tool: call?.name ?? '(none)',
      args: call?.arguments ?? {},
      reasoning: response.text.slice(0, 400),
      finishReason: response.finishReason,
    });

    if (!call) {
      // No tool call: nudge once with an explicit instruction rather than
      // ending the run, since this is usually a formatting stumble.
      messages.push({ role: 'assistant', content: response.text });
      messages.push({
        role: 'user',
        content: 'You must respond with a tool call. Choose one of the available tools.',
      });
      continue;
    }

    messages.push({ role: 'assistant', content: response.text, toolCalls: [call] });

    const result = await handleCall(call);
    messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result.toolMessage });

    if (result.terminal) return result.terminal;
    observation = await surface.observe();
  }

  ctx.log('discovery_exhausted', { maxSteps });
  return { ...base('exhausted', observation), failureMessage: `Reached the ${maxSteps}-step limit` };

  /* ------------------------------------------------------------ handlers */

  async function handleCall(
    call: ToolCall,
  ): Promise<{ toolMessage: string; terminal?: DiscoveryOutcome }> {
    const args = call.arguments;
    const intent = String(args['intent'] ?? '').trim() || call.name;

    switch (call.name) {
      case 'done': {
        const checkpointText = String(args['checkpointText'] ?? '').trim();
        const summary = String(args['summary'] ?? '').trim();
        const fresh = await surface.observe();
        const pageText = fresh.frames.map((f) => f.text).join(' ');

        // Verify the claim before accepting it.
        if (checkpointText && !pageText.toLowerCase().includes(checkpointText.toLowerCase())) {
          ctx.log('done_rejected', { checkpointText, reason: 'checkpoint text not present on screen' });
          return {
            toolMessage:
              `Rejected: the text ${JSON.stringify(checkpointText)} does not appear on the current screen, ` +
              `so the goal cannot be confirmed complete. Look at the current observation and either continue ` +
              `working or call done with text that is actually visible.`,
          };
        }

        ctx.log('discovery_succeeded', { summary, checkpointText, outputs: Object.keys(outputs) });
        const outcome: DiscoveryOutcome = {
          ...base('succeeded', fresh),
          summary,
          checkpointText,
        };
        return { toolMessage: 'Goal accepted.', terminal: outcome };
      }

      case 'stuck': {
        const reason = String(args['reason'] ?? '').trim();
        const needs = String(args['whatIsNeeded'] ?? '').trim();
        ctx.log('discovery_stuck', { reason, needs });
        const fresh = await surface.observe();
        return {
          toolMessage: 'Escalating to a human operator.',
          terminal: { ...base('stuck', fresh), stuckReason: reason, stuckNeeds: needs },
        };
      }

      case 'wait': {
        const seconds = Math.min(10, Math.max(1, Number(args['seconds'] ?? 2)));
        ctx.log('agent_wait', { seconds, intent });
        await new Promise((r) => setTimeout(r, seconds * 1000));
        await surface.settle(seconds * 1000);
        return { toolMessage: `Waited ${seconds}s.` };
      }

      case 'navigate': {
        const url = String(args['url'] ?? '');
        const decision = guard.check({ actionType: 'navigate', risk: 'safe', url });
        if (!decision.allow) {
          ctx.log('policy_blocked', { tool: 'navigate', url, reason: decision.reason });
          return { toolMessage: `Blocked by policy: ${decision.reason}` };
        }
        const before = surface.currentUrl();
        const obsBefore = observation;
        try {
          await surface.perform({ kind: 'navigate', url });
          await surface.settle(8_000);
        } catch (err) {
          return { toolMessage: `Navigation failed: ${(err as Error).message}` };
        }
        // Re-check after the fact: an allowed URL can redirect somewhere
        // disallowed, and that is the case actually worth catching.
        const after = guard.checkUrl(surface.currentUrl());
        if (!after.allow) {
          ctx.log('policy_blocked', { stage: 'post_redirect', url: surface.currentUrl(), reason: after.reason });
          return {
            toolMessage: `Blocked: navigation redirected to a URL outside the allowlist (${after.reason})`,
            terminal: fail(`Redirect left the allowlist: ${after.reason}`, await surface.observe()),
          };
        }
        seq += 1;
        actions.push({
          seq,
          kind: 'navigate',
          intent,
          risk: 'safe',
          riskReason: 'navigation',
          observation: obsBefore,
          value: url,
          urlBefore: before,
          urlAfter: surface.currentUrl(),
          observationAfter: await surface.observe(),
        });
        ctx.log('action', { kind: 'navigate', url, intent });
        return { toolMessage: `Navigated. Now at ${surface.currentUrl()}` };
      }

      case 'click':
      case 'fill':
      case 'select':
      case 'extract':
        return handleNodeAction(call.name, args, intent);

      default:
        return { toolMessage: `Unknown tool '${call.name}'.` };
    }
  }

  async function handleNodeAction(
    kind: 'click' | 'fill' | 'select' | 'extract',
    args: Record<string, unknown>,
    intent: string,
  ): Promise<{ toolMessage: string; terminal?: DiscoveryOutcome }> {
    const ref = String(args['ref'] ?? '');
    const node = observation.nodes.find((n) => n.ref === ref);
    if (!node) {
      ctx.log('bad_ref', { kind, ref });
      return {
        toolMessage: `No control with ref '${ref}' exists in the current observation. Use a ref exactly as listed.`,
      };
    }

    const actionType: ActionType = kind === 'extract' ? 'extract' : kind;
    const { risk, reason } = classifyRisk({ actionType, node });
    const decision = guard.check({ actionType, risk, url: node.href });

    if (!decision.allow) {
      ctx.log('policy_blocked', { kind, ref, label: node.name, reason: decision.reason });
      return { toolMessage: `Blocked by policy: ${decision.reason}` };
    }

    if (decision.escalate) {
      ctx.log('human_approval_requested', { kind, ref, label: node.name, risk, reason: decision.reason });
      const approved = await deps.approveRiskyStep({
        intent,
        label: node.name || node.text || ref,
        reason: decision.reason,
      });
      ctx.log('human_approval_result', { approved, label: node.name });
      if (!approved) {
        return {
          toolMessage: 'A human operator declined this action. Do not retry it; choose another approach or call stuck.',
        };
      }
    }

    const before = surface.currentUrl();
    const obsBefore = observation;
    let value: string | undefined;
    let secretRef: string | undefined;
    let extractedValue: string | undefined;
    let outputName: string | undefined;

    try {
      switch (kind) {
        case 'click':
          await surface.perform({ kind: 'click', ref });
          break;
        case 'fill': {
          const raw = String(args['value'] ?? '');
          const sub = substituteSecret(raw, input.secrets);
          value = sub.recordValue;
          if (sub.secretName) secretRef = sub.secretName;
          await surface.perform({ kind: 'fill', ref, value: sub.actualValue, clearFirst: true });
          break;
        }
        case 'select':
          value = String(args['value'] ?? '');
          await surface.perform({ kind: 'select', ref, value });
          break;
        case 'extract': {
          outputName = String(args['name'] ?? '').trim();
          if (!outputName) return { toolMessage: 'extract requires a name for the output.' };
          const read = await surface.read(ref, 'text');
          extractedValue = (read ?? '').trim();
          outputs[outputName] = extractedValue;
          break;
        }
      }
    } catch (err) {
      ctx.log('action_error', { kind, ref, message: (err as Error).message });
      return { toolMessage: `Action failed: ${(err as Error).message}` };
    }

    if (kind !== 'extract') await surface.settle(8_000);

    const postUrl = surface.currentUrl();
    if (postUrl !== before) {
      const after = guard.checkUrl(postUrl);
      if (!after.allow) {
        ctx.log('policy_blocked', { stage: 'post_click', url: postUrl, reason: after.reason });
        return {
          toolMessage: `Blocked: that action navigated outside the allowlist.`,
          terminal: fail(`Action left the allowlist: ${after.reason}`, await surface.observe()),
        };
      }
    }

    seq += 1;
    const observationAfter = await surface.observe();
    const action: RecordedAction = {
      seq,
      kind,
      intent,
      risk,
      riskReason: reason,
      node,
      observation: obsBefore,
      urlBefore: before,
      urlAfter: postUrl,
      observationAfter,
    };
    if (value !== undefined) action.value = value;
    if (secretRef !== undefined) action.secretRef = secretRef;
    if (outputName !== undefined) action.outputName = outputName;
    if (extractedValue !== undefined) action.extractedValue = extractedValue;
    actions.push(action);

    ctx.log('action', {
      kind,
      ref,
      control: node.name || node.text,
      risk,
      intent,
      value,
      outputName,
      extractedValue,
      url: postUrl,
    });

    if (kind === 'extract') {
      return { toolMessage: `Recorded output ${outputName} = ${JSON.stringify(extractedValue)}` };
    }
    return { toolMessage: `Done. Now at ${postUrl}` };
  }

  /* ------------------------------------------------------------ helpers */

  function base(status: DiscoveryOutcome['status'], obs: Observation): DiscoveryOutcome {
    return {
      status,
      goal: input.goal,
      actions,
      outputs,
      finalObservation: obs,
      llmCalls,
      promptTokens,
      completionTokens,
    };
  }

  function fail(message: string, obs: Observation): DiscoveryOutcome {
    return { ...base('failed', obs), failureMessage: message };
  }
}

/**
 * Replace a secret placeholder with its value for execution, while keeping the
 * placeholder as the thing we record. If the model passed a literal instead of
 * a placeholder, we pass it through unchanged -- but the redactor has already
 * registered every secret value, so a leaked credential would still be masked
 * in the logs.
 */
export function substituteSecret(
  raw: string,
  secrets: Record<string, string>,
): { actualValue: string; recordValue: string; secretName?: string } {
  const m = SECRET_PATTERN.exec(raw.trim());
  if (!m) return { actualValue: raw, recordValue: raw };
  const name = m[1]!;
  const actual = secrets[name];
  if (actual === undefined) return { actualValue: raw, recordValue: raw };
  return { actualValue: actual, recordValue: raw.trim(), secretName: name };
}

/**
 * Keep the prompt affordable by eliding all but the most recent observations.
 * The model needs the CURRENT screen in detail; older screens only need to be
 * remembered as "there was a page here", since the tool results in between
 * already carry what happened.
 */
function trimObservations(messages: LlmMessage[]): void {
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'user' && m.content.startsWith('URL: ')) indices.push(i);
  }
  const toElide = indices.slice(0, Math.max(0, indices.length - OBSERVATION_WINDOW));
  for (const i of toElide) {
    const m = messages[i]!;
    if (m.role === 'user' && m.content.length > 120) {
      const firstLine = m.content.split('\n', 1)[0] ?? '';
      messages[i] = { role: 'user', content: `${firstLine}\n(earlier screen omitted)` };
    }
  }
}
