/**
 * The replay result contract -- what an AI agent actually receives when it
 * invokes a capability.
 *
 * The brief is emphatic that conflating a legitimate business answer with a
 * crash is "the most common design mistake here." So the top-level type is a
 * four-way discriminated union, and the distinction is structural rather than
 * conventional: a caller cannot accidentally treat MEMBER_NOT_FOUND as an
 * exception, because it does not arrive as one.
 *
 *   success    The flow completed and the success checkpoint held.
 *              `outputs` is populated and typed per the artifact contract.
 *
 *   outcome    A declared business outcome. The automation worked perfectly;
 *              the ANSWER is "no such member" / "permission denied". The
 *              caller needs this and should not retry blindly.
 *
 *   escalated  The system stopped on purpose and handed to a human, either
 *              because it got stuck or because policy requires a person for a
 *              risky step. Carries the intervention id so the caller can wait
 *              on it or poll it.
 *
 *   failed     Something genuinely went wrong. Carries enough structure to
 *              debug without re-running: which step, what was expected, what
 *              was observed, and pointers to captured evidence.
 *
 * Recoverable conditions -- the third category the brief asks us to separate --
 * deliberately do NOT appear at the top level. A condition that was
 * successfully recovered from did not change the outcome of the run; it is
 * reported as a `warnings` entry and in the per-step report. A condition that
 * could not be recovered from becomes `failed` with RECOVERY_EXHAUSTED. Making
 * recovery a top-level status would force callers to handle a case that, by
 * definition, resolved itself.
 */

import type { Risk } from './artifact.ts';

/* ------------------------------------------------------------ error codes */

/**
 * Hard-failure taxonomy. Each code answers "what would I do about this?"
 * differently, which is the test for whether a code earns its place.
 */
export const ERROR_CODES = [
  /** No strategy in the ladder matched. The UI is not what we recorded. */
  'TARGET_NOT_FOUND',
  /** A strategy matched several elements and uniqueness was required.
   *  Treated as a failure rather than "take the first" ON PURPOSE. */
  'TARGET_AMBIGUOUS',
  /** The action ran but the state we asserted afterwards did not hold. */
  'CHECKPOINT_FAILED',
  /** The final success condition did not hold at the end of the run. */
  'SUCCESS_CHECKPOINT_FAILED',
  /** A step or the run exceeded its time budget. */
  'TIMEOUT',
  /** A known recoverable condition kept recurring past maxAttempts. */
  'RECOVERY_EXHAUSTED',
  /** The guardrail layer refused the action (allowlist, risk policy). */
  'POLICY_VIOLATION',
  /** Inputs did not satisfy the artifact's declared parameter contract. */
  'INPUT_VALIDATION_FAILED',
  /** A declared output could not be read or failed its type conversion. */
  'OUTPUT_EXTRACTION_FAILED',
  /** Unattended invocation of a capability that is not approved. */
  'NOT_APPROVED',
  /** The surface itself errored: browser crash, navigation failure, app 500. */
  'SURFACE_ERROR',
  /** Human declined to continue during an escalation. */
  'HUMAN_ABORTED',
  /** Anything genuinely unclassified. Should be rare; investigate if not. */
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/* --------------------------------------------------------------- reports */

export interface EvidenceRefs {
  screenshotPath?: string;
  domSnapshotPath?: string;
  a11ySnapshotPath?: string;
  runLogPath?: string;
}

export interface StepReport {
  stepId: string;
  intent: string;
  status: 'ok' | 'skipped' | 'recovered' | 'failed';
  risk: Risk;
  durationMs: number;
  /** Which rung of the targeting ladder actually resolved the element. */
  resolvedBy?: string;
  /** Rank of that rung. Higher than recorded rank means drift. */
  resolvedRank?: number;
  /** Recoveries applied during this step, if any. */
  recoveriesApplied?: string[];
  note?: string;
}

export interface Warning {
  code: 'LOCATOR_DRIFT' | 'RECOVERY_APPLIED' | 'SLOW_STEP' | 'OPTIONAL_STEP_SKIPPED' | 'TENANT_OVERRIDE_APPLIED';
  stepId?: string;
  message: string;
}

export interface ReplayError {
  code: ErrorCode;
  message: string;
  stepId?: string;
  /** What the engine required to be true. */
  expected?: string;
  /** What it actually saw. Redacted before it is written anywhere. */
  observed?: string;
  evidence?: EvidenceRefs;
}

/* ---------------------------------------------------------------- result */

interface ResultBase {
  runId: string;
  capability: string;
  capabilityVersion: string;
  tenantId: string;
  startedAt: string;
  durationMs: number;
  steps: StepReport[];
  warnings: Warning[];
  evidence: EvidenceRefs;
}

export interface ReplaySuccess extends ResultBase {
  status: 'success';
  outputs: Record<string, string | number | boolean>;
}

export interface ReplayOutcome extends ResultBase {
  status: 'outcome';
  /** A code declared in the artifact's `outcomes` list. */
  outcome: string;
  message: string;
  disposition: 'terminal' | 'retryable';
  /** Outputs the flow managed to collect before reaching the outcome. */
  partialOutputs: Record<string, string | number | boolean>;
}

export interface ReplayEscalated extends ResultBase {
  status: 'escalated';
  interventionId: string;
  reason: string;
  /** Whether the run can continue once a human hands control back. */
  resumable: boolean;
}

export interface ReplayFailed extends ResultBase {
  status: 'failed';
  error: ReplayError;
  partialOutputs: Record<string, string | number | boolean>;
}

export type ReplayResult = ReplaySuccess | ReplayOutcome | ReplayEscalated | ReplayFailed;

/* ------------------------------------------------------------- narrowing */

export function isSuccess(r: ReplayResult): r is ReplaySuccess {
  return r.status === 'success';
}

/**
 * True when the run reached a definite answer -- either it worked or the
 * business said no. Both are "the system did its job"; neither warrants a
 * retry or an alert. This is the predicate most callers actually want.
 */
export function isConclusive(r: ReplayResult): r is ReplaySuccess | ReplayOutcome {
  return r.status === 'success' || r.status === 'outcome';
}

/** One-line summary for CLI output and logs. */
export function summarize(r: ReplayResult): string {
  switch (r.status) {
    case 'success':
      return `SUCCESS  ${r.capability}@${r.capabilityVersion}  outputs=${JSON.stringify(r.outputs)}`;
    case 'outcome':
      return `OUTCOME  ${r.capability}@${r.capabilityVersion}  ${r.outcome}: ${r.message}`;
    case 'escalated':
      return `ESCALATED ${r.capability}@${r.capabilityVersion}  intervention=${r.interventionId} (${r.reason})`;
    case 'failed':
      return `FAILED   ${r.capability}@${r.capabilityVersion}  ${r.error.code} at step '${r.error.stepId ?? '-'}': ${r.error.message}`;
  }
}

/** Process exit code, so the CLI is usable in a script or CI check. */
export function exitCodeFor(r: ReplayResult): number {
  switch (r.status) {
    case 'success':
      return 0;
    case 'outcome':
      return 0; // A business outcome is a successful invocation.
    case 'escalated':
      return 2;
    case 'failed':
      return 1;
  }
}
