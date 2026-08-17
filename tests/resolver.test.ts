import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTarget } from '../src/targeting/resolver.ts';
import { captureTarget } from '../src/targeting/capture.ts';
import { emptyBindings } from '../src/runtime/bindings.ts';
import type { TargetDescriptor } from '../src/schema/targeting.ts';
import { node, observation, gridObservation } from './helpers.ts';

const bindings = emptyBindings();

function target(partial: Partial<TargetDescriptor> & Pick<TargetDescriptor, 'strategies'>): TargetDescriptor {
  return {
    description: 'test target',
    frame: [],
    requireUnique: true,
    maxRank: 9,
    ...partial,
  };
}

describe('strategy ladder', () => {
  test('prefers the strongest rung that matches uniquely', () => {
    const obs = observation([
      node({ role: 'textbox', name: 'Member ID', nameSource: 'adjacentCell', formFieldName: 'memberId', tag: 'input' }),
    ]);

    const res = resolveTarget(
      target({
        strategies: [
          { kind: 'formField', name: 'memberId', controlType: 'input' },
          { kind: 'roleName', role: 'textbox', name: 'Member ID', match: 'exact' },
        ],
      }),
      obs,
      { bindings },
    );

    assert.equal(res.ok, true);
    assert.equal(res.ok && res.strategy.kind, 'formField');
    assert.equal(res.ok && res.rank, 2);
  });

  test('falls through to a weaker rung when the stronger one misses', () => {
    const obs = observation([node({ role: 'button', name: 'Sign On', nameSource: 'value', tag: 'input' })]);

    const res = resolveTarget(
      target({
        strategies: [
          { kind: 'formField', name: 'nonexistent', controlType: 'any' },
          { kind: 'roleName', role: 'button', name: 'Sign On', match: 'exact' },
        ],
      }),
      obs,
      { bindings },
    );

    assert.equal(res.ok, true);
    assert.equal(res.ok && res.strategy.kind, 'roleName');
    // Both rungs recorded, so drift is visible in the trace.
    assert.equal(res.attempts.length, 2);
    assert.equal(res.attempts[0]!.matched, 0);
  });

  test('refuses to guess when several elements match and none disambiguate', () => {
    const obs = gridObservation([
      ['12345', 'Whitfield, Dana', 'ACTIVE'],
      ['41120', 'Whitfield-Cruz, Dana', 'DORMANT'],
    ]);

    const res = resolveTarget(
      target({ strategies: [{ kind: 'roleName', role: 'link', name: 'View', match: 'exact' }] }),
      obs,
      { bindings },
    );

    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.reason, 'ambiguous');
    assert.equal(res.ok === false && res.candidates.length, 2);
  });

  test('requireUnique=false explicitly opts into taking the first match', () => {
    const obs = gridObservation([
      ['12345', 'A', 'ACTIVE'],
      ['41120', 'B', 'ACTIVE'],
    ]);

    const res = resolveTarget(
      target({
        requireUnique: false,
        strategies: [{ kind: 'roleName', role: 'link', name: 'View', match: 'exact' }],
      }),
      obs,
      { bindings },
    );
    assert.equal(res.ok, true);
  });

  test('maxRank blocks a fallback that would otherwise have matched', () => {
    const obs = observation([node({ role: 'link', name: 'Open Account', css: 'div > a' })]);

    const res = resolveTarget(
      target({ maxRank: 4, strategies: [{ kind: 'structural', css: 'div > a' }] }),
      obs,
      { bindings },
    );

    assert.equal(res.ok, false);
    assert.match(res.ok === false ? res.attempts[0]!.note ?? '' : '', /exceeds maxRank/);
  });
});

describe('row-anchored scoping', () => {
  const obs = gridObservation([
    ['12345', 'Whitfield, Dana', 'ACTIVE'],
    ['41120', 'Whitfield-Cruz, Dana', 'DORMANT'],
  ]);

  const scoped = (memberId: string) =>
    resolveTarget(
      target({
        scope: { kind: 'tableRow', matchColumn: 'Member ID', matchValue: { param: 'memberId' }, matchMode: 'exact' },
        strategies: [{ kind: 'roleName', role: 'link', name: 'View', match: 'exact' }],
      }),
      obs,
      { bindings: { params: { memberId }, outputs: {} } },
    );

  test('selects the row identified by the parameter', () => {
    const a = scoped('12345');
    assert.equal(a.ok, true);
    assert.equal(a.ok && a.node.table!.rowCells[0], '12345');

    const b = scoped('41120');
    assert.equal(b.ok, true);
    assert.equal(b.ok && b.node.table!.rowCells[0], '41120');
  });

  test('reports no_scope when the anchor value is not on the page', () => {
    const res = scoped('99999');
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.reason, 'no_scope');
    assert.match(res.ok === false ? res.detail : '', /No table row where 'Member ID'/);
  });
});

describe('frame matching', () => {
  test('a descriptor for one frame does not match nodes in another', () => {
    const obs = observation([
      node({ role: 'link', name: 'Home', frameIndex: 1, framePath: [{ by: 'name', name: 'navFrame' }] }),
      node({ role: 'link', name: 'Home', frameIndex: 2, framePath: [{ by: 'name', name: 'mainFrame' }] }),
    ]);

    const res = resolveTarget(
      target({
        frame: [{ by: 'name', name: 'mainFrame' }],
        strategies: [{ kind: 'roleName', role: 'link', name: 'Home', match: 'exact' }],
      }),
      obs,
      { bindings },
    );

    assert.equal(res.ok, true);
    assert.equal(res.ok && res.node.frameIndex, 2);
  });
});

describe('capture', () => {
  test('adds a row scope rather than accepting a positional CSS match', () => {
    // The regression this guards: `structural` matches exactly one element via
    // nth-of-type, so an unscoped descriptor "verifies" at record time and then
    // resolves to that row position forever, ignoring the parameter entirely.
    const obs = gridObservation([
      ['12345', 'Whitfield, Dana', 'ACTIVE'],
      ['41120', 'Whitfield-Cruz, Dana', 'DORMANT'],
    ]);
    const viewLink = obs.nodes.find((n) => n.role === 'link' && n.table?.rowCells[0] === '12345')!;

    const cap = captureTarget(viewLink, obs, { paramValues: { memberId: '12345' } });

    assert.equal(cap.verified, true);
    assert.equal(cap.target.scope?.kind, 'tableRow');
    assert.deepEqual(
      cap.target.scope?.kind === 'tableRow' ? cap.target.scope.matchValue : null,
      { param: 'memberId' },
      'the anchor must be a parameter reference, not the literal recorded value',
    );
    assert.ok(
      !cap.target.strategies.some((s) => s.kind === 'structural'),
      'a row-scoped descriptor must not retain a positional fallback',
    );

    // And it must actually follow the parameter.
    const other = resolveTarget(cap.target, obs, { bindings: { params: { memberId: '41120' }, outputs: {} } });
    assert.equal(other.ok, true);
    assert.equal(other.ok && other.node.table!.rowCells[0], '41120');
  });

  test('records the winning rank as a drift baseline', () => {
    const obs = observation([
      node({ role: 'textbox', name: 'Member ID', nameSource: 'adjacentCell', formFieldName: 'memberId', tag: 'input' }),
    ]);
    const cap = captureTarget(obs.nodes[0]!, obs, {});
    assert.equal(cap.verified, true);
    assert.equal(cap.target.recordedStrategy, 'formField');
    assert.equal(cap.target.recordedRank, 2);
  });

  test('leaves a simple unique control unscoped', () => {
    const obs = observation([node({ role: 'button', name: 'Search', nameSource: 'value', tag: 'input' })]);
    const cap = captureTarget(obs.nodes[0]!, obs, {});
    assert.equal(cap.verified, true);
    assert.equal(cap.target.scope, undefined);
  });
});
