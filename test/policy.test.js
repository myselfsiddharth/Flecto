import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

  test('remaps a built-in pack rule severity', async () => {
    const findings = await evaluatePolicies(
      [{ type: 'changed', path: 'database.pool_size', before: 10, after: 40 }],
      { severityRemap: { 'pool-size-jump': 'error' } },
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'error');
  });

  test('silences a local pack rule with an off remap', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'flecto-remap-local-'));
    mkdirSync(join(cwd, 'policies'));
    writeFileSync(join(cwd, 'policies', 'local.json'), JSON.stringify({
      id: 'local',
      rules: [{ id: 'noisy-rule', severity: 'warn', match: { path: 'noise' } }],
    }), 'utf8');
    try {
      const findings = await evaluatePolicies(
        [{ type: 'changed', path: 'noise', before: 1, after: 2 }],
        { cwd, policies: ['local'], severityRemap: { 'noisy-rule': 'off' } },
      );
      assert.deepEqual(findings, []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('warns when severityRemap references an unknown pack rule', async () => {
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (message) => warnings.push(message);
    try {
      await evaluatePolicies([], { severityRemap: { 'not-a-rule': 'off' } });
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(warnings, ['Unknown policy rule id in severityRemap: "not-a-rule"']);
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
