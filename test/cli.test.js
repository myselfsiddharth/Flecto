import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

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

