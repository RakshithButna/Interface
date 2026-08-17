/**
 * The capability artifact: what a successful discovery run turns into, and the
 * only thing production replay ever reads.
 *
 * The framing that shaped this schema comes straight from the brief: the
 * artifact is "a capability an AI agent can call -- so it needs a clear
 * contract, not just a step list." So the schema is organised as a contract
 * first (inputs, outputs, declared outcomes, success condition) and an
 * implementation second (steps). A calling agent should be able to decide
 * whether to invoke this capability by reading only the contract half, and
 * never needing to look at the steps.
 *
 * Four decisions worth calling out, because they are the ones I would defend:
 *
 * 1. Declared business outcomes are part of the CONTRACT, not error handling.
 *    "No such member" is a legitimate answer the caller needs, and the brief
 *    names conflating it with failure as "the most common design mistake here."
 *    So outcomes are enumerated up front, alongside outputs, and the replay
 *    result type makes them a distinct status rather than an exception.
 *
 * 2. The artifact is decoupled from the model transcript. Nothing here stores
 *    prompts, completions, or model reasoning. Provenance carries a pointer to
 *    the run that produced it, and that is all. The transcript is evidence; the
 *    artifact is a contract, and mixing them makes the contract unreviewable.
 *
 * 3. Tenant specialization is data, not a fork. One artifact holds a base
 *    recording plus a map of per-tenant overrides. Hundreds of institutions
 *    running the same vendor product must not mean hundreds of recordings.
 *
 * 4. Steps carry their own risk class. Safety is not a wrapper around the
 *    executor; it is a property of each recorded step, so a reviewer reading
 *    the artifact can see exactly which steps can move money before approving
 *    it for unattended use.
 */

import { z } from 'zod';
import { TargetDescriptorSchema, ValueExprSchema, FramePathSchema } from './targeting.ts';
import { AssertionSchema } from './assertions.ts';

export const SCHEMA_VERSION = '1.0.0';

/* --------------------------------------------------------- typed contract */

/**
 * Sensitivity drives redaction everywhere: logs, evidence, artifacts.
 * `secret` values are never written anywhere, ever. `pii` values are masked in
 * logs but may be passed to the surface at runtime. This classification is on
 * the PARAMETER, not on the log call, so a developer cannot forget to redact.
 */
export const SensitivitySchema = z.enum(['none', 'internal', 'pii', 'secret']);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

export const ParamSpecSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: z.enum(['string', 'number', 'boolean', 'enum']),
  /** Allowed values when type is 'enum'. */
  enumValues: z.array(z.string()).optional(),
  required: z.boolean().default(true),
  description: z.string(),
  /** Regex the value must satisfy. Cheap input validation before we touch the UI. */
  pattern: z.string().optional(),
  /** Non-sensitive example, safe to show in a capability catalogue. */
  example: z.string().optional(),
  default: z.string().optional(),
  sensitivity: SensitivitySchema.default('none'),
});
export type ParamSpec = z.infer<typeof ParamSpecSchema>;

export const OutputSpecSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: z.enum(['string', 'number', 'boolean', 'money']),
  description: z.string(),
  /** The step whose `extract` action produces this value. */
  producedByStep: z.string(),
  required: z.boolean().default(true),
  sensitivity: SensitivitySchema.default('none'),
});
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

/**
 * A business outcome the caller must be able to handle. Enumerated here so the
 * calling agent knows the full set of non-success answers in advance, the same
 * way a typed error union would in a normal API.
 */
export const OutcomeSpecSchema = z.object({
  /** SCREAMING_SNAKE, stable across versions. Part of the public contract. */
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  description: z.string(),
  /**
   * Whether the caller can fix this by changing inputs (`retryable`), or the
   * answer is simply final (`terminal`).
   */
  disposition: z.enum(['terminal', 'retryable']).default('terminal'),
});
export type OutcomeSpec = z.infer<typeof OutcomeSpecSchema>;

/* ------------------------------------------------------------------ risk */

/**
 * Risk is per-step and drives policy at the act() chokepoint.
 *
 *   safe          Read-only or trivially reversible. Navigation, reads, typing
 *                 into a field that has not been submitted.
 *   stateChanging Writes something the institution can see, but reversible by
 *                 an operator. Saving a note, updating a nickname.
 *   irreversible  Moves money, opens or closes accounts, sends notices to a
 *                 member. Cannot be undone from inside the UI.
 *
 * The default policy blocks `irreversible` steps in unattended replay and
 * routes them to a human. That is the conservative choice the brief asks for,
 * and it is justified in REPORT.md section 6: the cost of a wrongly-opened
 * account at a credit union is a compliance event, while the cost of a paused
 * run is a few minutes of operator time.
 */
export const RiskSchema = z.enum(['safe', 'stateChanging', 'irreversible']);
export type Risk = z.infer<typeof RiskSchema>;

/* ---------------------------------------------------------------- actions */

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), url: ValueExprSchema }),
  z.object({ type: z.literal('click'), target: TargetDescriptorSchema }),
  z.object({
    type: z.literal('fill'),
    target: TargetDescriptorSchema,
    value: ValueExprSchema,
    /** Clear the field first. Legacy forms often prefill. */
    clearFirst: z.boolean().default(true),
  }),
  z.object({ type: z.literal('select'), target: TargetDescriptorSchema, value: ValueExprSchema }),
  z.object({ type: z.literal('press'), key: z.string(), target: TargetDescriptorSchema.optional() }),
  z.object({ type: z.literal('waitFor'), assertion: AssertionSchema, timeoutMs: z.number().int().default(10_000) }),
  z.object({
    type: z.literal('extract'),
    target: TargetDescriptorSchema,
    /** Name of the output this produces. */
    into: z.string(),
    /** What to read off the element. */
    from: z.enum(['text', 'value', 'href', 'attribute']).default('text'),
    attribute: z.string().optional(),
    /**
     * Optional post-processing. Regex with one capture group, applied to the
     * raw text. Legacy grids render "$4,281.37" and the caller wants a number.
     */
    extractPattern: z.string().optional(),
    transform: z.enum(['none', 'trim', 'moneyToNumber', 'digitsOnly']).default('trim'),
  }),
  z.object({ type: z.literal('assert'), assertion: AssertionSchema }),
]);
export type Action = z.infer<typeof ActionSchema>;

/* --------------------------------------------------- outcomes & recovery */

export const OutcomeRuleSchema = z.object({
  /** Must match a code declared in the artifact's `outcomes`. */
  outcome: z.string(),
  when: AssertionSchema,
  /** Human-facing message template; may interpolate params. */
  message: z.string().optional(),
});
export type OutcomeRule = z.infer<typeof OutcomeRuleSchema>;

/**
 * A recoverable condition and what to do about it.
 *
 * Recoveries are bounded by construction: `maxAttempts` is required and the
 * engine counts attempts per rule per run. An unbounded retry loop against a
 * banking UI is not a recovery strategy, it is an incident.
 */
export const RecoveryRuleSchema = z.object({
  id: z.string(),
  description: z.string(),
  when: AssertionSchema,
  then: z.discriminatedUnion('type', [
    z.object({ type: z.literal('click'), target: TargetDescriptorSchema }),
    z.object({ type: z.literal('wait'), ms: z.number().int().positive() }),
    z.object({ type: z.literal('reload') }),
    /** Re-run the artifact's login preamble on the same session, then resume. */
    z.object({ type: z.literal('reauthenticate') }),
    /** Give up automatically and hand to a human. */
    z.object({ type: z.literal('escalate'), reason: z.string() }),
  ]),
  maxAttempts: z.number().int().positive().default(2),
  /** Apply before every step (`global`) or only at the step that declares it. */
  applies: z.enum(['global', 'step']).default('step'),
});
export type RecoveryRule = z.infer<typeof RecoveryRuleSchema>;

/* ------------------------------------------------------------------ step */

export const StepSchema = z.object({
  id: z.string(),
  /**
   * What this step is trying to achieve, in plain language. Written by the
   * recorder from the model's own stated intent. This is what a human reviewer
   * reads; it is documentation, never executed.
   */
  intent: z.string(),
  action: ActionSchema,
  risk: RiskSchema.default('safe'),
  /** Asserted after the action. Failing it is a hard failure by default. */
  checkpoint: AssertionSchema.optional(),
  /** Checked BEFORE the checkpoint: a matching outcome ends the run cleanly. */
  outcomeRules: z.array(OutcomeRuleSchema).default([]),
  /** Step-local recoveries, tried before the step is declared failed. */
  recoveries: z.array(RecoveryRuleSchema).default([]),
  timeoutMs: z.number().int().positive().default(15_000),
  /**
   * A step that may legitimately not apply on some tenants or some runs
   * (a conditional interstitial, an optional field). Skipped without error if
   * its target cannot be found.
   */
  optional: z.boolean().default(false),
});
export type Step = z.infer<typeof StepSchema>;

/* -------------------------------------------------------- tenant overrides */

/**
 * How one recording serves many institutions.
 *
 * The base recording is made against one tenant. Everything that differs on
 * another tenant running the same vendor product is expressed as data here,
 * so the steps are never duplicated. In practice the differences are almost
 * always one of three kinds -- they renamed a field, they changed a route
 * slug, or they added/removed a screen -- so those three get first-class
 * support and anything else falls through to explicit step patches.
 */
export const TenantOverrideSchema = z.object({
  tenantId: z.string(),
  note: z.string().optional(),
  baseUrl: z.string().optional(),
  /**
   * Base label -> this tenant's label. Applied when resolving any strategy or
   * scope that references human-visible text ("Member ID" -> "Membership
   * Number"). This single map absorbs the majority of cross-tenant drift.
   */
  labelAliases: z.record(z.string(), z.string()).default({}),
  /** Base route segment -> this tenant's segment ("member-search" -> "members/find"). */
  routeAliases: z.record(z.string(), z.string()).default({}),
  /** Steps that do not apply to this tenant. */
  disableSteps: z.array(z.string()).default([]),
  /** Extra steps this tenant needs, positioned relative to a base step id. */
  insertSteps: z
    .array(
      z.object({
        before: z.string().describe("a base step id, or '$end'"),
        step: StepSchema,
      }),
    )
    .default([]),
  /** Additional recoveries only this tenant needs. */
  extraRecoveries: z.array(RecoveryRuleSchema).default([]),
});
export type TenantOverride = z.infer<typeof TenantOverrideSchema>;

/* -------------------------------------------------- provenance & stability */

export const ProvenanceSchema = z.object({
  /** The discovery run that produced this artifact. Points at /evidence/. */
  discoveryRunId: z.string(),
  recordedAt: z.string(),
  /** Model that drove discovery. Recorded for auditability, not for replay. */
  model: z.string(),
  provider: z.string(),
  /** The natural-language goal the operator originally asked for. */
  goal: z.string(),
  /** Tenant the base recording was made against. */
  recordedOnTenant: z.string(),
  /** Relative path to the run's evidence directory. */
  evidencePath: z.string().optional(),
  /** Notes from the recorder about what it parameterized and why. */
  canonicalizationNotes: z.array(z.string()).default([]),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/**
 * Replay statistics, updated by the replay engine.
 *
 * This exists to answer one question a human approver actually asks: "has this
 * thing worked reliably enough that I am willing to let it run unattended?"
 * Deliberately just counters -- a flake rate over recent runs is decision-grade
 * information; a fancier confidence model would not change the decision.
 */
export const StabilitySchema = z.object({
  replays: z.number().int().nonnegative().default(0),
  successes: z.number().int().nonnegative().default(0),
  businessOutcomes: z.number().int().nonnegative().default(0),
  failures: z.number().int().nonnegative().default(0),
  escalations: z.number().int().nonnegative().default(0),
  lastReplayAt: z.string().optional(),
  /** Steps that have ever resolved via a weaker strategy than at record time. */
  driftingSteps: z.array(z.string()).default([]),
});
export type Stability = z.infer<typeof StabilitySchema>;

/* -------------------------------------------------------------- artifact */

export const CapabilityArtifactSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),

  /* --- identity -------------------------------------------------------- */
  /** Dotted, stable, agent-facing name: 'member.open_sub_account'. */
  name: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  title: z.string(),
  /** What this capability does, written for a calling agent to read. */
  description: z.string(),

  /**
   * Approval state. `draft` capabilities may be replayed interactively but are
   * refused for unattended invocation -- see the gate in the replay entrypoint.
   * The point is that a real LLM-discovered flow should not go straight to
   * production without a person looking at it.
   */
  status: z.enum(['draft', 'approved', 'deprecated']).default('draft'),

  /* --- what it runs against -------------------------------------------- */
  app: z.object({
    /** The vendor product, NOT the institution. Shared across tenants. */
    productId: z.string(),
    productVersion: z.string().optional(),
    surface: z.enum(['web', 'desktop']).default('web'),
    /** Base URL of the tenant this was recorded against. */
    baseUrl: z.string(),
  }),

  /* --- the contract ---------------------------------------------------- */
  inputs: z.array(ParamSpecSchema).default([]),
  outputs: z.array(OutputSpecSchema).default([]),
  outcomes: z.array(OutcomeSpecSchema).default([]),

  /* --- the implementation ---------------------------------------------- */
  steps: z.array(StepSchema).min(1),
  /** Asserted once at the end. The definition of "this capability succeeded." */
  successCheckpoint: AssertionSchema,
  /**
   * Outcome detectors evaluated before EVERY step, in addition to any a step
   * declares for itself.
   *
   * These are global because a happy-path discovery run cannot possibly
   * discover them: the model never saw the "record not found" screen, so
   * nothing in its transcript describes one. The exceptional-state vocabulary
   * of a vendor product is instead authored once per product (see
   * config/outcomes/) and attached at record time, which is also why it is
   * correct for it to be global -- these screens can appear at any point in
   * any flow in that product.
   */
  outcomeRules: z.array(OutcomeRuleSchema).default([]),
  /** Recoveries with `applies: 'global'` run before every step. */
  recoveries: z.array(RecoveryRuleSchema).default([]),
  /**
   * Steps that establish the session, in order. A `reauthenticate` recovery
   * re-runs exactly these after a session timeout, then resumes where it left
   * off. Making this explicit in the artifact (rather than inferring it at
   * replay time) means a reviewer can see precisely what will be re-executed
   * when a session expires mid-flow.
   */
  authPreambleStepIds: z.array(z.string()).default([]),

  /* --- reuse ----------------------------------------------------------- */
  overrides: z.array(TenantOverrideSchema).default([]),

  /* --- metadata -------------------------------------------------------- */
  provenance: ProvenanceSchema,
  stability: StabilitySchema.prefault({}),
});

export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;

/* ------------------------------------------------------------- utilities */

export function parseArtifact(raw: unknown): CapabilityArtifact {
  return CapabilityArtifactSchema.parse(raw);
}

/** Full identifier used in the catalogue and in logs: `name@version`. */
export function artifactRef(a: Pick<CapabilityArtifact, 'name' | 'version'>): string {
  return `${a.name}@${a.version}`;
}

export function findOverride(a: CapabilityArtifact, tenantId: string | undefined): TenantOverride | undefined {
  if (!tenantId) return undefined;
  return a.overrides.find((o) => o.tenantId === tenantId);
}

/**
 * JSON Schema for a capability's input parameters, in the shape a
 * function-calling model expects. This is what makes a saved artifact directly
 * invocable by an AI agent -- the whole point of calling it a capability.
 */
export function inputsToJsonSchema(a: CapabilityArtifact): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const p of a.inputs) {
    const prop: Record<string, unknown> = {
      type: p.type === 'enum' ? 'string' : p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string',
      description: p.description,
    };
    if (p.type === 'enum' && p.enumValues) prop['enum'] = p.enumValues;
    if (p.pattern) prop['pattern'] = p.pattern;
    // Examples are only surfaced for non-sensitive params, so a catalogue
    // listing can never become a place sample PII accumulates.
    if (p.example && p.sensitivity === 'none') prop['examples'] = [p.example];
    properties[p.name] = prop;
    if (p.required) required.push(p.name);
  }

  return { type: 'object', properties, required, additionalProperties: false };
}
