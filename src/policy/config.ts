/**
 * Guardrail configuration.
 *
 * Policy is data, loaded from `config/policy.json`, not code. That matters for
 * the environment the brief describes: a compliance officer at an institution
 * has to be able to read what the automation is permitted to do, and change it,
 * without a deploy. Anything expressible only in TypeScript is effectively
 * invisible to the people accountable for it.
 */

import { z } from 'zod';

export const ActionTypeSchema = z.enum([
  'navigate',
  'click',
  'fill',
  'select',
  'press',
  'waitFor',
  'extract',
  'assert',
]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

/**
 * What to do when a step of a given risk class is encountered.
 *
 *   allow     Proceed.
 *   escalate  Pause and hand to a human, who approves or aborts. The run can
 *             continue afterwards on the same session.
 *   block     Refuse outright and fail the run with POLICY_VIOLATION.
 */
export const RiskDispositionSchema = z.enum(['allow', 'escalate', 'block']);
export type RiskDisposition = z.infer<typeof RiskDispositionSchema>;

export const PolicyConfigSchema = z.object({
  allowlist: z.object({
    /**
     * Origins the automation may touch. Everything else is refused at the
     * navigation chokepoint -- including redirects, which is the case that
     * actually matters: a legacy app bouncing you to an SSO host is how
     * automation ends up typing credentials somewhere unexpected.
     */
    origins: z.array(z.string()).min(1),
    /** Glob patterns (`*` within a segment, `**` across). Empty = all paths. */
    pathPatterns: z.array(z.string()).default([]),
    /** Checked first; a match here denies regardless of pathPatterns. */
    deniedPathPatterns: z.array(z.string()).default([]),
    /** Action types the agent may perform at all. */
    actions: z.array(ActionTypeSchema),
  }),

  risk: z.object({
    /** Replay invoked by an agent with no human watching. Conservative. */
    unattended: z.record(z.string(), RiskDispositionSchema),
    /** Discovery, or a replay a human is supervising. */
    attended: z.record(z.string(), RiskDispositionSchema),
  }),

  redaction: z.object({
    /** Named regexes applied to every string written to logs or evidence. */
    patterns: z
      .array(
        z.object({
          name: z.string(),
          regex: z.string(),
          flags: z.string().default('g'),
          replacement: z.string(),
        }),
      )
      .default([]),
    /**
     * When true, values bound to `pii` parameters keep their last 4 characters
     * in logs. Keeps runs debuggable; the alternative is logs where every
     * member ID is identical and no failure can be traced to a record.
     */
    keepLast4ForPii: z.boolean().default(true),
  }),

  limits: z.object({
    /** Discovery: hard stop on the observe -> decide -> act loop. */
    maxDiscoverySteps: z.number().int().positive().default(30),
    maxDiscoveryMs: z.number().int().positive().default(300_000),
    maxLlmCalls: z.number().int().positive().default(40),
    /** Replay: whole-run budget, independent of per-step timeouts. */
    maxReplayMs: z.number().int().positive().default(120_000),
  }),

  /**
   * Unattended replay of a capability that no human has approved is refused.
   * The discovery run is LLM-authored; letting it reach production without a
   * review step would make the guardrails theatre.
   */
  requireApprovalForUnattended: z.boolean().default(true),
});

export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

export const DEFAULT_POLICY: PolicyConfig = PolicyConfigSchema.parse({
  allowlist: {
    origins: ['http://127.0.0.1:4173'],
    pathPatterns: ['/t/**'],
    deniedPathPatterns: ['/_control/**'],
    actions: ['navigate', 'click', 'fill', 'select', 'press', 'waitFor', 'extract', 'assert'],
  },
  risk: {
    unattended: { safe: 'allow', stateChanging: 'allow', irreversible: 'escalate' },
    attended: { safe: 'allow', stateChanging: 'allow', irreversible: 'escalate' },
  },
  redaction: {
    patterns: [
      { name: 'ssn', regex: '\\b\\d{3}-\\d{2}-\\d{4}\\b', flags: 'g', replacement: '[REDACTED:ssn]' },
      {
        name: 'card',
        regex: '\\b(?:\\d[ -]?){13,19}\\b',
        flags: 'g',
        replacement: '[REDACTED:card]',
      },
      {
        name: 'authHeader',
        regex: '(authorization|bearer|api[-_]?key)\\s*[:=]\\s*\\S+',
        flags: 'gi',
        replacement: '$1=[REDACTED]',
      },
    ],
    keepLast4ForPii: true,
  },
  limits: {},
  requireApprovalForUnattended: true,
});
