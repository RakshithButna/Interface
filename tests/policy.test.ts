import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Redactor } from '../src/policy/redact.ts';
import { Guard } from '../src/policy/guard.ts';
import { classifyRisk } from '../src/policy/risk.ts';
import { DEFAULT_POLICY, PolicyConfigSchema } from '../src/policy/config.ts';
import { node } from './helpers.ts';

describe('redaction', () => {
  const make = () => new Redactor(DEFAULT_POLICY);

  test('a secret is removed entirely, with nothing recoverable', () => {
    const r = make();
    r.register('operatorPassword', 'hunter2-very-secret', 'secret');
    const out = r.text('logging in with hunter2-very-secret now');
    assert.equal(out, 'logging in with [REDACTED:operatorPassword] now');
    assert.ok(!out.includes('secret]') || !out.includes('hunter2'));
    assert.ok(!out.includes('hunter2'));
  });

  test('PII keeps only its last 4 characters so runs stay traceable', () => {
    const r = make();
    r.register('memberId', '123456789', 'pii');
    assert.equal(r.text('serviced member 123456789 today'), 'serviced member ***6789 today');
  });

  test('longest value first, so a short secret cannot leave fragments of a longer one', () => {
    const r = make();
    r.register('short', 'abcd', 'secret');
    r.register('long', 'abcdefgh', 'secret');
    const out = r.text('value=abcdefgh');
    assert.equal(out, 'value=[REDACTED:long]');
    assert.ok(!out.includes('efgh'), 'the tail of the longer secret must not survive');
  });

  test('configured patterns catch shapes that were never registered', () => {
    const r = make();
    assert.match(r.text('ssn on file: 123-45-6789'), /\[REDACTED:ssn\]/);
    assert.match(r.text('card 4111 1111 1111 1111 charged'), /\[REDACTED:card\]/);
  });

  test('deep-redacts nested structures and drops credential-shaped keys', () => {
    const r = make();
    r.register('pw', 'topsecretvalue', 'secret');
    const out = r.value({
      step: 's01',
      password: 'anything at all',
      nested: { list: ['topsecretvalue', 'fine'] },
    }) as Record<string, unknown>;

    assert.equal(out['password'], '[REDACTED]');
    assert.deepEqual((out['nested'] as Record<string, unknown>)['list'], ['[REDACTED:pw]', 'fine']);
    assert.equal(out['step'], 's01');
  });

  test('values shorter than 4 characters are not registered, to avoid shredding logs', () => {
    const r = make();
    r.register('tiny', 'ok', 'pii');
    assert.equal(r.text('ok that is fine'), 'ok that is fine');
  });

  test('a regex with the global flag does not skip matches on repeated calls', () => {
    const r = make();
    const line = 'ssn 111-22-3333';
    assert.equal(r.text(line), r.text(line), 'lastIndex must be reset between calls');
  });
});

describe('allowlist', () => {
  const guard = new Guard(DEFAULT_POLICY, 'unattended');

  test('permits an allowlisted origin and path', () => {
    assert.equal(guard.checkUrl('http://127.0.0.1:4173/t/westside/member-search').allow, true);
  });

  test('refuses a different origin', () => {
    const d = guard.checkUrl('http://evil.example.com/t/westside/');
    assert.equal(d.allow, false);
    assert.match(d.allow === false ? d.reason : '', /not on the allowlist/);
  });

  test('refuses a path outside the permitted pattern', () => {
    assert.equal(guard.checkUrl('http://127.0.0.1:4173/admin').allow, false);
  });

  test("refuses the app's own fault-injection control plane", () => {
    // The agent must not be able to arm its own failures.
    const d = guard.checkUrl('http://127.0.0.1:4173/_control/inject');
    assert.equal(d.allow, false);
    assert.match(d.allow === false ? d.reason : '', /denied pattern/);
  });

  test('refuses an action type policy does not list', () => {
    const restricted = new Guard(
      PolicyConfigSchema.parse({
        ...DEFAULT_POLICY,
        allowlist: { ...DEFAULT_POLICY.allowlist, actions: ['navigate', 'click'] },
      }),
      'unattended',
    );
    const d = restricted.check({ actionType: 'fill', risk: 'safe' });
    assert.equal(d.allow, false);
    assert.equal(d.allow === false && d.code, 'ACTION_TYPE');
  });
});

describe('risk disposition', () => {
  test('irreversible steps escalate rather than proceeding, in both modes', () => {
    for (const mode of ['attended', 'unattended'] as const) {
      const g = new Guard(DEFAULT_POLICY, mode);
      const d = g.check({ actionType: 'click', risk: 'irreversible' });
      assert.equal(d.allow, true);
      assert.equal(d.escalate, true, `${mode} mode must not silently allow an irreversible step`);
    }
  });

  test('safe steps proceed without ceremony', () => {
    const g = new Guard(DEFAULT_POLICY, 'unattended');
    assert.deepEqual(g.check({ actionType: 'click', risk: 'safe' }), { allow: true, escalate: false });
  });

  test('a blocking policy stops the action outright', () => {
    const g = new Guard(
      PolicyConfigSchema.parse({
        ...DEFAULT_POLICY,
        risk: { ...DEFAULT_POLICY.risk, unattended: { safe: 'allow', stateChanging: 'allow', irreversible: 'block' } },
      }),
      'unattended',
    );
    const d = g.check({ actionType: 'click', risk: 'irreversible' });
    assert.equal(d.allow, false);
    assert.equal(d.allow === false && d.code, 'RISK_BLOCKED');
  });
});

describe('risk classification', () => {
  test('a button whose label opens an account is irreversible', () => {
    const { risk } = classifyRisk({ actionType: 'click', node: node({ role: 'button', name: 'Open Account' }) });
    assert.equal(risk, 'irreversible');
  });

  test('search and navigation controls stay safe', () => {
    for (const label of ['Search', 'Find', 'View', 'Cancel', 'Continue']) {
      const { risk } = classifyRisk({ actionType: 'click', node: node({ role: 'button', name: label }) });
      assert.equal(risk, 'safe', `'${label}' should not require approval`);
    }
  });

  test('typing into a field is safe until something is submitted', () => {
    assert.equal(classifyRisk({ actionType: 'fill' }).risk, 'safe');
  });

  test('an unlabelled button is state-changing rather than assumed safe', () => {
    const { risk } = classifyRisk({ actionType: 'click', node: node({ role: 'button', name: '' }) });
    assert.equal(risk, 'stateChanging');
  });

  test('a link named like a transfer is not treated as plain navigation', () => {
    const { risk } = classifyRisk({ actionType: 'click', node: node({ role: 'link', name: 'Transfer Funds' }) });
    assert.notEqual(risk, 'safe');
  });
});
