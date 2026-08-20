import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import {
  fingerprint,
  baselineRelativePath,
  loadBaseline,
  applyBaseline,
  buildBaselineFile,
  writeBaselineFile,
} from '../src/baseline.js';

const rootIndex = resolve(process.cwd(), 'index.js');

function located(items) {
  return items.map(([file, id, path, extra = {}]) => ({
    file,
    finding: { id, path, severity: 'warn', message: 'm', pack: 'default', ...extra },
  }));
}

describe('baseline fingerprint', () => {
  test('is (rule, file, path) and excludes the value', () => {
    const a = fingerprint({ rule: 'pool-size-jump', file: 'c.yaml', path: 'db.pool' });
    const b = fingerprint({ rule: 'pool-size-jump', file: 'c.yaml', path: 'db.pool' });
    assert.equal(a, b, 'same rule/file/path fingerprints identically regardless of value');
    assert.notEqual(a, fingerprint({ rule: 'pool-size-jump', file: 'c.yaml', path: 'db.other' }));
    assert.notEqual(a, fingerprint({ rule: 'other', file: 'c.yaml', path: 'db.pool' }));
    assert.notEqual(a, fingerprint({ rule: 'pool-size-jump', file: 'other.yaml', path: 'db.pool' }));
  });

  test('baselineRelativePath is repo-relative and POSIX', () => {
    assert.equal(baselineRelativePath('/repo/config/prod.yaml', '/repo'), 'config/prod.yaml');
    // Outside the cwd: keep the path but POSIX-slash it, never crash.
    assert.equal(baselineRelativePath('/elsewhere/x.yaml', '/repo'), '/elsewhere/x.yaml');
  });
});

describe('applyBaseline', () => {
  const run = located([
    ['c.yaml', 'pool-size-jump', 'db.pool'],
    ['c.yaml', 'secret-key-changed', 'api_key'],
  ]);

  test('with an empty baseline, every finding is active', () => {
    const { active, accepted, stale } = applyBaseline(run, new Map());
    assert.equal(active.length, 2);
    assert.equal(accepted.length, 0);
    assert.equal(stale.length, 0);
  });

  test('records suppress matching findings from the active set', () => {
    const baseline = new Map([[
      fingerprint({ rule: 'pool-size-jump', file: 'c.yaml', path: 'db.pool' }),
      { rule: 'pool-size-jump', file: 'c.yaml', path: 'db.pool' },
    ]]);
    const { active, accepted, stale } = applyBaseline(run, baseline);
    assert.deepEqual(active.map((a) => a.finding.id), ['secret-key-changed']);
    assert.deepEqual(accepted.map((a) => a.finding.id), ['pool-size-jump']);
    assert.equal(stale.length, 0);
  });

  test('a recorded finding that no longer occurs is stale', () => {
    const baseline = new Map([[
      fingerprint({ rule: 'gone-rule', file: 'c.yaml', path: 'x' }),
      { rule: 'gone-rule', file: 'c.yaml', path: 'x' },
    ]]);
    const { active, stale } = applyBaseline(run, baseline);
    assert.equal(active.length, 2, 'unrecorded findings stay active');
    assert.deepEqual(stale.map((s) => s.rule), ['gone-rule']);
  });
});

describe('buildBaselineFile', () => {
  test('one entry per fingerprint, sorted by (file, rule, path)', () => {
    const run = located([
      ['z.yaml', 'b-rule', 'p'],
      ['a.yaml', 'b-rule', 'p'],
      ['a.yaml', 'a-rule', 'p'],
      ['a.yaml', 'b-rule', 'p'], // duplicate fingerprint
    ]);
    const file = buildBaselineFile(run, new Map(), { now: '2026-01-01T00:00:00.000Z' });
    assert.equal(file.version, 1);
    assert.deepEqual(
      file.findings.map((f) => `${f.file}:${f.rule}`),
      ['a.yaml:a-rule', 'a.yaml:b-rule', 'z.yaml:b-rule'],
    );
  });

  test('preserves acceptedAt and reason of an entry that persists', () => {
    const run = located([['c.yaml', 'pool-size-jump', 'db.pool', { message: 'now 5→120' }]]);
    const previous = new Map([[
      fingerprint({ rule: 'pool-size-jump', file: 'c.yaml', path: 'db.pool' }),
      {
        rule: 'pool-size-jump', file: 'c.yaml', path: 'db.pool',
        acceptedAt: '2020-01-01T00:00:00.000Z', reason: 'load test',
      },
    ]]);
    const file = buildBaselineFile(run, previous, { now: '2026-01-01T00:00:00.000Z' });
    assert.equal(file.findings[0].acceptedAt, '2020-01-01T00:00:00.000Z', 'provenance kept');
    assert.equal(file.findings[0].reason, 'load test', 'reason kept');
    assert.equal(file.findings[0].message, 'now 5→120', 'message refreshed to current');
  });

  test('a brand-new finding is stamped with now', () => {
    const run = located([['c.yaml', 'new-rule', 'p']]);
    const file = buildBaselineFile(run, new Map(), { now: '2026-01-01T00:00:00.000Z' });
    assert.equal(file.findings[0].acceptedAt, '2026-01-01T00:00:00.000Z');
  });
});

describe('loadBaseline', () => {
  test('a missing file reads as empty and is not an error', () => {
    const { entries, existed } = loadBaseline('/no/such/baseline.json');
    assert.equal(entries.size, 0);
    assert.equal(existed, false);
  });

  test('a malformed file is an error, not silently empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-baseline-bad-'));
    try {
      const path = join(dir, 'b.json');
      writeFileSync(path, '{ not json', 'utf8');
      assert.throws(() => loadBaseline(path), /not valid JSON/);
      writeFileSync(path, JSON.stringify({ version: 1 }), 'utf8');
      assert.throws(() => loadBaseline(path), /malformed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('round-trips through writeBaselineFile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-baseline-rt-'));
    try {
      const path = join(dir, 'b.json');
      const run = located([['c.yaml', 'r', 'p']]);
      writeBaselineFile(path, buildBaselineFile(run, new Map(), { now: '2026-01-01T00:00:00.000Z' }));
      assert.ok(readFileSync(path, 'utf8').endsWith('\n'), 'trailing newline for clean diffs');
      const { entries, existed } = loadBaseline(path);
      assert.equal(existed, true);
      assert.equal(entries.size, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('flecto ci --baseline (end to end)', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-baseline-e2e-'));
    writeFileSync(join(dir, 'config.yaml'), 'database:\n  pool_size: 100\nlogging:\n  debug: true\n', 'utf8');
    writeFileSync(
      join(dir, 'snap.json'),
      JSON.stringify({ state: { database: { pool_size: 5 }, logging: { debug: false } } }),
      'utf8',
    );
    return dir;
  }

  function ci(dir, args) {
    return spawnSync(
      process.execPath,
      [rootIndex, 'ci', 'config.yaml', '--snapshot-ref', 'snap.json', ...args],
      { cwd: dir, encoding: 'utf8' },
    );
  }

  test('records, then gates only on new findings', () => {
    const dir = setup();
    try {
      // Without a baseline the findings fail the gate.
      assert.equal(ci(dir, ['--fail-on', 'policy']).status, 1);

      // Record: writes the file and passes (current state accepted).
      const rec = ci(dir, ['--baseline', '.flecto-baseline.json', '--update-baseline', '--fail-on', 'policy']);
      assert.equal(rec.status, 0, rec.stderr);
      assert.ok(existsSync(join(dir, '.flecto-baseline.json')));

      // Re-run gated: passes, and the accepted findings are suppressed from output.
      const gated = ci(dir, ['--baseline', '.flecto-baseline.json', '--fail-on', 'policy', '--format', 'json']);
      assert.equal(gated.status, 0, gated.stderr);
      const findings = JSON.parse(gated.stdout).reduce((n, r) => n + r.policies.length, 0);
      assert.equal(findings, 0, 'baselined findings do not appear in output');

      // A new finding fails and is shown; the baselined ones stay quiet.
      writeFileSync(
        join(dir, 'config.yaml'),
        'database:\n  pool_size: 100\nlogging:\n  debug: true\napi_key: sk-live-AKIAIOSFODNN7EXAMPLE9\n',
        'utf8',
      );
      const failed = ci(dir, ['--baseline', '.flecto-baseline.json', '--fail-on', 'policy', '--format', 'json']);
      assert.equal(failed.status, 1);
      const ids = JSON.parse(failed.stdout).flatMap((r) => r.policies.map((p) => p.id));
      assert.deepEqual([...new Set(ids)], ['secret-key-changed']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a value change on an accepted finding stays accepted', () => {
    const dir = setup();
    try {
      ci(dir, ['--baseline', '.flecto-baseline.json', '--update-baseline', '--fail-on', 'policy']);
      writeFileSync(join(dir, 'config.yaml'), 'database:\n  pool_size: 250\nlogging:\n  debug: true\n', 'utf8');
      const run = ci(dir, ['--baseline', '.flecto-baseline.json', '--fail-on', 'policy']);
      assert.equal(run.status, 0, 'a bigger pool jump is the same finding, still accepted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reports stale entries and prunes them on update', () => {
    const dir = setup();
    try {
      ci(dir, ['--baseline', '.flecto-baseline.json', '--update-baseline', '--fail-on', 'policy']);
      // Remove the pool jump so its recorded finding no longer occurs.
      writeFileSync(join(dir, 'config.yaml'), 'database:\n  pool_size: 5\nlogging:\n  debug: true\n', 'utf8');
      const stale = ci(dir, ['--baseline', '.flecto-baseline.json', '--fail-on', 'policy']);
      assert.match(stale.stderr, /1 baseline entry no longer occurs/);

      ci(dir, ['--baseline', '.flecto-baseline.json', '--update-baseline', '--fail-on', 'policy']);
      const pruned = JSON.parse(readFileSync(join(dir, '.flecto-baseline.json'), 'utf8'));
      assert.ok(!pruned.findings.some((f) => f.rule === 'pool-size-jump'), 'stale entry pruned');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--update-baseline without --baseline is an error', () => {
    const dir = setup();
    try {
      const run = ci(dir, ['--update-baseline', '--fail-on', 'policy']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /--update-baseline requires --baseline/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a change-based trigger still fires under a baseline that accepts all findings', () => {
    const dir = setup();
    try {
      ci(dir, ['--baseline', '.flecto-baseline.json', '--update-baseline', '--fail-on', 'policy']);
      // Findings all accepted, but --fail-on changed is about the diff, not findings.
      const run = ci(dir, ['--baseline', '.flecto-baseline.json', '--fail-on', 'changed']);
      assert.equal(run.status, 1, 'baseline suppresses findings, not the change gate');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
