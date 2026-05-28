import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWatcher } from '../src/watcher.js';

test('watcher emits semantic change events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-watcher-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ a: 1 }, null, 2), 'utf8');

  const events = [];
  const watcher = startWatcher(file, { polling: true, interval: 25, ignorePaths: [] }, (event) => {
    events.push(event);
  });

  await new Promise((r) => setTimeout(r, 250));
  writeFileSync(file, JSON.stringify({ a: 2 }, null, 2), 'utf8');
  await new Promise((r) => setTimeout(r, 500));
  await watcher.close();
  rmSync(dir, { recursive: true, force: true });

  const changeEvent = events.find((e) => e.kind === 'changes');
  assert.ok(changeEvent, 'Expected at least one change event');
  assert.equal(changeEvent.events[0].path, 'a');
});

