/**
 * How a recorded step says "this control, right here" -- the single most
 * load-bearing decision in the whole system, because it determines whether a
 * capability recorded today still works next quarter, and whether it works at
 * all on a different tenant's install of the same product.
 *
 * The model here has three parts, and keeping them separate is the point:
 *
 *   frame     WHERE to look   -- which document, traversing framesets/iframes
 *   scope     WHICH REGION    -- e.g. "the row whose Member ID cell is 12345"
 *   strategies HOW to match   -- a ranked ladder, first unique match wins
 *
 * Older designs collapse these into one selector string. That fails badly on
 * legacy tables, where every row contains an identical "View" link: no
 * selector distinguishes them, but a *scope* does. Separating scope from
 * strategy is what makes row-repeated controls addressable at all.
 *
 * The strategy ladder is ordered by a single principle:
 *
 *   Prefer the identifier the application itself depends on, then the one a
 *   human operator depends on, then raw structure.
 *
 * Which yields, highest confidence first:
 *
 *   test_id     An explicit automation contract. Legacy apps never have these,
 *               but when present nothing beats them.
 *   form_field  The `name` attribute of a form control. On server-rendered
 *               legacy apps this is a contract WITH THE SERVER -- renaming it
 *               breaks form submission -- so it is far more stable than any
 *               visible label. Deliberately ranked above accessible name for
 *               inputs. It does not port to desktop surfaces, which is why it
 *               is not ranked first overall.
 *   role_name   Accessible role + accessible name. What a screen reader (and
 *               therefore a human) depends on. This is the ladder's backbone
 *               because it is the one rung that exists on BOTH web and desktop
 *               accessibility trees -- see REPORT.md section 4.
 *   label       Visible labelling, including labels inferred from an adjacent
 *               table cell (the legacy pattern where there is no <label for>).
 *               Survives markup churn; breaks when a tenant relabels a field,
 *               which is exactly what per-tenant label aliases exist to absorb.
 *   text        Visible text content. Weak but often all that is available.
 *   structural  CSS or XPath. Recorded for diagnostics and used only as a last
 *               resort, because it is the rung most likely to silently match
 *               the WRONG element after a layout change.
 *
 * Every strategy that matches is recorded at replay time, not just the winner.
 * If a lower-ranked rung wins on replay than won at record time, that is a
 * drift signal worth surfacing even though the step succeeded.
 */

import { z } from 'zod';

/* --------------------------------------------------------------- values */

/**
 * A value in a recorded step is rarely a constant. It is usually the input
 * parameter the calling agent supplied, or something read earlier in the run.
 * Keeping this an explicit expression type (rather than string interpolation)
 * is what lets the recorder turn a concrete discovery run into a parameterized
 * capability, and what lets the redactor know which values are sensitive.
 */
export const ValueExprSchema = z.union([
  z.object({ literal: z.string() }),
  z.object({ param: z.string() }),
  /** Reference to a value extracted by an earlier step. */
  z.object({ fromOutput: z.string() }),
  /** e.g. "${memberId}-00"; interpolates params and prior outputs. */
  z.object({ template: z.string() }),
]);
export type ValueExpr = z.infer<typeof ValueExprSchema>;

/* ---------------------------------------------------------------- frames */

/**
 * A path from the top-level document down to the document containing the
 * control. Frame *name* is preferred over index because legacy apps name their
 * frames (that is how their own links target them via `target="mainFrame"`),
 * and names survive reordering while indices do not.
 */
export const FrameRefSchema = z.union([
  z.object({ by: z.literal('name'), name: z.string() }),
  z.object({ by: z.literal('urlPattern'), pattern: z.string() }),
  z.object({ by: z.literal('index'), index: z.number().int().nonnegative() }),
]);
export type FrameRef = z.infer<typeof FrameRefSchema>;

export const FramePathSchema = z.array(FrameRefSchema).default([]);
export type FramePath = z.infer<typeof FramePathSchema>;

/* ----------------------------------------------------------------- scope */

/**
 * Narrows the search region before any strategy runs.
 *
 * `tableRow` is the one that earns its place: in a results grid, the control
 * you want ("View", "Open", a checkbox) is identical in every row. You cannot
 * identify it by what it *is*; you identify it by which row it is *in*, and
 * you identify the row by a business value -- the member ID, the account
 * number -- which is usually a capability input parameter.
 */
export const ScopeSchema = z.union([
  z.object({
    kind: z.literal('tableRow'),
    /** Human-readable note about which table, for reviewers. */
    tableDescription: z.string().optional(),
    /** Column header text used to locate the anchor cell. */
    matchColumn: z.string(),
    /** The value that identifies the row -- typically a param reference. */
    matchValue: ValueExprSchema,
    matchMode: z.enum(['exact', 'contains']).default('exact'),
  }),
  z.object({
    kind: z.literal('region'),
    /** Nearest enclosing landmark/heading text, e.g. a panel title. */
    nearHeading: z.string(),
  }),
]);
export type Scope = z.infer<typeof ScopeSchema>;

/* ------------------------------------------------------------ strategies */

export const StrategySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('testId'),
    attribute: z.string().default('data-testid'),
    value: z.string(),
  }),
  z.object({
    kind: z.literal('formField'),
    /** The `name` attribute. Stable on server-rendered apps; see file header. */
    name: z.string(),
    /** Narrows within a specific form when a page has several. */
    formName: z.string().optional(),
    controlType: z.enum(['input', 'select', 'textarea', 'any']).default('any'),
  }),
  z.object({
    kind: z.literal('roleName'),
    /** ARIA role, or the platform a11y role on a desktop surface. */
    role: z.string(),
    name: z.string(),
    match: z.enum(['exact', 'contains']).default('exact'),
  }),
  z.object({
    kind: z.literal('label'),
    label: z.string(),
    /**
     * How the label relates to the control. `adjacentCell` is the legacy case:
     * the visible label lives in the <td> before the input, with no <label for>
     * association at all, so the control has NO computed accessible name.
     */
    via: z.enum(['for', 'ariaLabel', 'adjacentCell', 'wrapping']).default('for'),
    match: z.enum(['exact', 'contains']).default('exact'),
  }),
  z.object({
    kind: z.literal('text'),
    text: z.string(),
    match: z.enum(['exact', 'contains']).default('exact'),
    /** Optional tag hint, e.g. 'a' to only consider links. */
    tag: z.string().optional(),
  }),
  z.object({
    kind: z.literal('columnCell'),
    /**
     * Within a `tableRow` scope, picks the cell under a named column.
     * This is how values are READ out of legacy grids.
     */
    column: z.string(),
  }),
  z.object({
    kind: z.literal('structural'),
    css: z.string().optional(),
    /** Recorded for diagnostics even when unused. */
    xpath: z.string().optional(),
  }),
]);
export type Strategy = z.infer<typeof StrategySchema>;

/** Ladder rank. Lower is stronger. Used to compute confidence and drift. */
export const STRATEGY_RANK: Record<Strategy['kind'], number> = {
  testId: 1,
  formField: 2,
  roleName: 3,
  label: 4,
  columnCell: 4,
  text: 5,
  structural: 9,
};

/**
 * Strategies at or below this rank are considered stable enough to use during
 * unattended replay without raising a drift warning.
 */
export const STABLE_RANK_THRESHOLD = 4;

/* ------------------------------------------------------------ descriptor */

export const TargetDescriptorSchema = z.object({
  /** Plain-language description. Exists so a human reviewing the capability
   *  can tell what the step touches without decoding selectors. */
  description: z.string(),
  /**
   * Which document to look in.
   *
   * An explicit `[]` means the TOP document; omitting the field entirely means
   * "any frame". Recorded steps always name their frame, because precision is
   * what stops a step clicking the right-looking control in the wrong frame.
   * Recovery rules generally do not: an interstitial, a session-expiry notice
   * or a compliance acknowledgement renders in whichever frame happened to
   * navigate, and pinning those to one frame is how a recovery silently stops
   * firing.
   */
  // NOTE: this must be `z.array(...).optional()`, not `FramePathSchema.optional()`.
  // FramePathSchema carries `.default([])`, and the default wins over the
  // optional wrapper -- which would silently turn "any frame" into "top
  // document only" and stop every recovery rule from firing.
  frame: z.array(FrameRefSchema).optional(),
  scope: ScopeSchema.optional(),
  /** Ranked ladder. Evaluated in array order; first UNIQUE match wins. */
  strategies: z.array(StrategySchema).min(1),
  /**
   * When true (the default) a strategy matching multiple elements is treated
   * as a miss and the ladder continues, rather than silently taking the first.
   * Silently taking the first match is how automation clicks the wrong row.
   */
  requireUnique: z.boolean().default(true),
  /**
   * Refuse to fall back below this rank. Steps that act destructively set this
   * tighter, so a risky click never lands on a guessed element.
   */
  maxRank: z.number().int().default(STRATEGY_RANK.structural),
  /**
   * Which rung actually resolved this element when it was recorded.
   *
   * Stored so replay can tell the difference between "found it the same way as
   * always" and "found it, but only after falling further down the ladder".
   * The second case still succeeds, and reporting it is the point: it is a
   * leading indicator that the surface is drifting, available before the step
   * actually breaks. Without a recorded baseline there is nothing to compare
   * against and drift can only be discovered by outage.
   */
  recordedRank: z.number().int().optional(),
  recordedStrategy: z.string().optional(),
});
export type TargetDescriptor = z.infer<typeof TargetDescriptorSchema>;
