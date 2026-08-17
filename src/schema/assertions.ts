/**
 * Assertions are how the system knows something actually happened.
 *
 * The brief's glossary is blunt about why this matters: a checkpoint is
 * "a condition you assert to confirm you actually reached the state you
 * expected, rather than assuming the click worked." Every step carries one,
 * and the capability as a whole carries a final one.
 *
 * The same assertion type does triple duty, which keeps the schema small:
 *   - step checkpoints  ("did this step land?")
 *   - outcome detection ("is this the 'no such member' screen?")
 *   - recovery triggers ("is this the interstitial we know how to dismiss?")
 *
 * That reuse is deliberate. Detecting a business outcome and detecting a
 * recoverable interstitial are the same operation -- looking at the current
 * state and asking a yes/no question. Only the *response* differs.
 */

import { z } from 'zod';
import { FramePathSchema, FrameRefSchema, TargetDescriptorSchema, ValueExprSchema } from './targeting.ts';

export type Assertion =
  | { kind: 'elementPresent'; target: z.infer<typeof TargetDescriptorSchema> }
  | { kind: 'elementAbsent'; target: z.infer<typeof TargetDescriptorSchema> }
  | {
      kind: 'textPresent';
      /** Omit to search every frame. See note on the schema below. */
      frame?: z.infer<typeof FramePathSchema>;
      text: string;
      match: 'exact' | 'contains' | 'regex';
      caseSensitive: boolean;
    }
  | {
      kind: 'textAbsent';
      frame?: z.infer<typeof FramePathSchema>;
      text: string;
      match: 'exact' | 'contains' | 'regex';
      caseSensitive: boolean;
    }
  | { kind: 'urlMatches'; pattern: string }
  | {
      kind: 'valueEquals';
      target: z.infer<typeof TargetDescriptorSchema>;
      expected: z.infer<typeof ValueExprSchema>;
    }
  | { kind: 'httpStatus'; codes: number[] }
  | { kind: 'all'; of: Assertion[] }
  | { kind: 'any'; of: Assertion[] }
  | { kind: 'not'; of: Assertion };

const LeafAssertionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('elementPresent'), target: TargetDescriptorSchema }),
  z.object({ kind: z.literal('elementAbsent'), target: TargetDescriptorSchema }),
  /**
   * `frame` is OPTIONAL on text assertions, and omitting it means "search
   * every frame". That is the right default for this domain: in a frameset
   * application an error banner, a session-expiry notice or a maintenance
   * interstitial can render in whichever frame the app felt like, and often in
   * a different one than the step that triggered it. Pinning outcome detection
   * to a single frame is how a "record not found" screen gets missed and the
   * run marches on into a hard failure. Element targeting keeps its required
   * frame path, because THERE the precision is what prevents clicking the
   * wrong thing.
   */
  z.object({
    kind: z.literal('textPresent'),
    frame: z.array(FrameRefSchema).optional(),
    text: z.string(),
    match: z.enum(['exact', 'contains', 'regex']).default('contains'),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('textAbsent'),
    frame: z.array(FrameRefSchema).optional(),
    text: z.string(),
    match: z.enum(['exact', 'contains', 'regex']).default('contains'),
    caseSensitive: z.boolean().default(false),
  }),
  /** Matched against the URL of the *top-level* document. */
  z.object({ kind: z.literal('urlMatches'), pattern: z.string() }),
  z.object({
    kind: z.literal('valueEquals'),
    target: TargetDescriptorSchema,
    expected: ValueExprSchema,
  }),
  /**
   * The last HTTP status observed for a main-frame navigation. Legacy apps
   * frequently signal permission denial with a 403 while rendering a page that
   * otherwise looks normal, so status is genuinely load-bearing signal here.
   */
  z.object({ kind: z.literal('httpStatus'), codes: z.array(z.number().int()).min(1) }),
]);

export const AssertionSchema: z.ZodType<Assertion> = z.lazy(() =>
  z.union([
    LeafAssertionSchema,
    z.object({ kind: z.literal('all'), of: z.array(AssertionSchema).min(1) }),
    z.object({ kind: z.literal('any'), of: z.array(AssertionSchema).min(1) }),
    z.object({ kind: z.literal('not'), of: AssertionSchema }),
  ]),
) as z.ZodType<Assertion>;

/** Convenience constructors used by the recorder and by hand-written fixtures. */
export const A = {
  /** Searches every frame unless one is named. */
  text(text: string, frame?: z.infer<typeof FramePathSchema>): Assertion {
    return { kind: 'textPresent', ...(frame ? { frame } : {}), text, match: 'contains', caseSensitive: false };
  },
  noText(text: string, frame?: z.infer<typeof FramePathSchema>): Assertion {
    return { kind: 'textAbsent', ...(frame ? { frame } : {}), text, match: 'contains', caseSensitive: false };
  },
  url(pattern: string): Assertion {
    return { kind: 'urlMatches', pattern };
  },
  present(target: z.infer<typeof TargetDescriptorSchema>): Assertion {
    return { kind: 'elementPresent', target };
  },
  all(...of: Assertion[]): Assertion {
    return { kind: 'all', of };
  },
  any(...of: Assertion[]): Assertion {
    return { kind: 'any', of };
  },
  not(of: Assertion): Assertion {
    return { kind: 'not', of };
  },
};
