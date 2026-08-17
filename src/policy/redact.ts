/**
 * Redaction.
 *
 * The requirement is blunt: never persist secrets or raw sensitive data into
 * artifacts or logs. The design question is where to enforce it, and the answer
 * that actually holds up is "at the boundary where bytes get written, driven by
 * declarations made elsewhere" -- not at each call site.
 *
 * So there are two complementary mechanisms:
 *
 *   1. VALUE registration. When the runtime binds an input parameter, it tells
 *      the redactor the concrete value and the sensitivity declared for that
 *      parameter in the artifact contract. From then on that exact string is
 *      masked anywhere it appears -- in a log line, in an error's `observed`
 *      field, in a DOM snapshot. This catches the case regex never will: the
 *      password is masked because we KNOW it is the password, not because it
 *      happens to look like one.
 *
 *   2. PATTERN matching. Configured regexes for shapes that are sensitive
 *      wherever they appear (SSNs, card numbers, auth headers) and that we
 *      never explicitly bound -- data read off the screen, for instance.
 *
 * Sensitivity levels differ in what survives:
 *
 *   secret    Replaced entirely. Never appears anywhere, in any form. There is
 *             no debugging use for a password that justifies the risk.
 *   pii       Masked to its last 4 characters by default. A log where every
 *             member ID reads `[REDACTED]` cannot be used to trace which record
 *             a failure happened on, which makes the system unoperable; last-4
 *             is the standard compromise and is what a bank's own logs do.
 *   internal  Left intact but flagged, so it is at least greppable.
 *   none      Untouched.
 */

import type { Sensitivity } from '../schema/artifact.ts';
import type { PolicyConfig } from './config.ts';

interface RegisteredValue {
  value: string;
  sensitivity: Sensitivity;
  label: string;
}

export class Redactor {
  private values: RegisteredValue[] = [];
  private patterns: Array<{ name: string; re: RegExp; replacement: string }>;
  private keepLast4: boolean;

  constructor(config: Pick<PolicyConfig, 'redaction'>) {
    this.keepLast4 = config.redaction.keepLast4ForPii;
    this.patterns = config.redaction.patterns.map((p) => ({
      name: p.name,
      re: new RegExp(p.regex, p.flags),
      replacement: p.replacement,
    }));
  }

  /**
   * Declare a concrete value as sensitive. Called by the runtime as it binds
   * parameters, so redaction follows the artifact's declared contract rather
   * than a developer's memory.
   */
  register(label: string, value: unknown, sensitivity: Sensitivity): void {
    if (sensitivity === 'none') return;
    const s = String(value ?? '');
    // Very short values would turn every occurrence of a common substring into
    // a mask and destroy the logs. Below 4 chars we rely on patterns instead.
    if (s.length < 4) return;
    this.values.push({ value: s, sensitivity, label });
  }

  private maskFor(v: RegisteredValue): string {
    if (v.sensitivity === 'secret') return `[REDACTED:${v.label}]`;
    if (v.sensitivity === 'internal') return v.value;
    // pii
    if (!this.keepLast4) return `[REDACTED:${v.label}]`;
    const tail = v.value.slice(-4);
    return `***${tail}`;
  }

  /** Redact a string. Safe to call on anything, including already-clean text. */
  text(input: string): string {
    if (!input) return input;
    let out = input;

    // Longest values first: masking a substring before its superstring would
    // leave fragments of the longer secret visible.
    const sorted = [...this.values].sort((a, b) => b.value.length - a.value.length);
    for (const v of sorted) {
      if (v.sensitivity === 'internal') continue;
      if (!out.includes(v.value)) continue;
      out = out.split(v.value).join(this.maskFor(v));
    }

    for (const p of this.patterns) {
      // Regexes with /g carry lastIndex state across calls; reset defensively.
      p.re.lastIndex = 0;
      out = out.replace(p.re, p.replacement);
    }

    return out;
  }

  /** Deep-redact an arbitrary structure. Used on every log record. */
  value<T>(input: T): T {
    return this.walk(input) as T;
  }

  private walk(input: unknown): unknown {
    if (typeof input === 'string') return this.text(input);
    if (Array.isArray(input)) return input.map((v) => this.walk(v));
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        // Key-name heuristic as a backstop: anything named like a credential is
        // dropped whether or not it was registered. Cheap, and it catches
        // values that arrive from outside the parameter-binding path.
        if (/^(password|passwd|secret|token|api[-_]?key|authorization|cookie)$/i.test(k)) {
          out[k] = '[REDACTED]';
          continue;
        }
        out[k] = this.walk(v);
      }
      return out;
    }
    return input;
  }

  /** How many distinct sensitive values are being tracked. For run summaries. */
  get registeredCount(): number {
    return this.values.length;
  }
}
