/**
 * Input validation and output coercion -- the two edges of the capability
 * contract.
 *
 * Validating before touching the UI is not just tidiness. Driving a banking
 * screen is slow and has side effects; discovering on step 7 that the caller
 * passed a malformed member ID means seven steps of real interaction happened
 * for nothing. A contract that can be checked statically should be.
 */

import type { CapabilityArtifact, ParamSpec, OutputSpec } from '../schema/artifact.ts';
import type { Scalar } from '../runtime/bindings.ts';

export interface ValidationFailure {
  param: string;
  problem: string;
}

export function validateInputs(
  artifact: CapabilityArtifact,
  supplied: Record<string, Scalar>,
): { ok: true; values: Record<string, Scalar> } | { ok: false; failures: ValidationFailure[] } {
  const failures: ValidationFailure[] = [];
  const values: Record<string, Scalar> = {};

  for (const spec of artifact.inputs) {
    const raw = supplied[spec.name];

    if (raw === undefined || raw === '') {
      if (spec.default !== undefined) {
        values[spec.name] = spec.default;
        continue;
      }
      if (spec.required) failures.push({ param: spec.name, problem: 'required but not supplied' });
      continue;
    }

    const coerced = coerceParam(spec, raw);
    if ('problem' in coerced) {
      failures.push({ param: spec.name, problem: coerced.problem });
      continue;
    }
    values[spec.name] = coerced.value;
  }

  // Unknown parameters are rejected rather than ignored: silently dropping an
  // argument the caller thought mattered is how the wrong account gets
  // serviced with nobody noticing.
  const declared = new Set(artifact.inputs.map((i) => i.name));
  for (const name of Object.keys(supplied)) {
    if (!declared.has(name)) {
      failures.push({ param: name, problem: 'not declared by this capability' });
    }
  }

  return failures.length > 0 ? { ok: false, failures } : { ok: true, values };
}

function coerceParam(spec: ParamSpec, raw: Scalar): { value: Scalar } | { problem: string } {
  const asString = String(raw);

  switch (spec.type) {
    case 'number': {
      const n = Number(asString);
      if (!Number.isFinite(n)) return { problem: `expected a number, got ${JSON.stringify(asString)}` };
      return { value: n };
    }
    case 'boolean': {
      if (/^(true|1|yes)$/i.test(asString)) return { value: true };
      if (/^(false|0|no)$/i.test(asString)) return { value: false };
      return { problem: `expected a boolean, got ${JSON.stringify(asString)}` };
    }
    case 'enum': {
      if (!spec.enumValues?.includes(asString)) {
        return { problem: `must be one of [${(spec.enumValues ?? []).join(', ')}]` };
      }
      return { value: asString };
    }
    case 'string': {
      if (spec.pattern) {
        let re: RegExp;
        try {
          re = new RegExp(spec.pattern);
        } catch {
          return { problem: `capability declares an invalid pattern ${JSON.stringify(spec.pattern)}` };
        }
        if (!re.test(asString)) return { problem: `does not match required pattern /${spec.pattern}/` };
      }
      return { value: asString };
    }
  }
}

/* --------------------------------------------------------------- outputs */

export function transformExtracted(
  raw: string,
  transform: 'none' | 'trim' | 'moneyToNumber' | 'digitsOnly',
  extractPattern?: string,
): { value: string } | { problem: string } {
  let s = raw;

  if (extractPattern) {
    let re: RegExp;
    try {
      re = new RegExp(extractPattern);
    } catch {
      return { problem: `invalid extractPattern /${extractPattern}/` };
    }
    const m = re.exec(s);
    if (!m) return { problem: `extractPattern /${extractPattern}/ did not match ${JSON.stringify(s.slice(0, 80))}` };
    s = m[1] ?? m[0];
  }

  switch (transform) {
    case 'none':
      return { value: s };
    case 'trim':
      return { value: s.trim() };
    case 'digitsOnly':
      return { value: s.replace(/\D+/g, '') };
    case 'moneyToNumber': {
      const cleaned = s.replace(/[$,\s]/g, '');
      if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
        return { problem: `expected a monetary amount, got ${JSON.stringify(s.slice(0, 40))}` };
      }
      return { value: cleaned };
    }
  }
}

/** Coerce a captured string into the type the output contract promises. */
export function coerceOutput(spec: OutputSpec, raw: string): { value: Scalar } | { problem: string } {
  switch (spec.type) {
    case 'string':
      return { value: raw };
    case 'boolean':
      return { value: /^(true|yes|1)$/i.test(raw.trim()) };
    case 'number':
    case 'money': {
      const cleaned = raw.replace(/[$,\s]/g, '');
      const n = Number(cleaned);
      if (!Number.isFinite(n)) {
        return { problem: `declared as ${spec.type} but observed ${JSON.stringify(raw.slice(0, 40))}` };
      }
      return { value: n };
    }
  }
}
