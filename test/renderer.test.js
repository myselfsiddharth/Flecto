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
  return lines.join('\n').replaceAll(/\u001b\[[0-9;]*m/gu, '');
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

test('renderChanges masks secret-shaped values under innocuous keys', () => {
  const output = captureStdout(() => renderChanges(
    'config.json',
    [
      {
        type: 'changed',
        path: 'db.connstr',
        before: 'postgres://app:7Kq2vNbXp9TzR4wY@db.internal.example.test:5432/appdb',
        after: 'postgres://app:Rm4pXz9LtQ2vBn6W@db.internal.example.test:5432/appdb',
      },
      { type: 'added', path: 'integrations[0].value', after: 'AKIAIOSFODNN7EXAMPLE' },
      { type: 'added', path: 'service', after: { id: 'checkout', opaque: 'gT4kQ9wZ2mB7xL5nR8vC3jH6pY1sD0fA' } },
    ],
    'compact',
    { maskSecrets: true },
  ));

  assert.doesNotMatch(output, /7Kq2vNbXp9TzR4wY|Rm4pXz9LtQ2vBn6W|AKIAIOSFODNN7EXAMPLE|gT4kQ9wZ2mB7xL5nR8vC3jH6pY1sD0fA/);
  assert.match(output, /postgres:\/\/app:\*\*\*@db\.internal\.example\.test:5432\/appdb/);
  assert.match(output, /"opaque":"\*\*\*"/);
  assert.match(output, /"id":"checkout"/);
});

test('renderChanges leaves benign values alone while masking is on', () => {
  const benign = {
    host: 'db.internal.example.test',
    url: 'https://api.example.test/v1/charges',
    version: '2.1.0-rc.1',
    commit: '9f2b7c1a4d5e6f708192a3b4c5d6e7f8091a2b3c',
    trace_id: '550e8400-e29b-41d4-a716-446655440000',
    cache_dir: '/var/lib/Docker/Volumes/AppData2024/backups',
    image: 'ghcr.io/acme/checkout-service:1.14.2',
  };
  const output = captureStdout(() => renderChanges(
    'config.json',
    [{ type: 'added', path: 'service', after: benign }],
    'compact',
    { maskSecrets: true },
  ));

  assert.doesNotMatch(output, /\*\*\*/);
  for (const value of Object.values(benign)) {
    assert.ok(output.includes(value), `expected ${value} to survive masking`);
  }
});

test('renderChanges leaves secret-shaped values untouched when masking is off', () => {
  const output = captureStdout(() => renderChanges(
    'config.json',
    [{ type: 'added', path: 'db.connstr', after: 'AKIAIOSFODNN7EXAMPLE' }],
    'compact',
  ));

  assert.match(output, /AKIAIOSFODNN7EXAMPLE/);
});

test('maskChangeEvent redacts secret-shaped values under benign keys', () => {
  const masked = maskChangeEvent({
    type: 'changed',
    path: 'database',
    before: { host: 'db.internal.example.test', connstr: 'AKIAIOSFODNN7EXAMPLE' },
    after: { host: 'db.internal.example.test', connstr: 'ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5' },
  });

  assert.deepEqual(masked.before, { host: 'db.internal.example.test', connstr: '***' });
  assert.deepEqual(masked.after, { host: 'db.internal.example.test', connstr: '***' });
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
