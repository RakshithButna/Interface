/**
 * The surface abstraction -- the seam between "how we perceive and act on a
 * screen" and "the recorded flow".
 *
 * This is the single most important boundary in the system for the question
 * the brief asks in section 3.7: how does this extend from a web app to a
 * legacy web app or a native desktop application?
 *
 * The answer is that everything above this file is written against `UiNode`
 * and `Observation`, and nothing above this file knows what Playwright is.
 * The targeting resolver, the agent loop, the recorder and the replay engine
 * all operate on a normalised list of nodes. A `DesktopSurface` driving the
 * platform accessibility API (UIAutomation on Windows, AX on macOS) would
 * produce the same `UiNode` shape from a completely different source and every
 * layer above would work unchanged.
 *
 * That is why `UiNode` is modelled on the ACCESSIBILITY TREE rather than on the
 * DOM. Role, name, value and state exist on both web and desktop; CSS
 * selectors and tag names do not. Web-specific fields (`tag`, `formFieldName`,
 * `href`, `css`) are present but explicitly optional, and the targeting ladder
 * ranks the portable rungs as its backbone so that a capability recorded on
 * web is not automatically unportable.
 *
 * The other half of the seam is the `ref`: an opaque handle minted by the
 * surface during `observe()` and handed back to `perform()`. Callers never
 * construct one. That keeps the "how do I actually touch this control"
 * knowledge entirely inside the surface implementation.
 */

import type { FrameRef } from '../schema/targeting.ts';

/** Where a node's accessible name came from. Affects how much we trust it. */
export type NameSource =
  | 'ariaLabel'
  | 'ariaLabelledBy'
  | 'labelFor'
  | 'labelWrapping'
  | 'value'
  | 'textContent'
  | 'title'
  | 'placeholder'
  /**
   * Inferred from the adjacent table cell. This is the legacy case: the
   * control has NO real accessible name, and the only thing tying it to its
   * visible label is table geometry. Recorded distinctly so the resolver can
   * treat it as weaker evidence than a genuine accessible name.
   */
  | 'adjacentCell'
  | 'none';

/** Table geometry, which is how you address anything in a legacy grid. */
export interface TableContext {
  /** Column header texts, in order, for the table containing this node. */
  headers: string[];
  /** Text of every cell in this node's row, in column order. */
  rowCells: string[];
  rowIndex: number;
  colIndex: number;
  /** Header text for this node's own column, when derivable. */
  columnHeader?: string;
}

export interface UiNode {
  /** Opaque handle valid only within the observation that produced it. */
  ref: string;

  /* --- portable across web and desktop --------------------------------- */
  role: string;
  name: string;
  nameSource: NameSource;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  /** Whether this node accepts interaction. */
  interactive: boolean;
  /** Visible text, when the node carries any of its own. */
  text?: string;

  /* --- web-specific, optional by design -------------------------------- */
  tag?: string;
  /** The `name` attribute of a form control. See targeting.ts on why. */
  formFieldName?: string;
  formName?: string;
  testId?: string;
  href?: string;
  inputType?: string;
  /** Options of a <select>, so the agent knows what it may choose. */
  options?: Array<{ value: string; label: string }>;
  css?: string;

  /* --- context ---------------------------------------------------------- */
  framePath: FrameRef[];
  frameIndex: number;
  table?: TableContext;
}

export interface FrameObservation {
  index: number;
  path: FrameRef[];
  url: string;
  /** Visible text of the frame, collapsed. Used for text assertions. */
  text: string;
}

export interface Observation {
  url: string;
  title: string;
  /** Status of the most recent main-frame navigation, when known. */
  httpStatus?: number;
  frames: FrameObservation[];
  nodes: UiNode[];
  capturedAt: string;
  /** True when the surface truncated the node list. */
  truncated: boolean;
}

/* ------------------------------------------------------------ operations */

/**
 * Primitive operations a surface can perform. Deliberately smaller than the
 * artifact's `Action` union: an Action is a recorded intention that may need a
 * target resolved and a value interpolated, whereas a SurfaceOp is already
 * fully concrete. Keeping them separate is what stops surface implementations
 * from having to understand parameters, scopes or ladders.
 */
export type SurfaceOp =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; ref: string }
  | { kind: 'fill'; ref: string; value: string; clearFirst: boolean }
  | { kind: 'select'; ref: string; value: string }
  | { kind: 'press'; key: string; ref?: string }
  | { kind: 'back' };

export interface SurfaceCapabilities {
  screenshots: boolean;
  domSnapshots: boolean;
  /** Whether a human can be given direct control of this live session. */
  humanTakeover: boolean;
}

export interface Surface {
  readonly id: string;
  readonly kind: 'web' | 'desktop';
  readonly capabilities: SurfaceCapabilities;

  /** Snapshot the current state as a normalised node list. */
  observe(): Promise<Observation>;

  /** Execute one primitive operation against a ref from the latest observation. */
  perform(op: SurfaceOp): Promise<void>;

  /** Read a value off a node, for output extraction. */
  read(ref: string, from: 'text' | 'value' | 'href' | 'attribute', attribute?: string): Promise<string | null>;

  currentUrl(): string;
  lastHttpStatus(): number | undefined;

  screenshot(): Promise<Buffer | null>;
  domSnapshot(): Promise<string | null>;

  /** Block until the surface is idle, or the timeout elapses. */
  settle(timeoutMs: number): Promise<void>;

  close(): Promise<void>;
}
