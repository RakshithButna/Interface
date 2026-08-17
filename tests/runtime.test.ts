import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evalValue, BindingError, emptyBindings } from '../src/runtime/bindings.ts';
import { evaluateAssertion } from '../src/runtime/assert.ts';
import { aliasLabel, aliasUrl, aliasTarget, effectiveSteps } from '../src/runtime/overrides.ts';
import { loadTenantOverride, mergeOverrides } from '../src/runtime/tenant-store.ts';
import { A } from '../src/schema/assertions.ts';
import { TenantOverrideSchema, StepSchema, CapabilityArtifactSchema } from '../src/schema/artifact.ts';
import { node, observation } from './helpers.ts';

const B = { params: { memberId: '12345', baseUrl: 'http://app.test/t/westside' }, outputs: { acct: '12345-70' } };

describe('value binding', () => {
  test('resolves literals, params, prior outputs and templates', () => {
    assert.equal(evalValue({ literal: 'x' }, B), 'x');
    assert.equal(evalValue({ param: 'memberId' }, B), '12345');
    assert.equal(evalValue({ fromOutput: 'acct' }, B), '12345-70');
    assert.equal(evalValue({ template: '${baseUrl}/member?id=${memberId}' }, B), 'http://app.test/t/westside/member?id=12345');
  });

  test('a missing parameter fails loudly rather than interpolating empty', () => {
    // Silently producing "/member?id=" would search for nobody and look like
    // a legitimate not-found result, which is the worst possible failure mode.
    assert.throws(() => evalValue({ param: 'nope' }, B), BindingError);
    assert.throws(() => evalValue({ template: '${nope}' }, B), BindingError);
  });

  test('referencing an output before it is produced is an error', () => {
    assert.throws(() => evalValue({ fromOutput: 'later' }, emptyBindings()), BindingError);
  });
});

describe('assertions', () => {
  const obs = observation([
    node({ role: 'heading', name: 'Search Results', frameIndex: 0 }),
    node({ role: 'cell', name: 'No member records matched', text: 'No member records matched', frameIndex: 1, framePath: [{ by: 'name', name: 'mainFrame' }] }),
  ]);

  test('an unframed text assertion searches every frame', () => {
    // This is the behaviour that stops a "record not found" banner rendered in
    // a subframe from being missed by outcome detection.
    const r = evaluateAssertion(A.text('No member records matched'), obs, { bindings: emptyBindings() });
    assert.equal(r.ok, true);
  });

  test('a framed text assertion is confined to that frame', () => {
    const r = evaluateAssertion(
      { kind: 'textPresent', frame: [], text: 'No member records matched', match: 'contains', caseSensitive: false },
      obs,
      { bindings: emptyBindings() },
    );
    assert.equal(r.ok, false);
  });

  test('failure detail names what was expected and what was seen', () => {
    const r = evaluateAssertion(A.text('Sub-Account Opened'), obs, { bindings: emptyBindings() });
    assert.equal(r.ok, false);
    assert.match(r.detail, /expected text "Sub-Account Opened"/);
    assert.match(r.detail, /observed:/);
  });

  test('all / any / not compose', () => {
    const bindings = emptyBindings();
    assert.equal(evaluateAssertion(A.all(A.text('Search Results'), A.text('No member')), obs, { bindings }).ok, true);
    assert.equal(evaluateAssertion(A.all(A.text('Search Results'), A.text('nope')), obs, { bindings }).ok, false);
    assert.equal(evaluateAssertion(A.any(A.text('nope'), A.text('Search Results')), obs, { bindings }).ok, true);
    assert.equal(evaluateAssertion(A.not(A.text('nope')), obs, { bindings }).ok, true);
  });

  test('http status is matched against the observation', () => {
    const denied = observation([node({ role: 'heading', name: 'Access Denied' })], { httpStatus: 403 });
    assert.equal(evaluateAssertion({ kind: 'httpStatus', codes: [403] }, denied, { bindings: emptyBindings() }).ok, true);
    assert.equal(evaluateAssertion({ kind: 'httpStatus', codes: [200] }, denied, { bindings: emptyBindings() }).ok, false);
  });
});

describe('tenant overrides', () => {
  const ov = TenantOverrideSchema.parse({
    tenantId: 'lakeshore',
    baseUrl: 'http://app.test/t/lakeshore',
    labelAliases: { 'Member ID': 'Membership Number', View: 'Open' },
    routeAliases: { 'member-search': 'members/find', member: 'members/detail' },
  });

  test('label aliases translate human text, case-insensitively', () => {
    assert.equal(aliasLabel('Member ID', ov), 'Membership Number');
    assert.equal(aliasLabel('member id', ov), 'Membership Number');
    assert.equal(aliasLabel('Status', ov), 'Status');
  });

  test('route aliases apply longest-first so a prefix cannot clobber a longer slug', () => {
    assert.equal(aliasUrl('/member-search', ov), '/members/find');
  });

  test('aliases rewrite human-facing strategies but never machine identifiers', () => {
    const t = aliasTarget(
      {
        description: 'x',
        frame: [],
        requireUnique: true,
        maxRank: 9,
        strategies: [
          { kind: 'roleName', role: 'link', name: 'View', match: 'exact' },
          { kind: 'formField', name: 'memberId', controlType: 'any' },
        ],
      },
      ov,
    );

    assert.equal(t.strategies[0]!.kind === 'roleName' && t.strategies[0]!.name, 'Open');
    // The form field name is a contract with the SERVER and is identical across
    // installs of one product. Aliasing it would break the very tenant it was
    // meant to fix.
    assert.equal(t.strategies[1]!.kind === 'formField' && t.strategies[1]!.name, 'memberId');
  });

  test('a tenant can disable and insert steps', () => {
    const mkStep = (id: string) =>
      StepSchema.parse({ id, intent: id, action: { type: 'navigate', url: { literal: '/' } } });

    const artifact = {
      steps: [mkStep('a'), mkStep('b'), mkStep('c')],
    } as unknown as Parameters<typeof effectiveSteps>[0];

    const withPatches = TenantOverrideSchema.parse({
      tenantId: 't',
      disableSteps: ['b'],
      insertSteps: [{ before: 'c', step: mkStep('extra') }],
    });

    assert.deepEqual(
      effectiveSteps(artifact, withPatches).map((s) => s.id),
      ['a', 'extra', 'c'],
    );
  });
});

describe('tenant override sources', () => {
  test('the shipped lakeshore override loads and covers the relabelled fields', () => {
    const ov = loadTenantOverride('memberfirst-core', 'lakeshore');
    assert.ok(ov, 'config/tenants/memberfirst-core/lakeshore.json should exist');
    assert.equal(ov!.labelAliases['Member ID'], 'Membership Number');
    assert.equal(ov!.routeAliases['member-search'], 'members/find');
  });

  test('an unconfigured tenant simply has no override', () => {
    assert.equal(loadTenantOverride('memberfirst-core', 'nosuchtenant'), undefined);
  });

  test('capability-level overrides merge over product-level ones', () => {
    const base = TenantOverrideSchema.parse({
      tenantId: 'lakeshore',
      labelAliases: { 'Member ID': 'Membership Number', View: 'Open' },
      routeAliases: { member: 'members/detail' },
    });
    const specific = TenantOverrideSchema.parse({
      tenantId: 'lakeshore',
      labelAliases: { View: 'Select' },
    });

    const merged = mergeOverrides(base, specific)!;
    // The tenant's vocabulary is inherited...
    assert.equal(merged.labelAliases['Member ID'], 'Membership Number');
    assert.equal(merged.routeAliases['member'], 'members/detail');
    // ...and the more specific declaration wins where they disagree.
    assert.equal(merged.labelAliases['View'], 'Select');
  });

  test('merging is a no-op when only one source exists', () => {
    const only = TenantOverrideSchema.parse({ tenantId: 't', labelAliases: { a: 'b' } });
    assert.deepEqual(mergeOverrides(undefined, only), only);
    assert.deepEqual(mergeOverrides(only, undefined), only);
    assert.equal(mergeOverrides(undefined, undefined), undefined);
  });
});

describe('artifact schema', () => {
  test('rejects a capability name that is not dotted and lowercase', () => {
    assert.throws(() =>
      CapabilityArtifactSchema.parse({
        schemaVersion: '1.0.0',
        name: 'NotDotted',
        version: '1.0.0',
        title: 't',
        description: 'd',
        app: { productId: 'p', baseUrl: 'http://x' },
        steps: [{ id: 's', intent: 'i', action: { type: 'navigate', url: { literal: '/' } } }],
        successCheckpoint: { kind: 'textPresent', text: 'x', match: 'contains', caseSensitive: false },
        provenance: {
          discoveryRunId: 'r',
          recordedAt: 'now',
          model: 'm',
          provider: 'p',
          goal: 'g',
          recordedOnTenant: 't',
        },
      }),
    );
  });

  test('requires at least one step', () => {
    assert.throws(() =>
      CapabilityArtifactSchema.parse({
        schemaVersion: '1.0.0',
        name: 'a.b',
        version: '1.0.0',
        title: 't',
        description: 'd',
        app: { productId: 'p', baseUrl: 'http://x' },
        steps: [],
        successCheckpoint: { kind: 'textPresent', text: 'x', match: 'contains', caseSensitive: false },
        provenance: {
          discoveryRunId: 'r',
          recordedAt: 'now',
          model: 'm',
          provider: 'p',
          goal: 'g',
          recordedOnTenant: 't',
        },
      }),
    );
  });
});
