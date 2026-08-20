import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { buildSarif } from '../src/sarif.js';

const rootIndex = resolve(process.cwd(), 'index.js');

/**
 * Structural validation of a SARIF 2.1.0 log. This asserts the invariants GitHub
 * code scanning actually enforces — the ones that make it reject a file with its
 * famously unhelpful error — rather than running the full JSON Schema (which
 * would mean a new devDependency and a vendored 500 KB schema; see the PR).
 * @param {any} log
 */
function assertValidSarif(log) {
  assert.equal(typeof log, 'object');
  assert.equal(log.version, '2.1.0');
  assert.equal(typeof log.$schema, 'string');
  assert.ok(Array.isArray(log.runs) && log.runs.length >= 1, 'runs[] required');

  for (const run of log.runs) {
    const driver = run.tool?.driver;
    assert.ok(driver, 'tool.driver required');
    assert.equal(typeof driver.name, 'string');
    assert.ok(Array.isArray(driver.rules), 'driver.rules required');

    const ruleIds = new Set();
    driver.rules.forEach((rule, i) => {
      assert.equal(typeof rule.id, 'string', `rules[${i}].id`);
      assert.ok(rule.id.length > 0);
      assert.ok(!ruleIds.has(rule.id), `duplicate rule descriptor ${rule.id}`);
      ruleIds.add(rule.id);
      assert.equal(typeof rule.shortDescription?.text, 'string');
    });

    assert.ok(Array.isArray(run.results), 'run.results required');
    for (const [i, result] of run.results.entries()) {
      assert.equal(typeof result.ruleId, 'string', `results[${i}].ruleId`);
      assert.ok(ruleIds.has(result.ruleId), `results[${i}].ruleId has no descriptor`);
      assert.ok(['error', 'warning', 'note', 'none'].includes(result.level), `results[${i}].level`);
      // ruleIndex, when present, must point at the matching descriptor.
      if (result.ruleIndex !== undefined) {
        assert.equal(driver.rules[result.ruleIndex]?.id, result.ruleId, `results[${i}].ruleIndex`);
      }
      assert.equal(typeof result.message?.text, 'string', `results[${i}].message.text`);
      assert.ok(Array.isArray(result.locations) && result.locations.length >= 1);
      const phys = result.locations[0].physicalLocation;
      assert.equal(typeof phys?.artifactLocation?.uri, 'string');
      // GitHub requires a region with a positive startLine.
      assert.ok(Number.isInteger(phys.region?.startLine) && phys.region.startLine >= 1);
      // URIs must be relative for GitHub to map them onto the tree.
      assert.ok(!phys.artifactLocation.uri.startsWith('/'), `absolute uri: ${phys.artifactLocation.uri}`);
      assert.ok(!/^[a-zA-Z]:[\\/]/.test(phys.artifactLocation.uri), 'windows-absolute uri');
    }
  }
}

describe('buildSarif', () => {
  const findings = [
    { id: 'secret-key-changed', severity: 'error', path: 'api_key', message: 'Secret changed.', pack: 'default' },
    { id: 'pool-size-jump', severity: 'warn', path: 'database.pool_size', message: 'Pool jumped 5→100.', pack: 'default' },
    { id: 'note-rule', severity: 'info', path: 'meta.tag', message: 'FYI.', pack: 'custom' },
  ];

  test('produces a schema-valid log with one descriptor per rule', () => {
    const log = buildSarif(
      [{ file: '/repo/config.yaml', policies: findings }],
      { cwd: '/repo', toolVersion: '9.9.9' },
    );
    assertValidSarif(log);
    assert.equal(log.runs[0].tool.driver.version, '9.9.9');
    assert.equal(log.runs[0].tool.driver.rules.length, 3);
    assert.equal(log.runs[0].results.length, 3);
  });

  test('maps severities to SARIF levels', () => {
    const log = buildSarif([{ file: '/repo/c.yaml', policies: findings }], { cwd: '/repo' });
    const byRule = Object.fromEntries(log.runs[0].results.map((r) => [r.ruleId, r.level]));
    assert.equal(byRule['secret-key-changed'], 'error');
    assert.equal(byRule['pool-size-jump'], 'warning');
    assert.equal(byRule['note-rule'], 'note');
  });

  test('carries the pack on the rule descriptor and the semantic path as a logical location', () => {
    const log = buildSarif([{ file: '/repo/c.yaml', policies: findings }], { cwd: '/repo' });
    const rule = log.runs[0].tool.driver.rules.find((r) => r.id === 'pool-size-jump');
    assert.equal(rule.properties.pack, 'default');
    const result = log.runs[0].results.find((r) => r.ruleId === 'pool-size-jump');
    assert.equal(result.locations[0].logicalLocations[0].fullyQualifiedName, 'database.pool_size');
  });

  test('a rule seen on two files gets one descriptor and two results', () => {
    const log = buildSarif([
      { file: '/repo/a.yaml', policies: [findings[0]] },
      { file: '/repo/b.yaml', policies: [findings[0]] },
    ], { cwd: '/repo' });
    assertValidSarif(log);
    assert.equal(log.runs[0].tool.driver.rules.length, 1);
    assert.equal(log.runs[0].results.length, 2);
    assert.deepEqual(
      log.runs[0].results.map((r) => r.locations[0].physicalLocation.artifactLocation.uri).sort(),
      ['a.yaml', 'b.yaml'],
    );
  });

  test('uris are repo-relative and POSIX-slashed', () => {
    const log = buildSarif(
      [{ file: '/repo/config/prod.yaml', policies: [findings[0]] }],
      { cwd: '/repo' },
    );
    assert.equal(log.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, 'config/prod.yaml');
  });

  test('a file outside the cwd falls back to its basename, never an absolute path', () => {
    const log = buildSarif(
      [{ file: '/elsewhere/secret.yaml', policies: [findings[0]] }],
      { cwd: '/repo' },
    );
    assert.equal(log.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, 'secret.yaml');
    assertValidSarif(log);
  });

  test('no findings still yields a valid, empty run', () => {
    const log = buildSarif([{ file: '/repo/c.yaml', policies: [] }], { cwd: '/repo' });
    assertValidSarif(log);
    assert.equal(log.runs[0].results.length, 0);
    assert.equal(log.runs[0].tool.driver.rules.length, 0);
  });
});

describe('flecto ci --format sarif', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-sarif-'));
    writeFileSync(
      join(dir, 'config.yaml'),
      'database:\n  pool_size: 100\n  password: hunter2verysecret\napi_key: sk-live-AKIAIOSFODNN7EXAMPLE\n',
      'utf8',
    );
    writeFileSync(
      join(dir, 'snap.json'),
      JSON.stringify({ state: { database: { pool_size: 5, password: 'old' }, api_key: 'old' } }),
      'utf8',
    );
    return dir;
  }

  test('emits a schema-valid SARIF log', () => {
    const dir = setup();
    try {
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'ci', 'config.yaml', '--snapshot-ref', 'snap.json', '--format', 'sarif', '--fail-on', ''],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(run.status, 0, run.stderr);
      const log = JSON.parse(run.stdout);
      assertValidSarif(log);
      assert.ok(log.runs[0].results.length >= 1);
      assert.equal(log.runs[0].tool.driver.name, 'Flecto');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--mask-secrets keeps sensitive values out of the SARIF file', () => {
    const dir = setup();
    try {
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'ci', 'config.yaml', '--snapshot-ref', 'snap.json', '--format', 'sarif', '--mask-secrets', '--fail-on', ''],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.doesNotMatch(run.stdout, /hunter2verysecret|AKIAIOSFODNN7EXAMPLE/);
      assertValidSarif(JSON.parse(run.stdout));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unknown --format is rejected with sarif listed', () => {
    const dir = setup();
    try {
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'ci', 'config.yaml', '--snapshot-ref', 'snap.json', '--format', 'nope'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(run.status, 1);
      assert.match(run.stderr, /sarif/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
