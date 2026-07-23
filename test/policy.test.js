import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluatePolicies, highestSeverity, mergeFindings, loadPack } from '../src/policy.js';

async function evaluateCustomPack(rules, changes) {
  const cwd = mkdtempSync(join(tmpdir(), 'flecto-policy-'));
  try {
    const policiesDir = join(cwd, 'policies');
    mkdirSync(policiesDir);
    writeFileSync(join(policiesDir, 'test.json'), JSON.stringify({ id: 'test', rules }));
    return await evaluatePolicies(changes, { cwd, policies: ['test'] });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

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

  test('matches beforeEquals and afterIn value predicates', async () => {
    const findings = await evaluateCustomPack([{
      id: 'value-transition',
      severity: 'warn',
      beforeEquals: 'draft',
      afterIn: ['review', 'published'],
    }], [{ type: 'changed', path: 'status', before: 'draft', after: 'review' }]);
    assert.equal(findings.length, 1);
  });

  test('matches beforeIn and absolute numericDelta predicates', async () => {
    const findings = await evaluateCustomPack([{
      id: 'large-rollback',
      severity: 'warn',
      beforeIn: [100, 200],
      numericDelta: { min: 50 },
    }], [{ type: 'changed', path: 'limits.requests', before: 100, after: 40 }]);
    assert.equal(findings.length, 1);
  });

  test('matches symmetric truthiness predicates', async () => {
    const findings = await evaluateCustomPack([
      { id: 'was-configured', severity: 'info', beforeTruthy: true },
      { id: 'is-configured', severity: 'info', afterTruthy: true },
    ], [{ type: 'changed', path: 'feature.enabled', before: true, after: 'yes' }]);
    assert.deepEqual(findings.map((finding) => finding.id), ['was-configured', 'is-configured']);
  });

  test('matches exact and prefixed paths without regular expressions', async () => {
    const findings = await evaluateCustomPack([
      { id: 'exact-path', severity: 'warn', match: { pathEquals: 'database.pool_size' } },
      { id: 'path-prefix', severity: 'warn', match: { pathPrefix: 'services.api.' } },
    ], [
      { type: 'changed', path: 'database.pool_size', before: 10, after: 20 },
      { type: 'changed', path: 'services.api.timeout', before: 10, after: 20 },
    ]);
    assert.deepEqual(findings.map((finding) => finding.id), ['exact-path', 'path-prefix']);
  });

  test('requires every allOf clause and one anyOf clause', async () => {
    const findings = await evaluateCustomPack([{
      id: 'production-danger',
      severity: 'error',
      allOf: [
        { match: { pathPrefix: 'features.' } },
        { afterTruthy: true },
      ],
      anyOf: [
        { afterEquals: 'unsafe' },
        { afterEquals: true },
      ],
    }], [
      { type: 'changed', path: 'features.debug', before: false, after: true },
      { type: 'changed', path: 'features.mode', before: 'safe', after: 'unsafe' },
      { type: 'changed', path: 'other.debug', before: false, after: true },
      { type: 'changed', path: 'features.mode', before: 'safe', after: 'safe' },
    ]);
    assert.equal(findings.length, 2);
  });

  test('fails closed when a pack contains unknown predicate fields', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'flecto-policy-'));
    try {
      const policiesDir = join(cwd, 'policies');
      mkdirSync(policiesDir);
      writeFileSync(join(policiesDir, 'invalid.json'), JSON.stringify({
        id: 'invalid',
        rules: [{ id: 'bad-rule', severity: 'warn', afterEqulas: true }],
      }));
      assert.throws(() => loadPack('invalid', cwd), /unknown field "afterEqulas"/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
