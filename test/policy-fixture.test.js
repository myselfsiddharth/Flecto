import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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

test('a fixture resolves packs installed in the invoking project (#114)', async () => {
  const project = mkdtempSync(join(tmpdir(), 'flecto-fixture-project-'));
  try {
    // A pack where `policies add` puts it: the project's policies/ directory.
    mkdirSync(join(project, 'policies'), { recursive: true });
    writeFileSync(
      join(project, 'policies', 'acme.json'),
      JSON.stringify({
        id: 'acme',
        rules: [{
          id: 'acme-pool-size',
          severity: 'warn',
          match: { pathEquals: 'database.pool_size' },
          message: 'Pool size changed.',
        }],
      }),
      'utf8',
    );

    // The fixture lives elsewhere and ships no policies/ of its own.
    const fx = mkdtempSync(join(tmpdir(), 'flecto-fixture-'));
    try {
      writeFileSync(join(fx, 'baseline.json'), JSON.stringify({ database: { pool_size: 5 } }), 'utf8');
      writeFileSync(join(fx, 'current.json'), JSON.stringify({ database: { pool_size: 50 } }), 'utf8');
      writeFileSync(
        join(fx, 'flecto-policy-test.json'),
        JSON.stringify({
          policies: ['acme'],
          expected: [{ id: 'acme-pool-size', severity: 'warn', path: 'database.pool_size' }],
        }),
        'utf8',
      );

      const result = await testPolicyFixture(fx, { cwd: project });
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].id, 'acme-pool-size');
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('a fixture pack shadows a same-named project pack (#114)', async () => {
  const project = mkdtempSync(join(tmpdir(), 'flecto-fixture-shadow-project-'));
  const fx = mkdtempSync(join(tmpdir(), 'flecto-fixture-shadow-'));
  try {
    for (const [root, severity] of [[project, 'error'], [fx, 'warn']]) {
      mkdirSync(join(root, 'policies'), { recursive: true });
      writeFileSync(
        join(root, 'policies', 'dup.json'),
        JSON.stringify({
          id: 'dup',
          rules: [{
            id: 'dup-rule',
            severity,
            match: { pathEquals: 'a' },
            message: 'changed',
          }],
        }),
        'utf8',
      );
    }
    writeFileSync(join(fx, 'baseline.json'), JSON.stringify({ a: 1 }), 'utf8');
    writeFileSync(join(fx, 'current.json'), JSON.stringify({ a: 2 }), 'utf8');
    writeFileSync(
      join(fx, 'flecto-policy-test.json'),
      JSON.stringify({
        policies: ['dup'],
        expected: [{ id: 'dup-rule', severity: 'warn', path: 'a' }],
      }),
      'utf8',
    );

    const result = await testPolicyFixture(fx, { cwd: project });
    assert.equal(result.findings[0].severity, 'warn', 'the fixture pack must win');
  } finally {
    rmSync(fx, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('an unresolvable pack names every directory it searched (#114)', async () => {
  const fx = mkdtempSync(join(tmpdir(), 'flecto-fixture-missing-'));
  const project = mkdtempSync(join(tmpdir(), 'flecto-fixture-missing-project-'));
  try {
    writeFileSync(join(fx, 'baseline.json'), JSON.stringify({ a: 1 }), 'utf8');
    writeFileSync(join(fx, 'current.json'), JSON.stringify({ a: 2 }), 'utf8');
    writeFileSync(
      join(fx, 'flecto-policy-test.json'),
      JSON.stringify({ policies: ['nope'], expected: [] }),
      'utf8',
    );

    await assert.rejects(
      () => testPolicyFixture(fx, { cwd: project }),
      (err) => {
        assert.match(err.message, /Unknown policy pack "nope"/);
        assert.ok(err.message.includes(join(fx, 'policies')), 'names the fixture dir');
        assert.ok(err.message.includes(join(project, 'policies')), 'names the project dir');
        return true;
      },
    );
  } finally {
    rmSync(fx, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
