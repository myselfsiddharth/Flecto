import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

import { assertExpectedFindings, testPolicyFixture } from '../src/policy-test.js';

const fixtureDir = resolve('examples/fixtures/policies');

test('policy fixture tests built-in packs and the async plugin', async () => {
  const result = await testPolicyFixture(fixtureDir);

  assert.equal(result.changes.length, 4);
  assert.deepEqual(
    result.findings.map(({ id, severity, path }) => ({ id, severity, path })),
    [
      { id: 'secret-key-changed', severity: 'error', path: 'auth.api_key' },
      { id: 'dangerous-toggle-enabled', severity: 'error', path: 'features.debug' },
      { id: 'pool-size-jump', severity: 'warn', path: 'database.pool_size' },
      {
        id: 'rollout-unavailability-increased',
        severity: 'warn',
        path: 'deployment.rollout.maxUnavailable',
      },
      {
        id: 'async-rollout-approval',
        severity: 'error',
        path: 'deployment.rollout.maxUnavailable',
      },
    ],
  );
});

test('policy fixture CLI reports success', () => {
  const run = spawnSync(
    process.execPath,
    [resolve('index.js'), 'policies', 'test', fixtureDir],
    { encoding: 'utf8' },
  );

  assert.equal(run.status, 0);
  assert.match(run.stdout, /Policy fixture passed/);
  assert.match(run.stdout, /5 findings/);
});

test('policy fixture mismatch errors name missing and unexpected findings', () => {
  assert.throws(
    () => assertExpectedFindings(
      [{ id: 'actual-rule', severity: 'warn', path: 'actual.path', message: '' }],
      [{ id: 'expected-rule', severity: 'error', path: 'expected.path' }],
    ),
    /Missing findings:\n  - error expected-rule at expected\.path\nUnexpected findings:\n  - warn actual-rule at actual\.path/,
  );
});

test('policy fixture CLI identifies missing and unexpected findings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-policy-fixture-'));
  try {
    writeFileSync(join(dir, 'baseline.json'), JSON.stringify({ state: { auth: { api_key: 'old' } } }));
    writeFileSync(join(dir, 'current.json'), JSON.stringify({ auth: { api_key: 'new' } }));
    writeFileSync(join(dir, 'flecto-policy-test.json'), JSON.stringify({
      policies: ['default'],
      expected: [{ id: 'wrong-rule', severity: 'warn', path: 'auth.api_key' }],
    }));

    const run = spawnSync(
      process.execPath,
      [resolve('index.js'), 'policies', 'test', dir],
      { encoding: 'utf8' },
    );

    assert.equal(run.status, 1);
    assert.match(run.stderr, /Missing findings:\n  - warn wrong-rule at auth\.api_key/);
    assert.match(run.stderr, /Unexpected findings:\n  - error secret-key-changed at auth\.api_key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
