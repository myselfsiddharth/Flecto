import { test } from 'node:test';
import assert from 'node:assert/strict';

import { maskChangeEvent, renderChanges, renderDiff } from '../src/renderer.js';

/**
 * Capture console.log output produced by fn.
 * @param {() => void} fn
 * @returns {string}
 */
function captureStdout(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = original;
  }
  // Strip ANSI styling so assertions do not depend on chalk's color support.
  return lines.join('\n').replaceAll(/\[[0-9;]*m/g, '');
}

test('maskChangeEvent recursively masks secrets in parent object changes', () => {
  const event = {
    type: 'changed',
    path: 'database',
    before: {
      api_key: 'old-secret',
      host: 'db.example.test',
      connection: { password: 'old-password' },
    },
    after: {
      api_key: 'new-secret',
      host: 'db.internal.test',
      connection: { password: 'new-password' },
    },
  };

  assert.deepEqual(maskChangeEvent(event), {
    ...event,
    before: {
      api_key: '***',
      host: 'db.example.test',
      connection: { password: '***' },
    },
    after: {
      api_key: '***',
      host: 'db.internal.test',
      connection: { password: '***' },
    },
  });
});

test('maskChangeEvent preserves Date values while masking sibling secrets', () => {
  const timestamp = new Date('2026-07-23T00:00:00.000Z');
  const masked = maskChangeEvent({
    type: 'added',
    path: 'metadata',
    after: {
      updated_at: timestamp,
      api_key: 'secret',
    },
  });

  assert.strictEqual(masked.after.updated_at, timestamp);
  assert.equal(masked.after.api_key, '***');
});

test('renderChanges masks nested secrets under a benign path', () => {
  const output = captureStdout(() => renderChanges(
    'config.json',
    [
      {
        type: 'added',
        path: 'database',
        after: { host: 'db.internal.test', password: 'hunter2', pool: { api_key: 'sk-live' } },
      },
      {
        type: 'changed',
        path: 'services[0].env',
        before: { token: 'old-token' },
        after: { token: 'new-token' },
      },
    ],
    'compact',
    { maskSecrets: true },
  ));

  assert.doesNotMatch(output, /hunter2|sk-live|old-token|new-token/);
  assert.match(output, /"password":"\*\*\*"/);
  assert.match(output, /"api_key":"\*\*\*"/);
  assert.match(output, /db\.internal\.test/);
});

test('renderChanges leaves values untouched when masking is disabled', () => {
  const output = captureStdout(() => renderChanges(
    'config.json',
    [{ type: 'added', path: 'database', after: { password: 'hunter2' } }],
    'compact',
  ));

  assert.match(output, /hunter2/);
});

test('renderChanges still masks whole values on secret-looking paths', () => {
  const output = captureStdout(() => renderChanges(
    'config.json',
    [{ type: 'changed', path: 'api_key', before: 'old', after: 'new' }],
    'verbose',
    { maskSecrets: true },
  ));

  assert.doesNotMatch(output, /"old"|"new"/);
  assert.match(output, /"\*\*\*"/);
});

test('renderDiff masks nested secrets in arrays', () => {
  const output = captureStdout(() => renderDiff(
    'config.json',
    [{ type: 'added', path: 'users', after: [{ name: 'admin', token: 't0ken' }] }],
    { maskSecrets: true },
  ));

  assert.doesNotMatch(output, /t0ken/);
  assert.match(output, /"token":"\*\*\*"/);
  assert.match(output, /"name":"admin"/);
});
