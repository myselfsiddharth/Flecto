import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawn, spawnSync } from 'child_process';

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

