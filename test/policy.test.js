import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicies, highestSeverity, mergeFindings, loadPack } from '../src/policy.js';

describe('policy engine', () => {
  test('flags secret-looking key changes', async () => {
    const findings = await evaluatePolicies([
      { type: 'changed', path: 'auth.api_key', before: 'a', after: 'b' },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'error');
    assert.equal(findings[0].pack, 'default');
  });

  test('flags secret-looking keys that are newly added', async () => {
    const findings = await evaluatePolicies([
      { type: 'added', path: 'auth.api_key', after: 'new-secret' },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, 'secret-key-changed');
    assert.equal(findings[0].severity, 'error');
  });

  test('flags large pool size increase', async () => {
    const findings = await evaluatePolicies([
      { type: 'changed', path: 'database.pool_size', before: 10, after: 40 },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'warn');
  });

  test('flags dangerous toggles set to boolean true', async () => {
    const findings = await evaluatePolicies([
      { type: 'changed', path: 'debug', before: false, after: true },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, 'dangerous-toggle-enabled');
  });

  test('flags dangerous toggles set to truthy strings', async () => {
    for (const value of ['true', '1', 'yes']) {
      const findings = await evaluatePolicies([
        { type: 'changed', path: 'debug', before: 'false', after: value },
      ]);
      assert.equal(findings.length, 1, `expected ${value} to match`);
      assert.equal(findings[0].id, 'dangerous-toggle-enabled');
    }
  });

  test('does not flag dangerous toggles set to false values', async () => {
    for (const value of [false, 'false']) {
      const findings = await evaluatePolicies([
        { type: 'changed', path: 'debug', before: true, after: value },
      ]);
      assert.equal(findings.length, 0, `expected ${String(value)} not to match`);
    }
  });

  test('computes highest severity', () => {
    const sev = highestSeverity([
      { id: 'a', severity: 'info', path: 'x', message: 'i' },
      { id: 'b', severity: 'warn', path: 'y', message: 'w' },
    ]);
    assert.equal(sev, 'warn');
  });

  test('unknown pack id fails closed', () => {
    assert.throws(() => loadPack('does-not-exist'), /Unknown policy pack/);
  });

  test('mergeFindings keeps highest severity for same id+path', () => {
    const merged = mergeFindings([
      { id: 'secret-key-changed', severity: 'warn', path: 'a.token', message: 'w', pack: 'a' },
      { id: 'secret-key-changed', severity: 'error', path: 'a.token', message: 'e', pack: 'b' },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].severity, 'error');
    assert.equal(merged[0].pack, 'b');
  });

  test('strict-prod raises pool jump to error', async () => {
    const findings = await evaluatePolicies(
      [{ type: 'changed', path: 'database.pool_size', before: 10, after: 40 }],
      { policies: ['strict-prod'] },
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'error');
    assert.equal(findings[0].pack, 'strict-prod');
  });
});
