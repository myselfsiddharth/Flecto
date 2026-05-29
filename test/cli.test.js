import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

test('ci mode returns non-zero when fail-on changed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'driff-cli-'));
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

