import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const rootIndex = resolve(process.cwd(), 'index.js');
const ENVELOPE_SCHEMA = JSON.parse(
  readFileSync(resolve(process.cwd(), 'schemas/flecto-envelope-2.0.json'), 'utf8'),
);

/**
 * A project of `total` configs where the first `changed` of them differ from
 * their baseline. `--snapshot-ref` takes one baseline file, so the baseline is
 * a directory of per-file snapshots addressed by name.
 * @param {{ total: number, changed: number, poolSizeJump?: boolean }} shape
 */
function project({ total, changed, poolSizeJump = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-changed-only-'));
  mkdirSync(join(dir, 'config'));
  for (let i = 0; i < total; i += 1) {
    const isChanged = i < changed;
    writeFileSync(
      join(dir, 'config', `svc-${i}.json`),
      JSON.stringify({ name: `svc-${i}`, pool_size: isChanged ? (poolSizeJump ? 20 : 6) : 5 }),
      'utf8',
    );
  }
  return dir;
}

/**
 * Snapshot the project, then run `ci` over it.
 * @param {string} dir
 * @param {string[]} extra
 */
function runCi(dir, extra) {
  spawnSync(process.execPath, [rootIndex, 'watch', 'config/**/*.json', '--snapshot'], {
    cwd: dir, encoding: 'utf8',
  });
  return spawnSync(
    process.execPath,
    [rootIndex, 'ci', 'config/**/*.json', '--allow-empty', ...extra],
    { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

/**
 * Snapshot a clean project, mutate some files, then run `ci`.
 * @param {{ total: number, changed: number, extra?: string[], poolSizeJump?: boolean }} shape
 */
function snapshotThenChange({ total, changed, extra = [], poolSizeJump = false }) {
  const dir = project({ total, changed: 0 });
  spawnSync(process.execPath, [rootIndex, 'watch', 'config/**/*.json', '--snapshot'], {
    cwd: dir, encoding: 'utf8',
  });
  for (let i = 0; i < changed; i += 1) {
    writeFileSync(
      join(dir, 'config', `svc-${i}.json`),
      JSON.stringify({ name: `svc-${i}`, pool_size: poolSizeJump ? 20 : 6 }),
      'utf8',
    );
  }
  const run = spawnSync(
    process.execPath,
    [rootIndex, 'ci', 'config/**/*.json', '--allow-empty', ...extra],
    { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return { dir, run };
}

/**
 * Validate an envelope against the committed JSON Schema. Deliberately minimal
 * -- required keys, no extra keys, and the closed enums -- which is exactly the
 * part that makes the manifest's design necessary: `additionalProperties` is
 * false, so the path list cannot live on the envelope.
 * @param {any} envelope
 */
function assertMatchesEnvelopeSchema(envelope) {
  for (const key of ENVELOPE_SCHEMA.required) {
    assert.ok(key in envelope, `envelope is missing required key "${key}"`);
  }
  const allowed = new Set(Object.keys(ENVELOPE_SCHEMA.properties));
  for (const key of Object.keys(envelope)) {
    if (envelope[key] === undefined) continue;
    assert.ok(allowed.has(key), `envelope carries "${key}", which schema 2.0 does not allow`);
  }
  assert.equal(envelope.schema_version, ENVELOPE_SCHEMA.properties.schema_version.const);
  assert.ok(ENVELOPE_SCHEMA.properties.event_type.enum.includes(envelope.event_type));
  assert.ok(ENVELOPE_SCHEMA.properties.source.enum.includes(envelope.source));
  assert.equal(typeof envelope.file, 'string');
}

describe('ci --changed-only', () => {
  test('the default is untouched: one envelope per scanned file', () => {
    // schema_version is 2.0 precisely so a reshaping is negotiated rather than
    // assumed. Nothing here may move without an opt-in.
    const { dir, run } = snapshotThenChange({ total: 6, changed: 1, extra: ['--format', 'json'] });
    try {
      const results = JSON.parse(run.stdout);
      assert.equal(results.length, 6);
      assert.ok(results.every((r) => r.envelope.event_type === 'changes'));
      assert.ok(results.every((r) => typeof r.file === 'string'));
      assert.equal(results.filter((r) => r.envelope.changes.length > 0).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('collapses unchanged files into one manifest entry', () => {
    const { dir, run } = snapshotThenChange({
      total: 6, changed: 1, extra: ['--format', 'json', '--changed-only'],
    });
    try {
      const results = JSON.parse(run.stdout);
      assert.equal(results.length, 2, 'one changed file plus one manifest');

      const [changedEntry, manifest] = results;
      assert.equal(changedEntry.envelope.event_type, 'changes');
      assert.equal(changedEntry.envelope.changes.length, 1);

      assert.equal(manifest.envelope.event_type, 'lifecycle');
      assert.equal(manifest.envelope.lifecycle.type, 'scanned');
      assert.equal(manifest.scanned.length, 5);
      assert.match(manifest.envelope.lifecycle.message, /5 files scanned/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the manifest keeps the evidence that Flecto looked at each file', () => {
    // An envelope for a scanned-but-unchanged file says "checked and clean".
    // Dropping that outright would let a consumer diffing two runs confuse it
    // with "never checked", which is how a gate quietly weakens.
    const { dir, run } = snapshotThenChange({
      total: 6, changed: 1, extra: ['--format', 'json', '--changed-only'],
    });
    try {
      const results = JSON.parse(run.stdout);
      const manifest = results.find((r) => r.envelope.event_type === 'lifecycle');
      const listed = manifest.scanned.map((p) => p.split(/[/\\]/).pop()).sort();
      assert.deepEqual(listed, ['svc-1.json', 'svc-2.json', 'svc-3.json', 'svc-4.json', 'svc-5.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the manifest envelope is still valid under schema 2.0', () => {
    const { dir, run } = snapshotThenChange({
      total: 4, changed: 1, extra: ['--format', 'json', '--changed-only'],
    });
    try {
      for (const result of JSON.parse(run.stdout)) {
        assertMatchesEnvelopeSchema(result.envelope);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a file with policy findings but no changes is not collapsed', () => {
    // "Unchanged" means nothing to report, and a finding is something to
    // report. Collapsing on `changes` alone would swallow it.
    //
    // The built-in packs derive findings from change events, so this state is
    // only reachable through a plugin -- which is exactly why the guard checks
    // both. A plugin is a supported extension point, so this is a real case
    // rather than a hypothetical one.
    const dir = project({ total: 4, changed: 0 });
    try {
      writeFileSync(
        join(dir, 'always.mjs'),
        'export function evaluate(changes, ctx) {\n'
        + "  if (!String(ctx.file).endsWith('svc-2.json')) return [];\n"
        + "  return [{ id: 'always', severity: 'warn', path: 'pool_size', message: 'flagged' }];\n"
        + '}\n',
        'utf8',
      );
      spawnSync(process.execPath, [rootIndex, 'watch', 'config/**/*.json', '--snapshot'], {
        cwd: dir, encoding: 'utf8',
      });
      const run = spawnSync(
        process.execPath,
        [
          rootIndex, 'ci', 'config/**/*.json', '--allow-empty',
          '--format', 'json', '--changed-only', '--plugins', './always.mjs',
        ],
        { cwd: dir, encoding: 'utf8' },
      );

      const results = JSON.parse(run.stdout);
      const flagged = results.find((r) => r.envelope.policies?.length > 0);
      assert.ok(flagged, `expected a finding to survive:\n${run.stdout}\n${run.stderr}`);
      assert.equal(flagged.envelope.changes.length, 0, 'the finding came without any change');
      assert.match(flagged.file, /svc-2\.json$/);

      const manifest = results.find((r) => r.envelope.event_type === 'lifecycle');
      assert.equal(manifest.scanned.length, 3, 'the other three collapse as normal');
      assert.ok(!manifest.scanned.some((p) => p.endsWith('svc-2.json')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no manifest is emitted when every file changed', () => {
    const { dir, run } = snapshotThenChange({
      total: 4, changed: 4, extra: ['--format', 'json', '--changed-only'],
    });
    try {
      const results = JSON.parse(run.stdout);
      assert.equal(results.length, 4);
      assert.ok(results.every((r) => r.envelope.event_type === 'changes'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a wholly clean run collapses to the manifest alone', () => {
    const { dir, run } = snapshotThenChange({
      total: 5, changed: 0, extra: ['--format', 'json', '--changed-only'],
    });
    try {
      const results = JSON.parse(run.stdout);
      assert.equal(results.length, 1);
      assert.equal(results[0].envelope.event_type, 'lifecycle');
      assert.equal(results[0].scanned.length, 5);
      assert.equal(run.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ndjson collapses the same way, one record per line', () => {
    const { dir, run } = snapshotThenChange({
      total: 6, changed: 1, extra: ['--format', 'ndjson', '--changed-only'],
    });
    try {
      const lines = run.stdout.trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(lines.length, 2);
      assert.equal(lines[1].envelope.event_type, 'lifecycle');
      assert.equal(lines[1].scanned.length, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the exit code is unchanged by the flag', () => {
    // The flag shapes output only. A gate that changed meaning depending on how
    // verbose the output was would be the worst possible coupling.
    for (const changed of [0, 2]) {
      const plain = snapshotThenChange({ total: 4, changed, extra: ['--format', 'json'] });
      const collapsed = snapshotThenChange({
        total: 4, changed, extra: ['--format', 'json', '--changed-only'],
      });
      try {
        assert.equal(collapsed.run.status, plain.run.status, `changed=${changed}`);
      } finally {
        rmSync(plain.dir, { recursive: true, force: true });
        rmSync(collapsed.dir, { recursive: true, force: true });
      }
    }
  });

  test('it warns rather than silently doing nothing on a format it cannot collapse', () => {
    // sarif carries findings only, and github-annotations and pr-comment
    // already render just what changed -- so there is nothing to collapse in
    // any of them. Accepting the flag and doing nothing would be the quieter,
    // worse behavior.
    for (const format of ['sarif', 'github-annotations', 'pr-comment']) {
      const { dir, run } = snapshotThenChange({
        total: 4, changed: 1, extra: ['--format', format, '--changed-only'],
      });
      try {
        assert.match(`${run.stdout}${run.stderr}`, /Ignoring --changed-only/, format);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('the collapsible formats do not warn', () => {
    for (const format of ['json', 'ndjson']) {
      const { dir, run } = snapshotThenChange({
        total: 4, changed: 1, extra: ['--format', format, '--changed-only'],
      });
      try {
        assert.doesNotMatch(`${run.stdout}${run.stderr}`, /Ignoring --changed-only/, format);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('it can be set in .flectorc rather than repeated on every invocation', () => {
    const dir = project({ total: 5, changed: 0 });
    try {
      writeFileSync(
        join(dir, '.flectorc.json'),
        JSON.stringify({ defaults: { format: 'json', changedOnly: true } }),
        'utf8',
      );
      const run = runCi(dir, []);
      const results = JSON.parse(run.stdout);
      assert.equal(results.length, 1);
      assert.equal(results[0].envelope.event_type, 'lifecycle');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the output actually gets smaller, and by more than the entry count suggests', () => {
    const plain = snapshotThenChange({ total: 60, changed: 1, extra: ['--format', 'json'] });
    const collapsed = snapshotThenChange({
      total: 60, changed: 1, extra: ['--format', 'json', '--changed-only'],
    });
    try {
      const before = Buffer.byteLength(plain.run.stdout, 'utf8');
      const after = Buffer.byteLength(collapsed.run.stdout, 'utf8');
      assert.ok(after < before / 2, `expected a large reduction, got ${before} -> ${after}`);
    } finally {
      rmSync(plain.dir, { recursive: true, force: true });
      rmSync(collapsed.dir, { recursive: true, force: true });
    }
  });
});

describe('ci --changed-only composes with --baseline', () => {
  // Both features shape the same results array: the baseline strips accepted
  // findings, then the collapse removes files left with nothing to report. The
  // order matters, so it is asserted rather than assumed.
  function baselineProject() {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-changed-only-baseline-'));
    mkdirSync(join(dir, 'config'));
    // One file trips a policy on a real change; four are quiet.
    writeFileSync(
      join(dir, 'config', 'risky.yaml'),
      'database:\n  pool_size: 100\nlogging:\n  debug: true\n',
      'utf8',
    );
    for (let i = 0; i < 4; i += 1) {
      writeFileSync(join(dir, 'config', `quiet-${i}.yaml`), `name: quiet-${i}\nport: ${8000 + i}\n`, 'utf8');
    }
    spawnSync(process.execPath, [rootIndex, 'watch', 'config/**/*.yaml', '--snapshot'], {
      cwd: dir, encoding: 'utf8',
    });
    writeFileSync(
      join(dir, 'config', 'risky.yaml'),
      'database:\n  pool_size: 400\nlogging:\n  debug: true\n',
      'utf8',
    );
    return dir;
  }

  const ci = (dir, extra) => spawnSync(
    process.execPath,
    [rootIndex, 'ci', 'config/**/*.yaml', '--allow-empty', '--format', 'json', ...extra],
    { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  test('an accepted finding does not keep its file out of the manifest', () => {
    const dir = baselineProject();
    try {
      // Record the current findings, then revert the change so the file is both
      // clean and fully accepted.
      assert.equal(ci(dir, ['--baseline', '.flecto-baseline.json', '--update-baseline', '--fail-on', 'policy']).status, 0);
      writeFileSync(
        join(dir, 'config', 'risky.yaml'),
        'database:\n  pool_size: 100\nlogging:\n  debug: true\n',
        'utf8',
      );

      const run = ci(dir, ['--baseline', '.flecto-baseline.json', '--fail-on', 'policy', '--changed-only']);
      const results = JSON.parse(run.stdout);
      assert.equal(results.length, 1, `expected the manifest alone:\n${run.stdout}`);
      assert.equal(results[0].envelope.event_type, 'lifecycle');
      assert.equal(results[0].scanned.length, 5, 'the accepted file collapses with the rest');
      assert.equal(run.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a file with changes still reports, even when its findings are accepted', () => {
    const dir = baselineProject();
    try {
      assert.equal(ci(dir, ['--baseline', '.flecto-baseline.json', '--update-baseline', '--fail-on', 'policy']).status, 0);

      const run = ci(dir, ['--baseline', '.flecto-baseline.json', '--fail-on', 'policy', '--changed-only']);
      const results = JSON.parse(run.stdout);
      const reported = results.filter((r) => r.envelope.event_type === 'changes');
      assert.equal(reported.length, 1, `the changed file must survive:\n${run.stdout}`);
      assert.match(reported[0].file, /risky\.yaml$/);
      assert.ok(reported[0].envelope.changes.length > 0);
      assert.equal(reported[0].envelope.policies.length, 0, 'its findings are accepted, so none are shown');

      const manifest = results.find((r) => r.envelope.event_type === 'lifecycle');
      assert.equal(manifest.scanned.length, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
