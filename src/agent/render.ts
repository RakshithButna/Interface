/**
 * Rendering an observation for the model.
 *
 * This is the perception channel, and choosing it is the "computer use"
 * decision the brief cares about. We send a normalised accessibility-tree
 * listing as text, not a screenshot with coordinates.
 *
 * Why, given screenshots are the more fashionable answer:
 *
 * - It is what actually generalises. The a11y tree exists on Windows
 *   (UIAutomation), macOS (AX) and the web. A screenshot-plus-coordinates loop
 *   generalises to pixels, which sounds general but is the weakest possible
 *   contract -- it cannot tell you a control's name, role, or whether it is
 *   disabled, and it cannot be replayed deterministically because the recorded
 *   artifact would contain coordinates.
 *
 * - It makes recording possible at all. To emit a durable descriptor we must
 *   know the identity of the control that was acted on. Clicking at (412, 233)
 *   tells us nothing to record. Clicking node `2#7` tells us its role, name,
 *   form field name, and table row.
 *
 * - Legacy apps are text. Frameset-and-table software renders essentially no
 *   visual information a screenshot adds over the markup.
 *
 * The honest limitation, stated in REPORT.md section 7: a canvas-rendered or
 * custom-drawn surface has no meaningful a11y tree, and there a screenshot
 * model is the only option. The `Surface` interface is where that would plug
 * in -- an OCR/vision surface producing the same `UiNode` shape -- which is
 * why perception lives behind that seam rather than inside this file.
 */

import type { Observation, UiNode } from '../surface/types.ts';
import type { FrameRef } from '../schema/targeting.ts';

function frameLabel(path: FrameRef[]): string {
  if (path.length === 0) return 'top';
  return path
    .map((f) => (f.by === 'name' ? f.name : f.by === 'index' ? `#${f.index}` : f.pattern))
    .join(' > ');
}

function describeNode(n: UiNode): string {
  const bits: string[] = [`${n.ref}`, n.role];
  if (n.name) bits.push(JSON.stringify(n.name));
  if (n.formFieldName) bits.push(`field=${n.formFieldName}`);
  if (n.inputType && n.inputType !== 'text') bits.push(`type=${n.inputType}`);
  if (n.value) bits.push(`value=${JSON.stringify(n.value.slice(0, 40))}`);
  if (n.options?.length) {
    bits.push(`options=[${n.options.map((o) => o.value).filter(Boolean).join(',')}]`);
  }
  if (n.disabled) bits.push('DISABLED');
  if (n.table && n.role !== 'cell' && n.role !== 'columnheader') {
    bits.push(`row=[${n.table.rowCells.slice(0, 5).join(' | ')}]`);
  }
  return bits.join(' ');
}

export interface RenderOptions {
  /** Cap on interactive nodes listed, to keep the prompt affordable. */
  maxInteractive?: number;
  /** Cap on table cells listed. */
  maxCells?: number;
  maxTextChars?: number;
}

export function renderObservation(obs: Observation, opts: RenderOptions = {}): string {
  const maxInteractive = opts.maxInteractive ?? 60;
  const maxCells = opts.maxCells ?? 40;
  const maxTextChars = opts.maxTextChars ?? 1200;

  const lines: string[] = [];
  lines.push(`URL: ${obs.url}`);
  lines.push(`TITLE: ${obs.title}`);
  if (obs.httpStatus !== undefined) lines.push(`HTTP_STATUS: ${obs.httpStatus}`);

  if (obs.frames.length > 1) {
    lines.push('');
    lines.push('FRAMES:');
    for (const f of obs.frames) lines.push(`  ${frameLabel(f.path)}  ${f.url}`);
  }

  const byFrame = new Map<number, UiNode[]>();
  for (const n of obs.nodes) {
    const arr = byFrame.get(n.frameIndex) ?? [];
    arr.push(n);
    byFrame.set(n.frameIndex, arr);
  }

  lines.push('');
  lines.push('CONTROLS (act on these by ref):');
  let interactiveShown = 0;
  for (const f of obs.frames) {
    const nodes = (byFrame.get(f.index) ?? []).filter((n) => n.interactive);
    if (nodes.length === 0) continue;
    lines.push(`  [frame: ${frameLabel(f.path)}]`);
    for (const n of nodes) {
      if (interactiveShown >= maxInteractive) {
        lines.push('    ... (truncated)');
        break;
      }
      lines.push(`    ${describeNode(n)}`);
      interactiveShown += 1;
    }
  }
  if (interactiveShown === 0) lines.push('  (none)');

  // Grids are listed as whole rows rather than individual cells: the model
  // needs to see that two rows exist and how they differ, which is the
  // information that makes it choose the right one.
  const gridLines: string[] = [];
  let cellsShown = 0;
  for (const f of obs.frames) {
    const cells = (byFrame.get(f.index) ?? []).filter((n) => n.role === 'cell' && n.table);
    if (cells.length === 0) continue;
    const rows = new Map<number, UiNode>();
    for (const c of cells) if (!rows.has(c.table!.rowIndex)) rows.set(c.table!.rowIndex, c);
    gridLines.push(`  [frame: ${frameLabel(f.path)}]`);
    const first = [...rows.values()][0];
    if (first) gridLines.push(`    headers: ${first.table!.headers.join(' | ')}`);
    for (const [rowIndex, node] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      if (cellsShown >= maxCells) {
        gridLines.push('    ... (truncated)');
        break;
      }
      gridLines.push(`    row ${rowIndex}: ${node.table!.rowCells.join(' | ')}  [refs: ${
        cells.filter((c) => c.table!.rowIndex === rowIndex).map((c) => c.ref).join(' ')
      }]`);
      cellsShown += 1;
    }
  }
  if (gridLines.length > 0) {
    lines.push('');
    lines.push('TABLES (read values from these cell refs):');
    lines.push(...gridLines);
  }

  lines.push('');
  lines.push('PAGE TEXT:');
  for (const f of obs.frames) {
    if (!f.text) continue;
    const t = f.text.slice(0, maxTextChars);
    lines.push(`  [${frameLabel(f.path)}] ${t}${f.text.length > maxTextChars ? ' ...' : ''}`);
  }

  return lines.join('\n');
}
