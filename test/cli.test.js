import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';

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

