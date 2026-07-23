import { test } from 'node:test';
import assert from 'node:assert/strict';

import { maskChangeEvent } from '../src/renderer.js';

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
