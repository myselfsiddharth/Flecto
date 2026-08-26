import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { createServer } from 'http';

test('ci mode returns non-zero when fail-on changed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-'));
  const file = join(dir, 'config.json');
  const snapshot = join(dir, 'snapshot.json');
  writeFileSync(file, JSON.stringify({ a: 2 }, null, 2), 'utf8');
  writeFileSync(snapshot, JSON.stringify({ state: { a: 1 } }, null, 2), 'utf8');

  const rootIndex = resolve(process.cwd(), 'index.js');
  const run = spawnSync(
    process.execPath,
    [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--format', 'json', '--fail-on', 'changed'],
    { encoding: 'utf8' }
  );

  rmSync(dir, { recursive: true, force: true });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /"changes"/);
});

test('ci profile values override Commander defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-profile-'));
  const file = join(dir, 'config.json');
  const snapshot = join(dir, 'snapshot.json');
  const rc = join(dir, '.flectorc.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    writeFileSync(file, JSON.stringify({ a: 2 }, null, 2), 'utf8');
    writeFileSync(snapshot, JSON.stringify({ state: { a: 1 } }, null, 2), 'utf8');
    writeFileSync(rc, JSON.stringify({
      profiles: {
        regression: { format: 'ndjson', failOn: '' },
      },
    }), 'utf8');

    const run = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--profile', 'regression', '--snapshot-ref', snapshot],
      { cwd: dir, encoding: 'utf8' }
    );

    assert.equal(run.status, 0);
    assert.equal(JSON.parse(run.stdout).envelope.changes.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci resolves both files and include patterns from .flectorc', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-include-'));
  const configDir = join(dir, 'config');
  const deployDir = join(dir, 'deploy');
  const snapshot = join(dir, 'snapshot.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    mkdirSync(configDir);
    mkdirSync(deployDir);
    writeFileSync(join(configDir, 'app.json'), JSON.stringify({ version: 1 }), 'utf8');
    writeFileSync(join(deployDir, 'app.yaml'), 'version: 1\n', 'utf8');
    writeFileSync(snapshot, JSON.stringify({ state: { version: 1 } }), 'utf8');
    writeFileSync(join(dir, '.flectorc.json'), JSON.stringify({
      files: ['config/**/*.json'],
      include: ['deploy/**/*.yaml'],
    }), 'utf8');

    const run = spawnSync(
      process.execPath,
      [rootIndex, 'ci', '--snapshot-ref', snapshot, '--format', 'json', '--fail-on', ''],
      { cwd: dir, encoding: 'utf8' },
    );

    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(
      JSON.parse(run.stdout).map((result) => result.file).sort(),
      [join(configDir, 'app.json'), join(deployDir, 'app.yaml')]
        .map((path) => realpathSync(path))
        .sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci rejects unknown fail-on triggers from flags and profiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-fail-on-'));
  const file = join(dir, 'config.json');
  const snapshot = join(dir, 'snapshot.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    writeFileSync(file, JSON.stringify({ version: 2 }), 'utf8');
    writeFileSync(snapshot, JSON.stringify({ state: { version: 1 } }), 'utf8');

    const fromFlag = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--fail-on', 'changeed'],
      { cwd: dir, encoding: 'utf8' },
    );
    writeFileSync(join(dir, '.flectorc.json'), JSON.stringify({
      profiles: { strict: { failOn: 'changed,polciy' } },
    }), 'utf8');
    const fromProfile = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--profile', 'strict', '--snapshot-ref', snapshot],
      { cwd: dir, encoding: 'utf8' },
    );

    assert.equal(fromFlag.status, 1);
    assert.match(fromFlag.stderr, /unknown trigger: changeed/);
    assert.equal(fromProfile.status, 1);
    assert.match(fromProfile.stderr, /unknown trigger: polciy/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci applies profile severityRemap before fail-on checks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-remap-'));
  const file = join(dir, 'config.json');
  const snapshot = join(dir, 'snapshot.json');
  writeFileSync(file, JSON.stringify({ database: { pool_size: 20 } }), 'utf8');
  writeFileSync(snapshot, JSON.stringify({ state: { database: { pool_size: 5 } } }), 'utf8');
  writeFileSync(join(dir, '.flectorc.json'), JSON.stringify({
    profiles: {
      prod: { severityRemap: { 'pool-size-jump': 'error' } },
    },
  }), 'utf8');

  try {
    const rootIndex = resolve(process.cwd(), 'index.js');
    const run = spawnSync(
      process.execPath,
      [
        rootIndex,
        'ci',
        file,
        '--profile',
        'prod',
        '--snapshot-ref',
        snapshot,
        '--format',
        'json',
        '--fail-on',
        'error',
      ],
      { cwd: dir, encoding: 'utf8' },
    );

    assert.equal(run.status, 1);
    assert.match(run.stdout, /"severity": "error"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci GitHub annotations escape workflow command properties and data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-annotations-'));
  const file = join(dir, 'config,100%.json');
  const snapshot = join(dir, 'snapshot.json');
  const plugin = join(dir, 'special-policy.mjs');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    writeFileSync(file, JSON.stringify({ 'unsafe,path%\r\nmessage': 2 }), 'utf8');
    writeFileSync(snapshot, JSON.stringify({ state: { 'unsafe,path%\r\nmessage': 1 } }), 'utf8');
    writeFileSync(plugin, `export function evaluate() {
  return [{
    id: 'custom,title%',
    severity: 'error',
    path: 'policy,path%\\r\\nmessage',
    message: 'message,body%\\r\\ntext',
    pack: 'pack,name%',
  }];
}`, 'utf8');

    const run = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--format', 'github-annotations', '--plugins', plugin],
      { encoding: 'utf8' },
    );

    assert.equal(run.status, 1);
    assert.match(
      run.stdout,
      /::warning file=.*config%2C100%25\.json,title=flecto changed::unsafe,path%25%0D%0Amessage/,
    );
    assert.match(
      run.stdout,
      /::error file=.*config%2C100%25\.json,title=flecto policy custom%2Ctitle%25 \[pack%2Cname%25\]::policy,path%25%0D%0Amessage: message,body%25%0D%0Atext/,
    );
    assert.equal(run.stdout.match(/::(?:warning|error) /g)?.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci fails closed when all targets are unsupported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-empty-ci-'));
  const file = join(dir, 'nope.txt');
  writeFileSync(file, 'x\n', 'utf8');
  const rootIndex = resolve(process.cwd(), 'index.js');

  const run = spawnSync(
    process.execPath,
    [rootIndex, 'ci', file, '--format', 'json', '--fail-on', 'changed'],
    { encoding: 'utf8' }
  );
  const allowed = spawnSync(
    process.execPath,
    [rootIndex, 'ci', file, '--format', 'json', '--fail-on', 'changed', '--allow-empty'],
    { encoding: 'utf8' }
  );

  rmSync(dir, { recursive: true, force: true });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /No files were diffed/);
  assert.match(run.stderr, /Skipping unsupported file/);
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout.trim(), '[]');
});

test('snapshot fails closed when nothing was written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-empty-snap-'));
  const unsupported = join(dir, 'nope.txt');
  const missing = join(dir, 'missing.json');
  writeFileSync(unsupported, 'x\n', 'utf8');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    const run = spawnSync(
      process.execPath,
      [rootIndex, 'watch', unsupported, missing, '--snapshot'],
      { encoding: 'utf8', cwd: dir }
    );
    const allowed = spawnSync(
      process.execPath,
      [rootIndex, 'watch', unsupported, '--snapshot', '--allow-empty'],
      { encoding: 'utf8', cwd: dir }
    );

    assert.equal(run.status, 1);
    assert.match(run.stderr, /No snapshots written/);
    assert.match(run.stderr, /Skipping unsupported file/);
    assert.match(run.stderr, /Skipping missing file/);
    assert.equal(allowed.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watch --snapshot and --diff handle a self-referential YAML anchor (#103)', () => {
  // `a: &x\n  b: *x` parses to a genuinely cyclic object (js-yaml resolves the
  // alias to the same object reference). This reproduces the issue's exact
  // repro end to end: snapshot must reach the JSON.stringify write path
  // without throwing, and a later --diff must read that snapshot back and
  // report only the real change.
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-cyclic-'));
  const file = join(dir, 'cyclic.yaml');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    writeFileSync(file, 'a: &x\n  b: *x\n', 'utf8');

    const snap = spawnSync(
      process.execPath,
      [rootIndex, 'watch', file, '--snapshot'],
      { encoding: 'utf8', cwd: dir }
    );
    assert.equal(snap.status, 0, snap.stderr);
    assert.match(snap.stdout, /Snapshot saved/);

    // No change yet.
    const clean = spawnSync(
      process.execPath,
      [rootIndex, 'watch', file, '--diff'],
      { encoding: 'utf8', cwd: dir }
    );
    assert.equal(clean.status, 0, clean.stderr);

    writeFileSync(file, 'a: &x\n  b: *x\n  c: 2\n', 'utf8');
    const diff = spawnSync(
      process.execPath,
      [rootIndex, 'watch', file, '--diff'],
      { encoding: 'utf8', cwd: dir }
    );
    assert.equal(diff.status, 1, diff.stderr);
    assert.match(diff.stdout, /a\.c/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watch fails closed on policy pack errors regardless of alert failure setting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-watch-policy-fail-'));
  const file = join(dir, 'config.json');
  const rootIndex = resolve(process.cwd(), 'index.js');
  writeFileSync(file, JSON.stringify({ enabled: false }), 'utf8');

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [rootIndex, 'watch', file, '--polling', '--interval', '25', '--policies', 'missing-pack', '--on-alert-failure', 'warn'],
        { cwd: dir },
      );
      let stdout = '';
      let stderr = '';
      let changed = false;
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('watch did not exit after the policy pack error'));
      }, 5000);

      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (!changed && stdout.includes('flecto watching')) {
          changed = true;
          setTimeout(() => writeFileSync(file, JSON.stringify({ enabled: true }), 'utf8'), 100);
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      child.on('close', (status) => {
        clearTimeout(timeout);
        resolve({ status, stderr });
      });
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /policy evaluation failed: Unknown policy pack "missing-pack"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watch exits after an alert command fails with on-alert-failure exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-watch-alert-fail-'));
  const file = join(dir, 'config.json');
  const rootIndex = resolve(process.cwd(), 'index.js');
  writeFileSync(file, JSON.stringify({ enabled: false }), 'utf8');

  try {
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn(
        process.execPath,
        [
          rootIndex,
          'watch',
          file,
          '--polling',
          '--interval',
          '25',
          '--command',
          `"${process.execPath}" -e "process.exit(7)"`,
          '--on-alert-failure',
          'exit',
        ],
        { cwd: dir },
      );
      let stdout = '';
      let stderr = '';
      let changed = false;
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('watch did not exit after the alert command failed'));
      }, 5000);

      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (!changed && stdout.includes('flecto watching')) {
          changed = true;
          setTimeout(() => writeFileSync(file, JSON.stringify({ enabled: true }), 'utf8'), 100);
        }
      });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      child.on('close', (status) => {
        clearTimeout(timeout);
        resolveResult({ status, stderr });
      });
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Command failed \(exit 7\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history summarizes local snapshot drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-history-'));
  const file = join(dir, 'config.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    writeFileSync(file, JSON.stringify({ pool_size: 5 }, null, 2), 'utf8');
    const first = spawnSync(
      process.execPath,
      [rootIndex, 'watch', file, '--snapshot'],
      { cwd: dir, encoding: 'utf8' },
    );
    writeFileSync(file, JSON.stringify({ pool_size: 20 }, null, 2), 'utf8');
    const second = spawnSync(
      process.execPath,
      [rootIndex, 'watch', file, '--snapshot'],
      { cwd: dir, encoding: 'utf8' },
    );
    const history = spawnSync(
      process.execPath,
      [rootIndex, 'history', file, '--limit', '2'],
      { cwd: dir, encoding: 'utf8' },
    );

    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    assert.equal(history.status, 0);
    assert.match(history.stdout, /Local snapshot history \(2 snapshots\)/);
    assert.match(history.stdout, /config\.json — 1 change/);
    assert.match(history.stdout, /config\.json — 0 changes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history distinguishes unmatched file filters from missing snapshots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-history-filter-'));
  const emptyDir = mkdtempSync(join(tmpdir(), 'flecto-cli-history-empty-'));
  const tracked = join(dir, 'tracked.json');
  const other = join(dir, 'other.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    writeFileSync(tracked, JSON.stringify({ pool_size: 5 }, null, 2), 'utf8');
    writeFileSync(other, JSON.stringify({ pool_size: 1 }, null, 2), 'utf8');
    const snapshot = spawnSync(
      process.execPath,
      [rootIndex, 'watch', tracked, '--snapshot'],
      { cwd: dir, encoding: 'utf8' },
    );
    const filtered = spawnSync(
      process.execPath,
      [rootIndex, 'history', other],
      { cwd: dir, encoding: 'utf8' },
    );
    const empty = spawnSync(
      process.execPath,
      [rootIndex, 'history'],
      { cwd: emptyDir, encoding: 'utf8' },
    );

    assert.equal(snapshot.status, 0);
    assert.equal(filtered.status, 1);
    assert.match(
      filtered.stderr,
      /No local snapshots matched the given files\. Omit files to view all saved snapshot history\./,
    );
    assert.doesNotMatch(filtered.stderr, /No local snapshots found/);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /No local snapshots found\. Run "flecto watch <file> --snapshot" first\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('history retains legacy snapshots without timestamped history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-history-legacy-'));
  const legacyFile = join(dir, 'legacy.json');
  const currentFile = join(dir, 'current.json');
  const snapshotDir = join(dir, '.flecto-snapshots');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(
      join(snapshotDir, 'aaaaaaaaaaaaaaaa.json'),
      JSON.stringify({ file: legacyFile, state: { version: 1 } }),
      'utf8',
    );
    writeFileSync(
      join(snapshotDir, 'bbbbbbbbbbbbbbbb.1000.json'),
      JSON.stringify({ file: currentFile, state: { version: 2 }, createdAt: '2026-01-01T00:00:00.000Z' }),
      'utf8',
    );

    const history = spawnSync(
      process.execPath,
      [rootIndex, 'history', '--limit', '10'],
      { cwd: dir, encoding: 'utf8' },
    );

    assert.equal(history.status, 0);
    assert.match(history.stdout, /legacy\.json — 0 changes/);
    assert.match(history.stdout, /current\.json — 0 changes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history preserves a legacy baseline during first snapshot migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-history-migration-'));
  const file = join(dir, 'config.json');
  const snapshotDir = join(dir, '.flecto-snapshots');
  const id = createHash('sha256').update(file.replaceAll('\\', '/')).digest('hex').slice(0, 16);
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(
      join(snapshotDir, `${id}.json`),
      JSON.stringify({ file, state: { pool_size: 5 } }),
      'utf8',
    );
    writeFileSync(file, JSON.stringify({ pool_size: 20 }, null, 2), 'utf8');

    const snapshot = spawnSync(
      process.execPath,
      [rootIndex, 'watch', file, '--snapshot'],
      { cwd: dir, encoding: 'utf8' },
    );
    const history = spawnSync(
      process.execPath,
      [rootIndex, 'history', file, '--limit', '2'],
      { cwd: dir, encoding: 'utf8' },
    );

    assert.equal(snapshot.status, 0);
    assert.equal(history.status, 0);
    assert.match(history.stdout, /Local snapshot history \(2 snapshots\)/);
    assert.match(history.stdout, /config\.json — 1 change/);
    assert.match(history.stdout, /config\.json — 0 changes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history change counts honor the same diff options as watch --diff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-history-dopts-'));
  const file = join(dir, 'services.json');
  const rootIndex = resolve(process.cwd(), 'index.js');
  const before = {
    updated_at: '2024-01-01',
    services: [{ id: 'a', port: 80 }, { id: 'b', port: 443 }],
  };
  const after = {
    updated_at: '2024-12-31',
    services: [{ id: 'b', port: 443 }, { id: 'a', port: 80 }],
  };
  const diffFlags = ['--ignore', 'updated_at', '--array-id-key', 'id', '--array-ignore-order'];

  try {
    writeFileSync(file, JSON.stringify(before, null, 2), 'utf8');
    const first = spawnSync(
      process.execPath,
      [rootIndex, 'watch', file, '--snapshot'],
      { cwd: dir, encoding: 'utf8' },
    );
    writeFileSync(file, JSON.stringify(after, null, 2), 'utf8');

    const diff = spawnSync(
      process.execPath,
      [rootIndex, 'watch', file, '--diff', ...diffFlags],
      { cwd: dir, encoding: 'utf8' },
    );

    const second = spawnSync(
      process.execPath,
      [rootIndex, 'watch', file, '--snapshot'],
      { cwd: dir, encoding: 'utf8' },
    );
    const historyWithOpts = spawnSync(
      process.execPath,
      [rootIndex, 'history', file, '--limit', '2', ...diffFlags],
      { cwd: dir, encoding: 'utf8' },
    );
    const historyBare = spawnSync(
      process.execPath,
      [rootIndex, 'history', file, '--limit', '2'],
      { cwd: dir, encoding: 'utf8' },
    );

    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    assert.equal(diff.status, 0, `watch --diff should treat noise as unchanged:\n${diff.stdout}\n${diff.stderr}`);
    assert.equal(historyWithOpts.status, 0);
    assert.match(historyWithOpts.stdout, /services\.json — 0 changes/);
    assert.equal(historyBare.status, 0);
    assert.match(historyBare.stdout, /services\.json — [1-9]\d* changes?/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci mode reads git snapshot refs for paths with spaces', () => {
  const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (gitVersion.status !== 0) {
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-git-ref-'));
  const nested = join(dir, 'config files');
  const file = join(nested, 'app config.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    mkdirSync(nested, { recursive: true });
    writeFileSync(file, JSON.stringify({ limit: 1 }, null, 2), 'utf8');

    assert.equal(spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.name', 'Flecto Test'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['commit', '-m', 'baseline'], { cwd: dir, encoding: 'utf8' }).status, 0);

    writeFileSync(file, JSON.stringify({ limit: 2 }, null, 2), 'utf8');

    const run = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', 'HEAD', '--format', 'json', '--fail-on', 'changed'],
      { cwd: dir, encoding: 'utf8' }
    );

    assert.equal(run.status, 1);
    const results = JSON.parse(run.stdout);
    assert.equal(results[0].envelope.changes.length, 1);
    assert.deepEqual(results[0].envelope.changes[0], {
      type: 'changed',
      path: 'limit',
      before: 1,
      after: 2,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci mode reads git snapshot refs when run from a subdirectory', () => {
  const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (gitVersion.status !== 0) {
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-git-subdir-'));
  const nested = join(dir, 'services', 'api');
  const file = join(nested, 'config.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    mkdirSync(nested, { recursive: true });
    writeFileSync(file, JSON.stringify({ limit: 1 }, null, 2), 'utf8');

    assert.equal(spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.name', 'Flecto Test'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['commit', '-m', 'baseline'], { cwd: dir, encoding: 'utf8' }).status, 0);

    writeFileSync(file, JSON.stringify({ limit: 2 }, null, 2), 'utf8');

    // git show <rev>:<path> resolves <path> from the repository root, so this
    // must not be diffed against a cwd-relative path.
    const run = spawnSync(
      process.execPath,
      [rootIndex, 'ci', 'config.json', '--snapshot-ref', 'HEAD', '--format', 'json', '--fail-on', 'changed'],
      { cwd: nested, encoding: 'utf8' }
    );

    assert.equal(run.status, 1);
    const results = JSON.parse(run.stdout);
    assert.equal(results[0].envelope.changes.length, 1);
    assert.deepEqual(results[0].envelope.changes[0], {
      type: 'changed',
      path: 'limit',
      before: 1,
      after: 2,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci array identity supports auto-detection, custom keys, and index escape hatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-array-id-'));
  const file = join(dir, 'config.json');
  const snapshot = join(dir, 'snapshot.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  const runCi = (args = []) => spawnSync(
    process.execPath,
    [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--format', 'json', '--fail-on', 'changed', ...args],
    { encoding: 'utf8' },
  );

  try {
    writeFileSync(snapshot, JSON.stringify({
      state: { services: [{ id: 'api', port: 3000 }, { id: 'web', port: 8080 }] },
    }), 'utf8');
    writeFileSync(file, JSON.stringify({
      services: [{ id: 'web', port: 8080 }, { id: 'api', port: 3000 }],
    }), 'utf8');

    const auto = runCi();
    assert.equal(auto.status, 0);
    assert.deepEqual(JSON.parse(auto.stdout)[0].envelope.changes, []);

    writeFileSync(snapshot, JSON.stringify({
      state: { services: [{ id: 1, key: 'api', port: 3000 }, { id: 2, key: 'web', port: 8080 }] },
    }), 'utf8');
    writeFileSync(file, JSON.stringify({
      services: [{ id: 2, key: 'web', port: 8080 }, { id: 1, key: 'api', port: 4000 }],
    }), 'utf8');

    const custom = runCi(['--array-id-key', 'key']);
    assert.equal(custom.status, 1);
    assert.equal(JSON.parse(custom.stdout)[0].envelope.changes[0].path, 'services["api"].port');

    writeFileSync(snapshot, JSON.stringify({
      state: { services: [{ id: 'api', port: 3000 }, { id: 'web', port: 8080 }] },
    }), 'utf8');
    writeFileSync(file, JSON.stringify({
      services: [{ id: 'web', port: 8080 }, { id: 'api', port: 3000 }],
    }), 'utf8');

    const indexed = runCi(['--no-array-id']);
    assert.equal(indexed.status, 1);
    assert.equal(JSON.parse(indexed.stdout)[0].envelope.changes[0].path, 'services[0].id');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci --array-id-key overrides .flectorc arrayId false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-array-id-rc-'));
  const file = join(dir, 'config.json');
  const snapshot = join(dir, 'snapshot.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  writeFileSync(join(dir, '.flectorc'), JSON.stringify({ defaults: { arrayId: false } }), 'utf8');
  writeFileSync(snapshot, JSON.stringify({
    state: { services: [{ id: 1, key: 'api', port: 3000 }, { id: 2, key: 'web', port: 8080 }] },
  }), 'utf8');
  writeFileSync(file, JSON.stringify({
    services: [{ id: 2, key: 'web', port: 8080 }, { id: 1, key: 'api', port: 4000 }],
  }), 'utf8');

  try {
    const withoutKey = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--format', 'json', '--fail-on', 'changed'],
      { encoding: 'utf8', cwd: dir }
    );
    assert.equal(withoutKey.status, 1);
    assert.equal(JSON.parse(withoutKey.stdout)[0].envelope.changes[0].path, 'services[0].id');

    const withKey = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--format', 'json', '--fail-on', 'changed', '--array-id-key', 'key'],
      { encoding: 'utf8', cwd: dir }
    );
    assert.equal(withKey.status, 1);
    assert.equal(JSON.parse(withKey.stdout)[0].envelope.changes[0].path, 'services["api"].port');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('policies list discovers built-ins and local overrides from cwd', () => {
  // realpath: the CLI reports canonical pack paths, and macOS resolves
  // /var/folders temp dirs to /private/var/folders.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flecto-cli-policies-')));
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    const builtins = spawnSync(
      process.execPath,
      [rootIndex, 'policies', 'list', '--json'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(builtins.status, 0);
    const builtinPacks = JSON.parse(builtins.stdout);
    assert.deepEqual(
      builtinPacks.map((pack) => pack.id),
      ['compose', 'default', 'kubernetes', 'node-runtime', 'sops', 'strict-prod', 'terraform'],
    );
    assert.ok(builtinPacks.every((pack) => pack.source === 'builtin'));
    assert.ok(builtinPacks.every((pack) => !pack.overridesBuiltin));

    const policiesDir = join(dir, 'policies');
    mkdirSync(policiesDir);
    writeFileSync(
      join(policiesDir, 'default.yaml'),
      'id: default\nrules:\n  - id: local-default\n    severity: warn\n',
      'utf8',
    );
    writeFileSync(
      join(policiesDir, 'custom.json'),
      JSON.stringify({ id: 'custom', rules: [{ id: 'custom-rule', severity: 'info' }] }),
      'utf8',
    );

    const listed = spawnSync(
      process.execPath,
      [rootIndex, 'policies', 'list', '--json'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(listed.status, 0);
    const packs = JSON.parse(listed.stdout);
    const defaultPack = packs.find((pack) => pack.id === 'default');
    const customPack = packs.find((pack) => pack.id === 'custom');
    const strictProdPack = packs.find((pack) => pack.id === 'strict-prod');

    assert.deepEqual(defaultPack, {
      id: 'default',
      sourcePath: join(policiesDir, 'default.yaml'),
      source: 'local',
      ruleCount: 1,
      overridesBuiltin: true,
    });
    assert.equal(customPack.source, 'local');
    assert.equal(customPack.ruleCount, 1);
    assert.equal(customPack.overridesBuiltin, false);
    assert.equal(strictProdPack.source, 'builtin');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('watch --diff --mask-secrets redacts secret-shaped values under innocuous keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-mask-value-'));
  const file = join(dir, 'config.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    writeFileSync(file, JSON.stringify({ service: 'api' }, null, 2), 'utf8');
    const snapshot = spawnSync(
      process.execPath,
      [rootIndex, 'watch', file, '--snapshot'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(snapshot.status, 0);

    writeFileSync(file, JSON.stringify({
      service: 'api',
      database: {
        host: 'db.internal.test',
        connstr: 'postgres://app:7Kq2vNbXp9TzR4wY@db.internal.test:5432/appdb',
      },
      build: { commit: '9f2b7c1a4d5e6f708192a3b4c5d6e7f8091a2b3c' },
    }, null, 2), 'utf8');

    const diff = spawnSync(
      process.execPath,
      [rootIndex, 'watch', file, '--diff', '--mask-secrets'],
      { cwd: dir, encoding: 'utf8' },
    );

    assert.equal(diff.status, 1);
    assert.doesNotMatch(diff.stdout, /7Kq2vNbXp9TzR4wY/);
    assert.match(diff.stdout, /postgres:\/\/app:\*\*\*@db\.internal\.test:5432\/appdb/);
    assert.match(diff.stdout, /9f2b7c1a4d5e6f708192a3b4c5d6e7f8091a2b3c/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci flags a secret-shaped value under an innocuous key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-secret-value-'));
  const file = join(dir, 'config.json');
  const snapshot = join(dir, 'snapshot.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    writeFileSync(file, JSON.stringify({ db: { connstr: 'AKIAIOSFODNN7EXAMPLE' } }, null, 2), 'utf8');
    writeFileSync(snapshot, JSON.stringify({ state: { db: { connstr: 'unset' } } }, null, 2), 'utf8');

    const run = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--format', 'json', '--fail-on', 'policy'],
      { cwd: dir, encoding: 'utf8' },
    );

    assert.equal(run.status, 1);
    const [result] = JSON.parse(run.stdout);
    assert.deepEqual(result.policies.map((finding) => finding.id), ['secret-value-detected']);
    assert.equal(result.policies[0].severity, 'error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci masks values interpolated into custom policy messages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-policy-mask-'));
  const file = join(dir, 'config.json');
  const snapshot = join(dir, 'snapshot.json');
  const policiesDir = join(dir, 'policies');
  const rootIndex = resolve(process.cwd(), 'index.js');
  const oldPassword = 'ordinary-old-value';
  const newPassword = 'ordinary-new-value';

  try {
    mkdirSync(policiesDir);
    writeFileSync(file, JSON.stringify({ password: newPassword }), 'utf8');
    writeFileSync(snapshot, JSON.stringify({ state: { password: oldPassword } }), 'utf8');
    writeFileSync(join(policiesDir, 'custom.json'), JSON.stringify({
      id: 'custom',
      rules: [{
        id: 'credential-change',
        severity: 'warn',
        match: { pathEquals: 'password' },
        messageTemplate: 'Credential changed from {before} to {after}',
      }],
    }), 'utf8');

    const run = spawnSync(
      process.execPath,
      [
        rootIndex,
        'ci',
        file,
        '--snapshot-ref',
        snapshot,
        '--format',
        'json',
        '--policies',
        'custom',
        '--mask-secrets',
        '--fail-on',
        '',
      ],
      { cwd: dir, encoding: 'utf8' },
    );

    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, new RegExp(`${oldPassword}|${newPassword}`));
    const [result] = JSON.parse(run.stdout);
    assert.equal(result.policies[0].message, 'Credential changed from *** to ***');
    assert.equal(result.envelope.policies[0].message, 'Credential changed from *** to ***');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watch --diff --mask-secrets redacts nested secrets in terminal output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-mask-'));
  const file = join(dir, 'config.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    writeFileSync(file, JSON.stringify({ service: 'api' }, null, 2), 'utf8');
    const snapshot = spawnSync(
      process.execPath,
      [rootIndex, 'watch', file, '--snapshot'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(snapshot.status, 0);

    writeFileSync(file, JSON.stringify({
      service: 'api',
      database: { host: 'db.internal.test', password: 'hunter2' },
    }, null, 2), 'utf8');

    const diff = spawnSync(
      process.execPath,
      [rootIndex, 'watch', file, '--diff', '--mask-secrets'],
      { cwd: dir, encoding: 'utf8' },
    );

    assert.equal(diff.status, 1);
    assert.doesNotMatch(diff.stdout, /hunter2/);
    assert.match(diff.stdout, /"password":"\*\*\*"/);
    assert.match(diff.stdout, /db\.internal\.test/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a snapshot of a multi-document file carries its document keys (#110)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-multidoc-mask-'));
  const file = join(dir, 'manifest.yaml');
  const rootIndex = resolve(process.cwd(), 'index.js');
  const manifest = (replicas, token) => [
    'kind: Deployment',
    'metadata:',
    '  name: token-service',
    '  namespace: prod',
    'spec:',
    `  replicas: ${replicas}`,
    '---',
    'kind: Secret',
    'metadata:',
    '  name: db',
    '  namespace: prod',
    'stringData:',
    `  token: ${token}`,
    '',
  ].join('\n');

  try {
    writeFileSync(file, manifest(2, 'not-a-real-token'), 'utf8');
    assert.equal(
      spawnSync(process.execPath, [rootIndex, 'watch', file, '--snapshot'], { cwd: dir }).status,
      0,
    );
    writeFileSync(file, manifest(9, 'not-a-real-rotated-token'), 'utf8');

    const diff = spawnSync(
      process.execPath,
      [rootIndex, 'watch', file, '--diff', '--mask-secrets'],
      { cwd: dir, encoding: 'utf8' },
    );

    assert.equal(diff.status, 1);
    // The Deployment is *named* token-service; its replica count is not a secret.
    assert.match(diff.stdout, /Deployment\/prod\/token-service\.spec\.replicas: 2 → 9/);
    // The Secret's value is.
    assert.doesNotMatch(diff.stdout, /not-a-real-rotated-token/);
    assert.match(diff.stdout, /Secret\/prod\/db\.stringData\.token: "\*\*\*" → "\*\*\*"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watch --webhook-format slack posts a masked Block Kit payload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-webhook-format-'));
  const file = join(dir, 'config.json');
  const rootIndex = resolve(process.cwd(), 'index.js');
  writeFileSync(file, JSON.stringify({ database: { password: 'old-pw' } }), 'utf8');

  /** @type {string[]} */
  const bodies = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      bodies.push(body);
      res.statusCode = 200;
      res.end('ok');
    });
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  const url = `http://127.0.0.1:${server.address().port}/hook`;

  let child;
  try {
    const body = await new Promise((resolveBody, reject) => {
      child = spawn(
        process.execPath,
        [
          rootIndex, 'watch', file,
          '--polling', '--interval', '25',
          '--webhook', url,
          '--webhook-format', 'slack',
          '--webhook-retries', '0',
          '--mask-secrets-webhooks',
        ],
        { cwd: dir },
      );

      let stdout = '';
      let changed = false;
      const timeout = setTimeout(() => reject(new Error('no webhook delivery within 10s')), 10_000);
      const poll = setInterval(() => {
        if (bodies.length === 0) return;
        clearInterval(poll);
        clearTimeout(timeout);
        resolveBody(bodies[0]);
      }, 50);

      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (!changed && stdout.includes('flecto watching')) {
          changed = true;
          setTimeout(() => {
            writeFileSync(file, JSON.stringify({ database: { password: 's3cr3t-pw' } }), 'utf8');
          }, 100);
        }
      });
      child.on('error', (err) => {
        clearInterval(poll);
        clearTimeout(timeout);
        reject(err);
      });
    });

    const payload = JSON.parse(body);
    assert.ok(Array.isArray(payload.blocks), 'slack format posts Block Kit blocks');
    assert.equal(payload.blocks[0].type, 'header');
    assert.equal(payload.schema_version, undefined);
    assert.doesNotMatch(body, /s3cr3t-pw/);
    assert.match(body, /\*\*\*/);
  } finally {
    child?.kill();
    await new Promise((done) => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watch rejects an unknown webhook format from the CLI and from .flectorc', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-webhook-format-invalid-'));
  const file = join(dir, 'config.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    writeFileSync(file, JSON.stringify({ a: 1 }), 'utf8');
    const fromCli = spawnSync(
      process.execPath,
      [rootIndex, 'watch', file, '--webhook', 'https://hooks.example.com/x', '--webhook-format', 'hipchat'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(fromCli.status, 1);
    assert.match(fromCli.stderr, /--webhook-format must be one of: flecto, slack, discord, teams, auto/);

    writeFileSync(
      join(dir, '.flectorc.json'),
      JSON.stringify({ defaults: { webhookFormat: 'hipchat' } }),
      'utf8',
    );
    const fromRc = spawnSync(
      process.execPath,
      [rootIndex, 'watch', file, '--webhook', 'https://hooks.example.com/x'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(fromRc.status, 1);
    assert.match(fromRc.stderr, /--webhook-format must be one of/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci --format pr-comment prints sticky markdown and keeps the diff exit code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-pr-comment-'));
  const file = join(dir, 'config.json');
  const snapshot = join(dir, 'snapshot.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    writeFileSync(file, JSON.stringify({ logging: { debug: true } }), 'utf8');
    writeFileSync(snapshot, JSON.stringify({ state: { logging: { debug: false } } }), 'utf8');

    const run = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--format', 'pr-comment', '--fail-on', 'changed'],
      { cwd: dir, encoding: 'utf8' },
    );

    assert.equal(run.status, 1);
    assert.equal(run.stdout.split('\n')[0], '<!-- flecto:pr-comment -->');
    assert.match(run.stdout, /## Flecto — config change report/);
    assert.match(run.stdout, /❌ \*\*Check failing\*\*/);
    assert.match(run.stdout, /\| changed \| `logging\.debug` \| `false` \| `true` \|/);
    // Nothing is posted without the explicit opt-in, so nothing warns about it.
    assert.doesNotMatch(run.stderr, /PR comment/);

    const passing = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--format', 'pr-comment', '--fail-on', ''],
      { cwd: dir, encoding: 'utf8' },
    );

    assert.equal(passing.status, 0);
    assert.match(passing.stdout, /✅ \*\*Check passing\*\*/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci --pr-comment-post warns without a PR context but keeps the real exit code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-pr-post-'));
  const file = join(dir, 'config.json');
  const snapshot = join(dir, 'snapshot.json');
  const rootIndex = resolve(process.cwd(), 'index.js');
  // A laptop-like environment: no token, no repository, no pull request ref.
  const env = {
    ...process.env,
    GITHUB_TOKEN: '',
    GITHUB_REPOSITORY: '',
    GITHUB_REF: '',
    GITHUB_EVENT_PATH: '',
  };

  try {
    writeFileSync(file, JSON.stringify({ a: 2 }), 'utf8');
    writeFileSync(snapshot, JSON.stringify({ state: { a: 1 } }), 'utf8');

    const run = spawnSync(
      process.execPath,
      [
        rootIndex, 'ci', file, '--snapshot-ref', snapshot,
        '--format', 'pr-comment', '--pr-comment-post', '--fail-on', 'changed',
      ],
      { cwd: dir, encoding: 'utf8', env },
    );

    assert.equal(run.status, 1);
    assert.match(run.stdout, /<!-- flecto:pr-comment -->/);
    assert.match(run.stderr, /Could not post the PR comment: GITHUB_TOKEN is not set/);

    // The same delivery failure must not turn a passing run red either.
    const passing = spawnSync(
      process.execPath,
      [
        rootIndex, 'ci', file, '--snapshot-ref', snapshot,
        '--format', 'pr-comment', '--pr-comment-post', '--fail-on', '',
      ],
      { cwd: dir, encoding: 'utf8', env },
    );

    assert.equal(passing.status, 0);
    assert.match(passing.stderr, /Could not post the PR comment/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci warns when --pr-comment-post is used with another format', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-pr-post-format-'));
  const file = join(dir, 'config.json');
  const snapshot = join(dir, 'snapshot.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    writeFileSync(file, JSON.stringify({ a: 2 }), 'utf8');
    writeFileSync(snapshot, JSON.stringify({ state: { a: 1 } }), 'utf8');

    const run = spawnSync(
      process.execPath,
      [
        rootIndex, 'ci', file, '--snapshot-ref', snapshot,
        '--format', 'json', '--pr-comment-post', '--fail-on', '',
      ],
      { cwd: dir, encoding: 'utf8' },
    );

    assert.equal(run.status, 0);
    assert.match(run.stderr, /Ignoring --pr-comment-post/);
    assert.match(run.stdout, /"changes"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci rejects an unknown format', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-cli-bad-format-'));
  const file = join(dir, 'config.json');
  const snapshot = join(dir, 'snapshot.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    writeFileSync(file, JSON.stringify({ a: 2 }), 'utf8');
    writeFileSync(snapshot, JSON.stringify({ state: { a: 1 } }), 'utf8');

    const run = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--format', 'markdown'],
      { cwd: dir, encoding: 'utf8' },
    );

    assert.equal(run.status, 1);
    assert.match(run.stderr, /--format must be json, ndjson, sarif, github-annotations, or pr-comment/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A config large enough that its rendered output exceeds one pipe buffer.
 * `spawnSync` captures through a pipe, which is how CI harnesses and `| jq`
 * read Flecto -- and the only way this failure shows up.
 * @param {string} prefix
 * @param {number} keys
 * @returns {{ dir: string, file: string, snapshot: string }}
 */
function largeChangeProject(prefix, keys = 3000) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const file = join(dir, 'config.json');
  const snapshot = join(dir, 'snapshot.json');
  const after = {};
  const before = {};
  for (let i = 0; i < keys; i += 1) {
    after[`setting_number_${i}`] = i + 1;
    before[`setting_number_${i}`] = i;
  }
  writeFileSync(file, JSON.stringify(after), 'utf8');
  writeFileSync(snapshot, JSON.stringify({ state: before }), 'utf8');
  return { dir, file, snapshot };
}

test('ci --format json does not truncate large output through a pipe', () => {
  // process.exit() does not flush a pending stdout write, and Node writes to a
  // pipe asynchronously -- so output past the 64 KB pipe buffer was silently
  // lost while the command still exited 1 for "changes found". A truncated
  // envelope stream that reports normally is the worst shape for a consumer:
  // it reads as a clean run over fewer files rather than as a failure.
  const { dir, file, snapshot } = largeChangeProject('flecto-flush-json-');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    const run = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--format', 'json'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );

    assert.ok(
      Buffer.byteLength(run.stdout, 'utf8') > 65536,
      'fixture must exceed one pipe buffer or the test proves nothing',
    );
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].envelope.changes.length, 3000);
    assert.equal(run.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci --format ndjson does not truncate large output through a pipe', () => {
  const { dir, file, snapshot } = largeChangeProject('flecto-flush-ndjson-');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    const run = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--format', 'ndjson'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );

    assert.ok(Buffer.byteLength(run.stdout, 'utf8') > 65536);
    const lines = run.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).envelope.changes.length, 3000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci --format github-annotations does not truncate large output', () => {
  const { dir, file, snapshot } = largeChangeProject('flecto-flush-annot-');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    const run = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--format', 'github-annotations'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );

    assert.ok(Buffer.byteLength(run.stdout, 'utf8') > 65536);
    const lines = run.stdout.trim().split('\n');
    assert.equal(lines.length, 3000);
    assert.ok(lines.every((line) => line.startsWith('::warning file=')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci --format sarif does not truncate large output through a pipe', () => {
  // SARIF is uploaded to GitHub code scanning, so a truncated document is
  // rejected by the upload action rather than merely losing findings -- but
  // only after the gate has already reported success.
  // SARIF carries policy findings rather than change events, so the fixture
  // needs findings: a plugin raises one per change.
  const { dir, file, snapshot } = largeChangeProject('flecto-flush-sarif-');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    const plugin = join(dir, 'one-per-change.mjs');
    writeFileSync(
      plugin,
      'export function evaluate(changes) {\n'
      + '  return changes.map((change) => ({\n'
      + "    id: 'one-per-change',\n"
      + "    severity: 'warn',\n"
      + '    path: change.path,\n'
      + '    message: `${change.path} moved from ${change.before} to ${change.after}.`,\n'
      + '  }));\n'
      + '}\n',
      'utf8',
    );

    const run = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--format', 'sarif', '--plugins', plugin],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );

    assert.ok(
      Buffer.byteLength(run.stdout, 'utf8') > 65536,
      `fixture must exceed one pipe buffer, got ${Buffer.byteLength(run.stdout, 'utf8')}`,
    );
    const sarif = JSON.parse(run.stdout);
    assert.equal(sarif.version, '2.1.0');
    assert.equal(sarif.runs[0].results.length, 3000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci --format pr-comment arrives whole, because its body is capped first', () => {
  // pr-comment was never exposed to this: the renderer caps the body at 60,000
  // characters to fit GitHub's comment limit, which lands under one pipe
  // buffer. Pinned so that raising the cap past 64 KB cannot silently
  // reintroduce truncation on a path that looks unrelated to it.
  const { dir, file, snapshot } = largeChangeProject('flecto-flush-prc-');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    const run = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--format', 'pr-comment'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );

    assert.match(run.stdout, /Report truncated to fit GitHub's comment size limit\./);
    assert.ok(
      Buffer.byteLength(run.stdout, 'utf8') < 65536,
      'a pr-comment body over one pipe buffer would need the flush path too',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a payload that already ends in a newline keeps both newlines', () => {
  // console.log appends a newline unconditionally, so a pr-comment body -- which
  // ends in one -- was printed with two. Appending only when one is missing
  // would silently drop a byte from that format. Caught by diffing real output
  // against main; nothing else in the suite would have noticed.
  const dir = mkdtempSync(join(tmpdir(), 'flecto-flush-newline-'));
  const file = join(dir, 'config.json');
  const snapshot = join(dir, 'snapshot.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    writeFileSync(file, JSON.stringify({ a: 2 }), 'utf8');
    writeFileSync(snapshot, JSON.stringify({ state: { a: 1 } }), 'utf8');

    const run = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--format', 'pr-comment'],
      { encoding: 'utf8' },
    );
    assert.ok(run.stdout.endsWith('\n\n'), JSON.stringify(run.stdout.slice(-12)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('small output is byte-identical to what the previous writer produced', () => {
  // The payload is now assembled and written once instead of line by line.
  // That is a flush concern, not a formatting one: the bytes must not move.
  const dir = mkdtempSync(join(tmpdir(), 'flecto-flush-shape-'));
  const file = join(dir, 'config.json');
  const snapshot = join(dir, 'snapshot.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    writeFileSync(file, JSON.stringify({ a: 2, b: 3 }), 'utf8');
    writeFileSync(snapshot, JSON.stringify({ state: { a: 1, b: 3 } }), 'utf8');

    const json = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--format', 'json'],
      { encoding: 'utf8' },
    );
    assert.equal(json.stdout, `${JSON.stringify(JSON.parse(json.stdout), null, 2)}\n`);

    const ndjson = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--format', 'ndjson'],
      { encoding: 'utf8' },
    );
    assert.ok(ndjson.stdout.endsWith('\n'));
    assert.equal(ndjson.stdout.trim().split('\n').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
