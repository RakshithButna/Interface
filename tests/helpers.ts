/**
 * Test helpers.
 *
 * The synthetic observation builder is what makes the targeting and assertion
 * layers testable without a browser -- which is itself evidence that the
 * surface seam is in the right place. If these tests needed Playwright, the
 * abstraction would not be doing its job.
 */

import type { Observation, UiNode, NameSource } from '../src/surface/types.ts';
import type { FrameRef } from '../src/schema/targeting.ts';

let refCounter = 0;

export function node(partial: Partial<UiNode> & { role: string }): UiNode {
  refCounter += 1;
  return {
    ...partial,
    ref: partial.ref ?? `0#${refCounter}`,
    role: partial.role,
    name: partial.name ?? '',
    nameSource: (partial.nameSource ?? 'textContent') as NameSource,
    interactive: partial.interactive ?? ['link', 'button', 'textbox', 'combobox'].includes(partial.role),
    framePath: partial.framePath ?? [],
    frameIndex: partial.frameIndex ?? 0,
  };
}

export function observation(nodes: UiNode[], opts: Partial<Observation> = {}): Observation {
  const frameIndexes = [...new Set(nodes.map((n) => n.frameIndex))];
  const frames = (
    opts.frames ??
    frameIndexes.map((index) => ({
      index,
      path: nodes.find((n) => n.frameIndex === index)?.framePath ?? ([] as FrameRef[]),
      url: `http://app.test/frame${index}`,
      text: nodes
        .filter((n) => n.frameIndex === index)
        .map((n) => n.text ?? n.name)
        .join(' '),
    }))
  ).slice();
  if (frames.length === 0) frames.push({ index: 0, path: [], url: 'http://app.test/', text: '' });

  return {
    url: 'http://app.test/',
    title: 'test',
    frames,
    nodes,
    capturedAt: new Date().toISOString(),
    truncated: false,
    ...opts,
  };
}

/** A results grid where every row has an identical "View" link. */
export function gridObservation(rows: Array<[string, string, string]>): Observation {
  const headers = ['Member ID', 'Member Name', 'Status', 'Action'];
  const nodes: UiNode[] = [];

  rows.forEach(([id, name, status], i) => {
    const rowCells = [id, name, status, 'View'];
    const rowIndex = i + 1;
    headers.forEach((h, ci) => {
      if (ci === 3) return;
      nodes.push(
        node({
          role: 'cell',
          name: rowCells[ci]!,
          text: rowCells[ci]!,
          table: { headers, rowCells, rowIndex, colIndex: ci, columnHeader: h },
        }),
      );
    });
    nodes.push(
      node({
        role: 'link',
        name: 'View',
        text: 'View',
        tag: 'a',
        css: `table > tbody > tr:nth-of-type(${rowIndex + 1}) > td:nth-of-type(4) > a`,
        table: { headers, rowCells, rowIndex, colIndex: 3, columnHeader: 'Action' },
      }),
    );
  });

  return observation(nodes);
}
