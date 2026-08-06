import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const rootIndex = resolve(process.cwd(), 'index.js');

function runCompare(dir, args) {
  return spawnSync(process.execPath, [rootIndex, 'compare', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
}

test('compare exits 0 when both files hold the same config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-compare-match-'));
  const prod = join(dir, 'prod.yaml');
  const staging = join(dir, 'staging.yaml');

  try {
    const content = 'database:\n  host: db.internal\n  pool_size: 5\n';
    writeFileSync(prod, content, 'utf8');
    writeFileSync(staging, content, 'utf8');

    const pair = runCompare(dir, [prod, staging]);
    const self = runCompare(dir, [prod, prod]);

    assert.equal(pair.status, 0);
    assert.match(pair.stdout, /✓ .*staging\.yaml matches .*prod\.yaml — no changes/);
    assert.equal(self.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compare treats fileA as the baseline and says so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-compare-direction-'));
  const prod = join(dir, 'prod.yaml');
  const staging = join(dir, 'staging.yaml');

  try {
    writeFileSync(prod, 'pool_size: 5\nonly_in_prod: true\n', 'utf8');
    writeFileSync(staging, 'pool_size: 6\nonly_in_staging: true\n', 'utf8');

    const forward = runCompare(dir, [prod, staging, '--policies', 'default']);
    const reverse = runCompare(dir, [staging, prod, '--policies', 'default']);

    assert.equal(forward.status, 1);
    assert.match(forward.stdout, /staging\.yaml — 3 changes from .*prod\.yaml:/);
    assert.match(forward.stdout, /\+ only_in_staging: true/);
    assert.match(forward.stdout, /- only_in_prod: true/);
    assert.match(forward.stdout, /~ pool_size: 5 → 6/);
    assert.match(forward.stdout, /"\+" exists only in the compared file/);

    // Swapping the arguments swaps the baseline, so the signs invert.
    assert.equal(reverse.status, 1);
    assert.match(reverse.stdout, /prod\.yaml — 3 changes from .*staging\.yaml:/);
    assert.match(reverse.stdout, /\+ only_in_prod: true/);
    assert.match(reverse.stdout, /- only_in_staging: true/);
    assert.match(reverse.stdout, /~ pool_size: 6 → 5/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compare diffs two files of different formats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-compare-formats-'));
  const yamlFile = join(dir, 'prod.yaml');
  const jsonFile = join(dir, 'prod.json');
  const tomlFile = join(dir, 'prod.toml');
  const envFile = join(dir, 'prod.env');

  try {
    writeFileSync(yamlFile, 'database:\n  host: db.internal\n  pool_size: 5\n', 'utf8');
    writeFileSync(jsonFile, JSON.stringify({ database: { host: 'db.internal', pool_size: 5 } }), 'utf8');
    writeFileSync(tomlFile, '[database]\nhost = "db.internal"\npool_size = 20\n', 'utf8');
    writeFileSync(envFile, 'KEY=value\n', 'utf8');

    const same = runCompare(dir, [yamlFile, jsonFile]);
    const differs = runCompare(dir, [yamlFile, tomlFile, '--fail-on', 'changed']);
    const other = runCompare(dir, [yamlFile, envFile, '--format', 'json']);

    assert.equal(same.status, 0, `${same.stdout}${same.stderr}`);
    assert.match(same.stdout, /no changes/);

    assert.equal(differs.status, 1);
    assert.match(differs.stdout, /~ database\.pool_size: 5 → 20/);

    // dotenv values are strings; the point is that both sides parse to trees.
    assert.equal(other.status, 1);
    const [result] = JSON.parse(other.stdout);
    assert.deepEqual(
      result.envelope.changes.map((change) => `${change.type} ${change.path}`).sort(),
      ['added KEY', 'removed database'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compare machine formats reuse the ci envelope and printer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-compare-format-'));
  const prod = join(dir, 'prod.json');
  const staging = join(dir, 'staging.json');

  try {
    writeFileSync(prod, JSON.stringify({ logging: { debug: false } }), 'utf8');
    writeFileSync(staging, JSON.stringify({ logging: { debug: true } }), 'utf8');

    const json = runCompare(dir, [prod, staging, '--format', 'json']);
    const ndjson = runCompare(dir, [prod, staging, '--format', 'ndjson']);
    const annotations = runCompare(dir, [prod, staging, '--format', 'github-annotations']);
    const bogus = runCompare(dir, [prod, staging, '--format', 'yaml']);

    assert.equal(json.status, 1);
    const results = JSON.parse(json.stdout);
    assert.equal(results.length, 1);
    assert.equal(results[0].file, staging);
    assert.equal(results[0].baseline, prod);
    assert.equal(results[0].envelope.schema_version, '2.0');
    assert.equal(results[0].envelope.event_type, 'changes');
    assert.equal(results[0].envelope.source, 'diff');
    assert.equal(results[0].envelope.file, staging);
    assert.deepEqual(results[0].envelope.changes, [
      { type: 'changed', path: 'logging.debug', before: false, after: true },
    ]);
    assert.equal(results[0].policies[0].id, 'dangerous-toggle-enabled');

    assert.equal(ndjson.status, 1);
    assert.equal(ndjson.stdout.trim().split('\n').length, 1);
    assert.equal(JSON.parse(ndjson.stdout).baseline, prod);

    assert.equal(annotations.status, 1);
    assert.match(annotations.stdout, /::warning file=.*staging\.json,title=flecto changed::logging\.debug/);
    assert.match(
      annotations.stdout,
      /::error file=.*staging\.json,title=flecto policy dangerous-toggle-enabled \[default\]::logging\.debug: /,
    );

    assert.equal(bogus.status, 1);
    assert.match(bogus.stderr, /--format must be human, json, ndjson, or github-annotations/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compare runs the policy engine and gates on --fail-on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-compare-policy-'));
  const prod = join(dir, 'prod.yaml');
  const staging = join(dir, 'staging.yaml');

  try {
    writeFileSync(prod, 'database:\n  pool_size: 5\n', 'utf8');
    writeFileSync(staging, 'database:\n  pool_size: 20\n', 'utf8');

    const findings = runCompare(dir, [prod, staging, '--fail-on', 'policy']);
    const warnOnly = runCompare(dir, [prod, staging, '--fail-on', 'error']);
    const remapped = runCompare(dir, [
      prod,
      staging,
      '--fail-on',
      'error',
      '--policies',
      'default,strict-prod',
    ]);

    assert.equal(findings.status, 1);
    assert.match(
      findings.stdout,
      /! policy\(warn\) \[default\] database\.pool_size: Pool size increased from 5 to 20/,
    );

    // The only finding is a warn, so an error-only gate passes.
    assert.equal(warnOnly.status, 0);
    assert.match(warnOnly.stdout, /~ database\.pool_size: 5 → 20/);

    // Extra packs load the same way they do for ci.
    assert.equal(remapped.status, 1);
    assert.match(remapped.stdout, /\[strict-prod\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compare honors --ignore and array identity flags', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-compare-diffopts-'));
  const prod = join(dir, 'prod.json');
  const staging = join(dir, 'staging.json');

  try {
    writeFileSync(prod, JSON.stringify({
      updated_at: '2024-01-01',
      services: [{ id: 'api', port: 3000 }, { id: 'web', port: 8080 }],
    }), 'utf8');
    writeFileSync(staging, JSON.stringify({
      updated_at: '2024-12-31',
      services: [{ id: 'web', port: 8080 }, { id: 'api', port: 3000 }],
    }), 'utf8');

    const bare = runCompare(dir, [prod, staging]);
    const ignored = runCompare(dir, [prod, staging, '--ignore', 'updated_at']);
    const byIndex = runCompare(dir, [prod, staging, '--ignore', 'updated_at', '--no-array-id']);

    assert.equal(bare.status, 1);
    assert.match(bare.stdout, /~ updated_at/);

    // Array identity is on by default, so the reorder alone is not a change.
    assert.equal(ignored.status, 0, `${ignored.stdout}${ignored.stderr}`);
    assert.match(ignored.stdout, /no changes/);

    assert.equal(byIndex.status, 1);
    assert.match(byIndex.stdout, /services\[0\]\.id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compare resolves options through .flectorc profiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-compare-profile-'));
  const prod = join(dir, 'prod.json');
  const staging = join(dir, 'staging.json');

  try {
    writeFileSync(prod, JSON.stringify({ database: { pool_size: 5 }, build: 1 }), 'utf8');
    writeFileSync(staging, JSON.stringify({ database: { pool_size: 20 }, build: 2 }), 'utf8');
    writeFileSync(join(dir, '.flectorc.json'), JSON.stringify({
      defaults: { ignore: 'build' },
      profiles: {
        skew: { format: 'ndjson', ignore: 'build,database.pool_size', failOn: '' },
      },
    }), 'utf8');

    const withProfile = runCompare(dir, ['--profile', 'skew', prod, staging]);
    const overridden = runCompare(dir, ['--profile', 'skew', prod, staging, '--format', 'human', '--fail-on', 'changed']);
    const defaultsOnly = runCompare(dir, [prod, staging]);

    // Profile supplies format, ignore, and failOn when no flag is passed.
    assert.equal(withProfile.status, 0);
    assert.deepEqual(JSON.parse(withProfile.stdout).envelope.changes, []);

    // Explicit flags still win over the profile.
    assert.equal(overridden.status, 0);
    assert.match(overridden.stdout, /no changes/);

    // Without the profile only `defaults.ignore` applies, so pool_size shows up.
    assert.equal(defaultsOnly.status, 1);
    assert.match(defaultsOnly.stdout, /~ database\.pool_size: 5 → 20/);
    assert.doesNotMatch(defaultsOnly.stdout, /~ build/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compare masks secret-like values when asked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-compare-mask-'));
  const prod = join(dir, 'prod.json');
  const staging = join(dir, 'staging.json');

  try {
    writeFileSync(prod, JSON.stringify({ service: 'api' }), 'utf8');
    writeFileSync(staging, JSON.stringify({
      service: 'api',
      database: { host: 'db.internal.test', password: 'hunter2' },
    }), 'utf8');

    const human = runCompare(dir, [prod, staging, '--mask-secrets']);
    const json = runCompare(dir, [prod, staging, '--mask-secrets', '--format', 'json']);

    assert.equal(human.status, 1);
    assert.doesNotMatch(human.stdout, /hunter2/);
    assert.match(human.stdout, /"password":"\*\*\*"/);
    assert.match(human.stdout, /db\.internal\.test/);

    assert.equal(json.status, 1);
    assert.doesNotMatch(json.stdout, /hunter2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compare errors on missing or unsupported files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-compare-errors-'));
  const prod = join(dir, 'prod.yaml');
  const missing = join(dir, 'missing.yaml');
  const unsupported = join(dir, 'notes.txt');
  const broken = join(dir, 'broken.json');

  try {
    writeFileSync(prod, 'a: 1\n', 'utf8');
    writeFileSync(unsupported, 'x\n', 'utf8');
    writeFileSync(broken, '{ not json', 'utf8');

    const missingBaseline = runCompare(dir, [missing, prod]);
    const missingTarget = runCompare(dir, [prod, missing]);
    const unsupportedTarget = runCompare(dir, [prod, unsupported]);
    const unparsable = runCompare(dir, [prod, broken]);

    assert.equal(missingBaseline.status, 1);
    assert.match(missingBaseline.stderr, /\[error\] File not found: .*missing\.yaml/);
    assert.equal(missingTarget.status, 1);
    assert.match(missingTarget.stderr, /\[error\] File not found: .*missing\.yaml/);

    assert.equal(unsupportedTarget.status, 1);
    assert.match(unsupportedTarget.stderr, /Unsupported file format "\.txt"/);
    assert.match(unsupportedTarget.stderr, /Supported extensions/);

    assert.equal(unparsable.status, 1);
    assert.match(unparsable.stderr, /Parse error in ".*broken\.json"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
