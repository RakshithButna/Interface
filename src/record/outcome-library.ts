/**
 * Product-level exceptional-state vocabulary.
 *
 * A happy-path discovery run cannot teach us what failure looks like -- the
 * model never sees the "record not found" screen, so nothing in its transcript
 * describes one. Rather than pretend otherwise, the error vocabulary is
 * authored once per VENDOR PRODUCT and attached to every capability recorded
 * against it.
 *
 * That unit of reuse is the important part. In the environment the brief
 * describes, hundreds of institutions run the same handful of vendor products.
 * Error screens are a property of the product, not of the institution, so one
 * library file serves every tenant and every capability -- which is what makes
 * "handle exceptional states properly" tractable at that scale instead of
 * being re-derived per recording.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { OutcomeSpecSchema, OutcomeRuleSchema, RecoveryRuleSchema } from '../schema/artifact.ts';

export const OutcomeLibrarySchema = z.object({
  productId: z.string(),
  note: z.string().optional(),
  outcomes: z.array(OutcomeSpecSchema).default([]),
  outcomeRules: z.array(OutcomeRuleSchema).default([]),
  recoveries: z.array(RecoveryRuleSchema).default([]),
});

export type OutcomeLibrary = z.infer<typeof OutcomeLibrarySchema>;

export const EMPTY_LIBRARY: OutcomeLibrary = {
  productId: 'unknown',
  outcomes: [],
  outcomeRules: [],
  recoveries: [],
};

export function loadOutcomeLibrary(productId: string, root = 'config/outcomes'): OutcomeLibrary {
  const path = join(root, `${productId}.json`);
  if (!existsSync(path)) return { ...EMPTY_LIBRARY, productId };
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const lib = OutcomeLibrarySchema.parse(raw);

  // Fail loudly on a rule that names an outcome the library never declared:
  // it would silently never fire, and a detector that cannot fire is worse
  // than no detector because it looks like coverage.
  const declared = new Set(lib.outcomes.map((o) => o.code));
  for (const rule of lib.outcomeRules) {
    if (!declared.has(rule.outcome)) {
      throw new Error(
        `Outcome library '${path}' has a rule for '${rule.outcome}' but never declares that outcome.`,
      );
    }
  }
  return lib;
}
