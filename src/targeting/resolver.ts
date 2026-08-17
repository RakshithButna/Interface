/**
 * The resolver: turn a recorded `TargetDescriptor` back into a concrete node
 * in the current observation.
 *
 * This file is deliberately free of any Playwright, DOM or browser concept. It
 * operates purely on `UiNode[]`, which is what makes the same targeting logic
 * usable against a desktop accessibility tree without modification.
 *
 * The algorithm:
 *
 *   1. Narrow to the right frame (or window, on a desktop surface).
 *   2. Narrow to the right region -- crucially, the right table ROW.
 *   3. Walk the strategy ladder in order and take the first UNIQUE match.
 *
 * Step 3 has one rule that does most of the work: a strategy that matches
 * several nodes is treated as a MISS, not as "take the first one". Taking the
 * first match is how automation silently services the wrong member's account.
 * Ambiguity means the descriptor was not specific enough, and the correct
 * response is to try a more specific rung, then fail loudly.
 *
 * Every rung attempted is recorded, not just the winner. If replay resolves via
 * a weaker rung than recording did, the step still succeeds but the run
 * reports LOCATOR_DRIFT -- an early warning that the surface is moving out from
 * under the capability, available before it actually breaks.
 */

import type { UiNode, Observation } from '../surface/types.ts';
import type { FrameRef, Scope, Strategy, TargetDescriptor } from '../schema/targeting.ts';
import { STRATEGY_RANK } from '../schema/targeting.ts';
import type { TenantOverride } from '../schema/artifact.ts';
import { aliasTarget } from '../runtime/overrides.ts';
import { evalValue, type Bindings } from '../runtime/bindings.ts';

export interface ResolveAttempt {
  strategy: string;
  rank: number;
  matched: number;
  note?: string;
}

export type ResolveResult =
  | {
      ok: true;
      node: UiNode;
      strategy: Strategy;
      rank: number;
      attempts: ResolveAttempt[];
    }
  | {
      ok: false;
      reason: 'no_frame' | 'no_scope' | 'not_found' | 'ambiguous';
      attempts: ResolveAttempt[];
      /** Populated on `ambiguous` so the error message can show the collision. */
      candidates: UiNode[];
      detail: string;
    };

export interface ResolveOptions {
  bindings: Bindings;
  override?: TenantOverride | undefined;
}

/* ---------------------------------------------------------------- helpers */

function norm(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function textMatches(actual: string | undefined, expected: string, mode: 'exact' | 'contains'): boolean {
  const a = norm(actual).toLowerCase();
  const e = norm(expected).toLowerCase();
  if (!e) return false;
  return mode === 'exact' ? a === e : a.includes(e);
}

function frameMatches(recorded: FrameRef[], nodePath: FrameRef[], obs: Observation, node: UiNode): boolean {
  if (recorded.length !== nodePath.length) return false;
  for (let i = 0; i < recorded.length; i++) {
    const r = recorded[i]!;
    const n = nodePath[i]!;
    if (r.by === 'name') {
      if (n.by !== 'name' || n.name !== r.name) return false;
    } else if (r.by === 'index') {
      if (n.by !== 'index' || n.index !== r.index) return false;
    } else {
      // urlPattern is matched against the frame's live URL rather than against
      // the node's own path entry, because the path entry is only a summary.
      const frame = obs.frames.find((f) => f.index === node.frameIndex);
      if (!frame || !frame.url.includes(r.pattern)) return false;
    }
  }
  return true;
}

/** Column index for a header name, tolerant of whitespace and casing. */
function columnIndex(headers: string[], column: string): number {
  const want = norm(column).toLowerCase();
  return headers.findIndex((h) => norm(h).toLowerCase() === want);
}

/* ------------------------------------------------------------------ scope */

function applyScope(
  nodes: UiNode[],
  scope: Scope | undefined,
  opts: ResolveOptions,
): { ok: true; nodes: UiNode[] } | { ok: false; detail: string } {
  if (!scope) return { ok: true, nodes };

  if (scope.kind === 'region') {
    // Region scoping is approximated by proximity in document order to a
    // heading with the given text. Adequate for panelised legacy layouts;
    // documented as a known simplification in REPORT.md section 7.
    const headingIdx = nodes.findIndex(
      (n) => n.role === 'heading' && textMatches(n.name || n.text, scope.nearHeading, 'contains'),
    );
    if (headingIdx === -1) return { ok: false, detail: `No heading matching '${scope.nearHeading}'` };
    return { ok: true, nodes: nodes.slice(headingIdx) };
  }

  // tableRow: find rows whose anchor column holds the expected value.
  const wanted = evalValue(scope.matchValue, opts.bindings);
  const matching = nodes.filter((n) => {
    const t = n.table;
    if (!t) return false;
    const ci = columnIndex(t.headers, scope.matchColumn);
    if (ci === -1) return false;
    const cell = t.rowCells[ci];
    return textMatches(cell, wanted, scope.matchMode);
  });

  if (matching.length === 0) {
    return {
      ok: false,
      detail: `No table row where '${scope.matchColumn}' ${scope.matchMode === 'exact' ? '=' : 'contains'} '${wanted}'`,
    };
  }

  // Restrict to a single row. If the anchor value appears in more than one
  // row the descriptor is genuinely ambiguous, and we say so rather than
  // picking one.
  const rowKeys = new Set(matching.map((n) => `${n.frameIndex}:${n.table!.rowIndex}`));
  if (rowKeys.size > 1) {
    return {
      ok: false,
      detail: `Anchor '${scope.matchColumn}=${wanted}' matched ${rowKeys.size} rows; expected exactly one`,
    };
  }

  const key = [...rowKeys][0]!;
  return {
    ok: true,
    nodes: nodes.filter((n) => n.table && `${n.frameIndex}:${n.table.rowIndex}` === key),
  };
}

/* -------------------------------------------------------------- strategies */

const LABELISH = new Set(['labelFor', 'labelWrapping', 'ariaLabel', 'ariaLabelledBy', 'adjacentCell', 'title', 'placeholder']);

function matchStrategy(nodes: UiNode[], s: Strategy): UiNode[] {
  switch (s.kind) {
    case 'testId':
      return nodes.filter((n) => n.testId === s.value);

    case 'formField':
      return nodes.filter((n) => {
        if (n.formFieldName !== s.name) return false;
        if (s.formName && n.formName !== s.formName) return false;
        if (s.controlType !== 'any' && n.tag !== s.controlType) return false;
        return true;
      });

    case 'roleName':
      return nodes.filter((n) => n.role === s.role && textMatches(n.name, s.name, s.match));

    case 'label':
      // The recorded `via` is kept for diagnostics but not enforced. If an app
      // is upgraded so a field gains a real <label for>, a capability recorded
      // against the adjacent-cell era should keep working -- the human-visible
      // label is what we actually meant.
      return nodes.filter((n) => LABELISH.has(n.nameSource) && textMatches(n.name, s.label, s.match));

    case 'text':
      return nodes.filter((n) => {
        if (s.tag && n.tag !== s.tag) return false;
        return textMatches(n.text ?? n.name, s.text, s.match);
      });

    case 'columnCell':
      return nodes.filter((n) => {
        const t = n.table;
        if (!t) return false;
        if (n.role !== 'cell' && n.role !== 'columnheader') return false;
        const ci = columnIndex(t.headers, s.column);
        return ci !== -1 && ci === t.colIndex;
      });

    case 'structural':
      return nodes.filter((n) => (s.css ? n.css === s.css : false));
  }
}

function describeStrategy(s: Strategy): string {
  switch (s.kind) {
    case 'testId':
      return `testId[${s.value}]`;
    case 'formField':
      return `formField[name=${s.name}]`;
    case 'roleName':
      return `roleName[${s.role}="${s.name}"]`;
    case 'label':
      return `label["${s.label}"]`;
    case 'text':
      return `text["${s.text}"]`;
    case 'columnCell':
      return `columnCell[${s.column}]`;
    case 'structural':
      return `structural[${s.css ?? s.xpath ?? '?'}]`;
  }
}

/* ------------------------------------------------------------------ resolve */

export function resolveTarget(
  descriptor: TargetDescriptor,
  obs: Observation,
  opts: ResolveOptions,
): ResolveResult {
  const target = aliasTarget(descriptor, opts.override);
  const attempts: ResolveAttempt[] = [];

  // 1. Frame. An omitted frame path searches every document; see the note on
  // TargetDescriptor.frame for why recovery rules need that.
  const inFrame =
    target.frame === undefined
      ? obs.nodes
      : obs.nodes.filter((n) => frameMatches(target.frame!, n.framePath, obs, n));
  if (inFrame.length === 0) {
    return {
      ok: false,
      reason: 'no_frame',
      attempts,
      candidates: [],
      detail: `No frame matching path ${JSON.stringify(target.frame)} (observed: ${JSON.stringify(
        obs.frames.map((f) => f.path),
      )})`,
    };
  }

  // 2. Scope
  const scoped = applyScope(inFrame, target.scope, opts);
  if (!scoped.ok) {
    return { ok: false, reason: 'no_scope', attempts, candidates: [], detail: scoped.detail };
  }

  // 3. Ladder
  let ambiguousCandidates: UiNode[] = [];
  for (const strategy of target.strategies) {
    const rank = STRATEGY_RANK[strategy.kind];
    if (rank > target.maxRank) {
      attempts.push({
        strategy: describeStrategy(strategy),
        rank,
        matched: 0,
        note: `skipped: rank ${rank} exceeds maxRank ${target.maxRank}`,
      });
      continue;
    }

    const matched = matchStrategy(scoped.nodes, strategy);
    attempts.push({ strategy: describeStrategy(strategy), rank, matched: matched.length });

    if (matched.length === 1) {
      return { ok: true, node: matched[0]!, strategy, rank, attempts };
    }
    if (matched.length > 1) {
      if (!target.requireUnique) {
        return { ok: true, node: matched[0]!, strategy, rank, attempts };
      }
      // Remember the collision, but keep descending the ladder: a more
      // specific rung may still resolve it uniquely.
      ambiguousCandidates = matched;
    }
  }

  if (ambiguousCandidates.length > 0) {
    return {
      ok: false,
      reason: 'ambiguous',
      attempts,
      candidates: ambiguousCandidates,
      detail: `${ambiguousCandidates.length} elements matched and no strategy distinguished them`,
    };
  }

  return {
    ok: false,
    reason: 'not_found',
    attempts,
    candidates: [],
    detail: `No element matched any of ${target.strategies.length} strategies`,
  };
}

/** Convenience for assertions that only care whether something exists. */
export function targetExists(descriptor: TargetDescriptor, obs: Observation, opts: ResolveOptions): boolean {
  return resolveTarget(descriptor, obs, opts).ok;
}

/** Human-readable trace of a failed resolution, for the error payload. */
export function formatAttempts(attempts: ResolveAttempt[]): string {
  if (attempts.length === 0) return '(no strategies attempted)';
  return attempts
    .map((a) => `${a.strategy} rank=${a.rank} matched=${a.matched}${a.note ? ` (${a.note})` : ''}`)
    .join('; ');
}
