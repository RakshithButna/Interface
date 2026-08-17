/**
 * Assertion evaluation.
 *
 * Pure over an `Observation`, like the resolver, so checkpoints and outcome
 * detection work identically on any surface.
 *
 * Every evaluation returns a human-readable `detail` whether it passed or
 * failed. That is what populates the `expected` / `observed` fields of a
 * failure, and it is the difference between an error a developer can act on
 * ("expected text 'Sub-Account Opened' in any frame; frames contained
 * 'Initial Deposit must be at least $25.00'") and one they cannot
 * ("checkpoint failed").
 */

import type { Assertion } from '../schema/assertions.ts';
import type { Observation } from '../surface/types.ts';
import type { TenantOverride } from '../schema/artifact.ts';
import { resolveTarget } from '../targeting/resolver.ts';
import { evalValue, type Bindings } from './bindings.ts';
import { aliasLabel } from './overrides.ts';
import type { FrameRef } from '../schema/targeting.ts';

export interface AssertOptions {
  bindings: Bindings;
  override?: TenantOverride | undefined;
}

export interface AssertResult {
  ok: boolean;
  detail: string;
}

/**
 * `undefined` and `[]` mean different things here, and conflating them is a
 * real bug: omitting the frame means "search every frame", whereas an explicit
 * empty path is the legitimate way to name the TOP document. An assertion
 * deliberately scoped to the top document must not quietly widen to include
 * every subframe.
 */
function frameText(obs: Observation, frame: FrameRef[] | undefined): string {
  if (frame === undefined) {
    return obs.frames.map((f) => f.text).join('\n');
  }
  const match = obs.frames.find((f) => {
    if (f.path.length !== frame.length) return false;
    return frame.every((want, i) => {
      const got = f.path[i]!;
      if (want.by === 'name') return got.by === 'name' && got.name === want.name;
      if (want.by === 'index') return got.by === 'index' && got.index === want.index;
      return f.url.includes(want.pattern);
    });
  });
  return match?.text ?? '';
}

function textHit(haystack: string, needle: string, mode: 'exact' | 'contains' | 'regex', caseSensitive: boolean): boolean {
  const h = caseSensitive ? haystack : haystack.toLowerCase();
  const n = caseSensitive ? needle : needle.toLowerCase();
  if (mode === 'regex') {
    try {
      return new RegExp(needle, caseSensitive ? '' : 'i').test(haystack);
    } catch {
      return false;
    }
  }
  if (mode === 'exact') return h.trim() === n.trim();
  return h.includes(n);
}

/** Trim page text for an error message without losing the informative part. */
function excerpt(s: string, max = 220): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}...`;
}

export function evaluateAssertion(a: Assertion, obs: Observation, opts: AssertOptions): AssertResult {
  switch (a.kind) {
    case 'elementPresent': {
      const r = resolveTarget(a.target, obs, opts);
      return r.ok
        ? { ok: true, detail: `found ${a.target.description}` }
        : { ok: false, detail: `expected element ${a.target.description}; ${r.detail}` };
    }

    case 'elementAbsent': {
      const r = resolveTarget(a.target, obs, opts);
      return r.ok
        ? { ok: false, detail: `expected ${a.target.description} to be absent, but it is present` }
        : { ok: true, detail: `${a.target.description} is absent as expected` };
    }

    case 'textPresent': {
      const wanted = aliasLabel(a.text, opts.override);
      const hay = frameText(obs, a.frame);
      const ok = textHit(hay, wanted, a.match, a.caseSensitive);
      return {
        ok,
        detail: ok
          ? `text ${JSON.stringify(wanted)} present`
          : `expected text ${JSON.stringify(wanted)} (${a.match}) in ${
              a.frame?.length ? 'frame ' + JSON.stringify(a.frame) : 'any frame'
            }; observed: "${excerpt(hay)}"`,
      };
    }

    case 'textAbsent': {
      const wanted = aliasLabel(a.text, opts.override);
      const hay = frameText(obs, a.frame);
      const hit = textHit(hay, wanted, a.match, a.caseSensitive);
      return {
        ok: !hit,
        detail: hit
          ? `expected text ${JSON.stringify(wanted)} to be absent, but it is present`
          : `text ${JSON.stringify(wanted)} absent as expected`,
      };
    }

    case 'urlMatches': {
      let re: RegExp;
      try {
        re = new RegExp(a.pattern);
      } catch {
        return { ok: false, detail: `invalid URL pattern ${JSON.stringify(a.pattern)}` };
      }
      const ok = re.test(obs.url);
      return {
        ok,
        detail: ok ? `url matches ${a.pattern}` : `expected url matching ${a.pattern}; observed ${obs.url}`,
      };
    }

    case 'valueEquals': {
      const r = resolveTarget(a.target, obs, opts);
      if (!r.ok) return { ok: false, detail: `cannot read ${a.target.description}: ${r.detail}` };
      const expected = evalValue(a.expected, opts.bindings);
      const actual = (r.node.value ?? r.node.text ?? '').trim();
      const ok = actual === expected.trim();
      return {
        ok,
        detail: ok
          ? `${a.target.description} equals expected value`
          : `expected ${a.target.description} to equal ${JSON.stringify(expected)}; observed ${JSON.stringify(actual)}`,
      };
    }

    case 'httpStatus': {
      const status = obs.httpStatus;
      const ok = status !== undefined && a.codes.includes(status);
      return {
        ok,
        detail: ok
          ? `http status ${status} as expected`
          : `expected http status in [${a.codes.join(', ')}]; observed ${status ?? 'unknown'}`,
      };
    }

    case 'all': {
      const failures = a.of.map((x) => evaluateAssertion(x, obs, opts)).filter((r) => !r.ok);
      return failures.length === 0
        ? { ok: true, detail: `all ${a.of.length} conditions held` }
        : { ok: false, detail: failures.map((f) => f.detail).join(' AND ') };
    }

    case 'any': {
      const results = a.of.map((x) => evaluateAssertion(x, obs, opts));
      const passed = results.find((r) => r.ok);
      return passed
        ? { ok: true, detail: passed.detail }
        : { ok: false, detail: `none of ${a.of.length} alternatives held: ${results.map((r) => r.detail).join(' OR ')}` };
    }

    case 'not': {
      const r = evaluateAssertion(a.of, obs, opts);
      return { ok: !r.ok, detail: r.ok ? `expected NOT (${r.detail})` : `negated condition held` };
    }
  }
}

/** Short description of what an assertion requires, for `expected` fields. */
export function describeAssertion(a: Assertion): string {
  switch (a.kind) {
    case 'elementPresent':
      return `element present: ${a.target.description}`;
    case 'elementAbsent':
      return `element absent: ${a.target.description}`;
    case 'textPresent':
      return `text present: ${JSON.stringify(a.text)}`;
    case 'textAbsent':
      return `text absent: ${JSON.stringify(a.text)}`;
    case 'urlMatches':
      return `url matches /${a.pattern}/`;
    case 'valueEquals':
      return `value of ${a.target.description} equals expected`;
    case 'httpStatus':
      return `http status in [${a.codes.join(', ')}]`;
    case 'all':
      return a.of.map(describeAssertion).join(' AND ');
    case 'any':
      return a.of.map(describeAssertion).join(' OR ');
    case 'not':
      return `NOT (${describeAssertion(a.of)})`;
  }
}
