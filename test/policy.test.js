import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  test('derives an id for local packs that omit one', () => {
    withLocalPack('missing-id', {
      rules: [{ id: 'valid-rule', severity: 'warn' }],
    }, (cwd) => {
      assert.equal(loadPack('missing-id', cwd).id, 'missing-id');
    });
  });

  test('rejects invalid rule severity with rule id and field', () => {
    withLocalPack('bad-severity', {
      id: 'bad-severity',
      rules: [{ id: 'broken-rule', severity: 'critical' }],
    }, (cwd) => {
      assert.throws(
        () => loadPack('bad-severity', cwd),
        /rule "broken-rule"\.severity must be one of/,
      );
    });
  });

  test('rejects invalid rule when values', () => {
    withLocalPack('bad-when', {
      id: 'bad-when',
      rules: [{ id: 'broken-rule', severity: 'warn', when: ['updated'] }],
    }, (cwd) => {
      assert.throws(
        () => loadPack('bad-when', cwd),
        /rule "broken-rule"\.when\[0\] must be one of/,
      );
    });
  });

  test('rejects unknown rule predicate fields', () => {
    withLocalPack('unknown-field', {
      id: 'unknown-field',
      rules: [{ id: 'broken-rule', severity: 'warn', matches: { path: 'x' } }],
    }, (cwd) => {
      assert.throws(
        () => loadPack('unknown-field', cwd),
        /rule "broken-rule"\.matches is not allowed/,
      );
    });
  });

  test('rejects invalid match regular expressions on load', () => {
    withLocalPack('invalid-regexp', {
      id: 'invalid-regexp',
      rules: [{ id: 'broken-rule', severity: 'warn', match: { path: '[' } }],
    }, (cwd) => {
      assert.throws(
        () => loadPack('invalid-regexp', cwd),
        /rule "broken-rule"\.match\.path must be a valid regular expression/,
      );
    });
  });

  test('rejects invalid match.pathFlags on load', () => {
    withLocalPack('invalid-flags', {
      id: 'invalid-flags',
      rules: [{ id: 'broken-rule', severity: 'warn', match: { path: 'a', pathFlags: 'z' } }],
    }, (cwd) => {
      assert.throws(
        () => loadPack('invalid-flags', cwd),
        /rule "broken-rule"\.match\.pathFlags must be valid regular expression flags/,
      );
    });
  });

  test('accepts match.path patterns that require pathFlags', () => {
    withLocalPack('flagged-regexp', {
      id: 'flagged-regexp',
      rules: [
        { id: 'unicode-prop', severity: 'warn', match: { path: String.raw`\p{L}+`, pathFlags: 'u' } },
        { id: 'unicode-set', severity: 'warn', match: { path: '[a--b]', pathFlags: 'v' } },
      ],
    }, (cwd) => {
      const pack = loadPack('flagged-regexp', cwd);
      assert.equal(pack.rules.length, 2);
    });
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

/**
 * @param {string} id
 * @param {unknown} pack
 * @param {(cwd: string) => void} run
 */
function withLocalPack(id, pack, run) {
  const cwd = mkdtempSync(join(tmpdir(), 'flecto-policy-'));
  try {
    const policies = join(cwd, 'policies');
    mkdirSync(policies);
    writeFileSync(join(policies, `${id}.json`), JSON.stringify(pack));
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
