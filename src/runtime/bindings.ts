/**
 * Value binding: turning a recorded `ValueExpr` into a concrete string at
 * replay time.
 *
 * Kept tiny and pure on purpose. This is the join point between the caller's
 * typed input parameters and the recorded flow, so it is exercised on every
 * single step and needs to be trivially auditable.
 */

import type { ValueExpr } from '../schema/targeting.ts';

export type Scalar = string | number | boolean;

export interface Bindings {
  /** Input parameters supplied by the calling agent. */
  params: Record<string, Scalar>;
  /** Values extracted by earlier steps in this run. */
  outputs: Record<string, Scalar>;
}

export function emptyBindings(): Bindings {
  return { params: {}, outputs: {} };
}

export class BindingError extends Error {
  readonly ref: string;
  constructor(message: string, ref: string) {
    super(message);
    this.name = 'BindingError';
    this.ref = ref;
  }
}

/** Resolve `${name}` against params first, then prior outputs. */
function lookup(name: string, b: Bindings): Scalar {
  if (name in b.params) return b.params[name]!;
  if (name in b.outputs) return b.outputs[name]!;
  throw new BindingError(`No value bound for '${name}'`, name);
}

export function evalValue(expr: ValueExpr, b: Bindings): string {
  if ('literal' in expr) return expr.literal;
  if ('param' in expr) {
    if (!(expr.param in b.params)) throw new BindingError(`Missing input parameter '${expr.param}'`, expr.param);
    return String(b.params[expr.param]);
  }
  if ('fromOutput' in expr) {
    if (!(expr.fromOutput in b.outputs)) {
      throw new BindingError(`Step referenced output '${expr.fromOutput}' before it was produced`, expr.fromOutput);
    }
    return String(b.outputs[expr.fromOutput]);
  }
  return expr.template.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_m, name: string) => String(lookup(name, b)));
}

/** Describe an expression for logs without resolving it. */
export function describeValue(expr: ValueExpr): string {
  if ('literal' in expr) return JSON.stringify(expr.literal);
  if ('param' in expr) return `$${expr.param}`;
  if ('fromOutput' in expr) return `@${expr.fromOutput}`;
  return `\`${expr.template}\``;
}
