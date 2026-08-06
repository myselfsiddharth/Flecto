import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWatcher } from '../src/watcher.js';

test('watcher emits semantic change events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-watcher-'));
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

test('watcher reports rejected async event handlers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-watcher-'));
  const file = join(dir, 'config.json');
  const warnings = [];
  const originalWarn = console.warn;
  writeFileSync(file, JSON.stringify({ a: 1 }, null, 2), 'utf8');
  console.warn = (message) => warnings.push(String(message));

  try {
    const watcher = startWatcher(
      file,
      { polling: true, interval: 25, ignorePaths: [] },
      async (event) => {
        if (event.kind === 'changes') {
          throw new Error('alert delivery failed');
        }
      },
    );

    await new Promise((r) => setTimeout(r, 250));
    writeFileSync(file, JSON.stringify({ a: 2 }, null, 2), 'utf8');
    await new Promise((r) => setTimeout(r, 500));
    await watcher.close();

    assert.ok(warnings.some((message) => message.includes('alert delivery failed')));
  } finally {
    console.warn = originalWarn;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watcher treats an initial JSON null root as a valid baseline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-watcher-null-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, 'null\n', 'utf8');
  const events = [];

  try {
    const watcher = startWatcher(file, { polling: true, interval: 25 }, (event) => {
      events.push(event);
    });
    await new Promise((r) => setTimeout(r, 250));
    writeFileSync(file, 'true\n', 'utf8');
    await new Promise((r) => setTimeout(r, 600));
    await watcher.close();

    const changeEvent = events.find((event) => event.kind === 'changes');
    assert.ok(changeEvent, 'Expected null to be retained as the initial baseline');
    assert.deepEqual(changeEvent.events[0], {
      type: 'changed',
      path: '<root>',
      before: null,
      after: true,
      note: 'type changed from object to boolean',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watcher keeps a successful null root between later changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-watcher-null-update-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ enabled: false }), 'utf8');
  const events = [];

  try {
    const watcher = startWatcher(file, { polling: true, interval: 25 }, (event) => {
      if (event.kind === 'changes') events.push(event);
    });
    await new Promise((r) => setTimeout(r, 250));
    writeFileSync(file, 'null\n', 'utf8');
    await new Promise((r) => setTimeout(r, 600));
    writeFileSync(file, 'true\n', 'utf8');
    await new Promise((r) => setTimeout(r, 600));
    await watcher.close();

    assert.equal(events.length, 2);
    assert.equal(events[0].events[0].after, null);
    assert.equal(events[1].events[0].before, null);
    assert.equal(events[1].events[0].after, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
