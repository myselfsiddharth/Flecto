import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { diffTrees } from '../src/differ.js';

// Helper: assert a single event exists with matching fields
function assertEvent(events, expected) {
  const match = events.find(e =>
    e.type === expected.type &&
    e.path === expected.path &&
    (expected.before === undefined || JSON.stringify(e.before) === JSON.stringify(expected.before)) &&
    (expected.after  === undefined || JSON.stringify(e.after)  === JSON.stringify(expected.after))
  );
  assert.ok(
    match,
    `Expected event ${JSON.stringify(expected)} not found.\nActual events:\n${JSON.stringify(events, null, 2)}`
  );
}

describe('diffTrees', () => {

  test('flat key change', () => {
    const events = diffTrees({ port: 3000 }, { port: 4000 });
    assert.equal(events.length, 1);
    assertEvent(events, { type: 'changed', path: 'port', before: 3000, after: 4000 });
  });

  test('nested key change', () => {
    const before = { database: { pool_size: 5 } };
    const after  = { database: { pool_size: 20 } };
    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assertEvent(events, { type: 'changed', path: 'database.pool_size', before: 5, after: 20 });
  });

  test('added key at top level', () => {
    const events = diffTrees({ a: 1 }, { a: 1, b: 2 });
    assert.equal(events.length, 1);
    assertEvent(events, { type: 'added', path: 'b', after: 2 });
  });

  test('removed key at top level', () => {
    const events = diffTrees({ a: 1, b: 2 }, { a: 1 });
    assert.equal(events.length, 1);
    assertEvent(events, { type: 'removed', path: 'b', before: 2 });
  });

  test('key reordering produces zero diff', () => {
    const before = { z: 1, a: 2, m: 3 };
    const after  = { a: 2, m: 3, z: 1 };
    const events = diffTrees(before, after);
    assert.equal(events.length, 0, 'Key reordering must not produce false positives');
  });

  test('array element added', () => {
    const before = { items: ['a', 'b'] };
    const after  = { items: ['a', 'b', 'c'] };
    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assertEvent(events, { type: 'added', path: 'items[2]', after: 'c' });
  });

  test('array element removed', () => {
    const before = { items: ['a', 'b', 'c'] };
    const after  = { items: ['a', 'b'] };
    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assertEvent(events, { type: 'removed', path: 'items[2]', before: 'c' });
  });

  test('array element changed', () => {
    const before = { items: [1, 2, 3] };
    const after  = { items: [1, 99, 3] };
    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assertEvent(events, { type: 'changed', path: 'items[1]', before: 2, after: 99 });
  });

  test('type change: string → number', () => {
    const events = diffTrees({ timeout: '30' }, { timeout: 30 });
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.type, 'changed');
    assert.equal(e.path, 'timeout');
    assert.ok(e.note && e.note.includes('string'), `Expected note to mention string, got: ${e.note}`);
    assert.ok(e.note && e.note.includes('number'), `Expected note to mention number, got: ${e.note}`);
  });

  test('type change: object → array', () => {
    const before = { data: { key: 1 } };
    const after  = { data: [1, 2, 3] };
    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.type, 'changed');
    assert.equal(e.path, 'data');
    assert.ok(e.note && e.note.includes('object'), `Expected note to mention object`);
    assert.ok(e.note && e.note.includes('array'), `Expected note to mention array`);
  });

  test('deeply nested change (3+ levels)', () => {
    const before = { server: { tls: { cert: '/old/cert.pem', key: '/old/key.pem' } } };
    const after  = { server: { tls: { cert: '/new/cert.pem', key: '/old/key.pem' } } };
    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assertEvent(events, {
      type: 'changed',
      path: 'server.tls.cert',
      before: '/old/cert.pem',
      after: '/new/cert.pem',
    });
  });

  test('empty object vs empty object → no diff', () => {
    const events = diffTrees({}, {});
    assert.equal(events.length, 0);
  });

  test('empty object → populated object', () => {
    const events = diffTrees({}, { a: 1, b: 2 });
    assert.equal(events.length, 2);
    assertEvent(events, { type: 'added', path: 'a', after: 1 });
    assertEvent(events, { type: 'added', path: 'b', after: 2 });
  });

  test('populated object → empty object', () => {
    const events = diffTrees({ a: 1, b: 2 }, {});
    assert.equal(events.length, 2);
    assertEvent(events, { type: 'removed', path: 'a', before: 1 });
    assertEvent(events, { type: 'removed', path: 'b', before: 2 });
  });

  test('no changes → empty array', () => {
    const obj = { host: 'localhost', port: 5432, tls: { enabled: true } };
    const events = diffTrees(obj, JSON.parse(JSON.stringify(obj)));
    assert.equal(events.length, 0);
  });

  test('multiple simultaneous changes', () => {
    const before = { a: 1, b: 'hello', c: true };
    const after  = { a: 2, b: 'world', c: true, d: 'new' };
    const events = diffTrees(before, after);
    assert.equal(events.length, 3); // a changed, b changed, d added
    assertEvent(events, { type: 'changed', path: 'a', before: 1, after: 2 });
    assertEvent(events, { type: 'changed', path: 'b', before: 'hello', after: 'world' });
    assertEvent(events, { type: 'added', path: 'd', after: 'new' });
  });

  test('ignorePaths filters out specified keys', () => {
    const before = { port: 3000, updated_at: '2024-01-01', host: 'localhost' };
    const after  = { port: 4000, updated_at: '2024-12-31', host: 'localhost' };
    const events = diffTrees(before, after, { ignorePaths: ['updated_at'] });
    assert.equal(events.length, 1);
    assertEvent(events, { type: 'changed', path: 'port', before: 3000, after: 4000 });
  });

  test('ignorePaths key-anywhere patterns match complete key segments only', () => {
    const before = {
      updated_at: 1,
      meta: { updated_at: 2, updated_at_backup: 3 },
      services: [{ updated_at: 4, updated_at_ms: 5 }],
    };
    const after = {
      updated_at: 10,
      meta: { updated_at: 20, updated_at_backup: 30 },
      services: [{ updated_at: 40, updated_at_ms: 50 }],
    };
    const events = diffTrees(before, after, { ignorePaths: ['**.updated_at'] });

    assert.equal(events.length, 2);
    assertEvent(events, {
      type: 'changed',
      path: 'meta.updated_at_backup',
      before: 3,
      after: 30,
    });
    assertEvent(events, {
      type: 'changed',
      path: 'services[0].updated_at_ms',
      before: 5,
      after: 50,
    });
  });

  test('nested array of objects', () => {
    const before = { servers: [{ host: 'a', port: 80 }, { host: 'b', port: 443 }] };
    const after  = { servers: [{ host: 'a', port: 80 }, { host: 'b', port: 8443 }] };
    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assertEvent(events, { type: 'changed', path: 'servers[1].port', before: 443, after: 8443 });
  });

  test('null value handling', () => {
    const before = { feature: null };
    const after  = { feature: 'enabled' };
    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assertEvent(events, { type: 'changed', path: 'feature', before: null, after: 'enabled' });
  });

  test('boolean toggle', () => {
    const events = diffTrees({ debug: false }, { debug: true });
    assert.equal(events.length, 1);
    assertEvent(events, { type: 'changed', path: 'debug', before: false, after: true });
  });

  test('root array diff does not crash', () => {
    const before = [{ a: 1 }, { a: 2 }];
    const after = [{ a: 1 }, { a: 3 }, { a: 4 }];
    const events = diffTrees(before, after);
    assertEvent(events, { type: 'changed', path: '[1].a', before: 2, after: 3 });
    assertEvent(events, { type: 'added', path: '[2]', after: { a: 4 } });
  });

  test('root scalar diff does not crash', () => {
    const events = diffTrees(1, 2);
    assert.equal(events.length, 1);
    assertEvent(events, { type: 'changed', path: '<root>', before: 1, after: 2 });
  });

  test('ignorePaths supports subtree prefix', () => {
    const before = { meta: { timestamp: 1, build: 1 }, a: 1 };
    const after = { meta: { timestamp: 2, build: 2 }, a: 2 };
    const events = diffTrees(before, after, { ignorePaths: ['meta'] });
    assert.equal(events.length, 1);
    assertEvent(events, { type: 'changed', path: 'a', before: 1, after: 2 });
  });

  test('ignorePaths supports wildcards by segment', () => {
    const before = { servers: [{ meta: { timestamp: 1 }, port: 80 }, { meta: { timestamp: 10 }, port: 443 }] };
    const after  = { servers: [{ meta: { timestamp: 2 }, port: 80 }, { meta: { timestamp: 11 }, port: 8443 }] };
    const events = diffTrees(before, after, { ignorePaths: ['servers[*].meta.timestamp'] });
    assert.equal(events.length, 1);
    assertEvent(events, { type: 'changed', path: 'servers[1].port', before: 443, after: 8443 });
  });

  test('ignorePaths supports key name anywhere (**.key)', () => {
    const before = { updated_at: 1, a: { updated_at: 2, x: 1 }, b: [{ updated_at: 3, y: 1 }] };
    const after  = { updated_at: 9, a: { updated_at: 8, x: 2 }, b: [{ updated_at: 7, y: 2 }] };
    const events = diffTrees(before, after, { ignorePaths: ['**.updated_at'] });
    assert.equal(events.length, 2);
    assertEvent(events, { type: 'changed', path: 'a.x', before: 1, after: 2 });
    assertEvent(events, { type: 'changed', path: 'b[0].y', before: 1, after: 2 });
  });

  test('arrays auto-detect id before name', () => {
    const before = {
      services: [
        { id: 'api', name: 'API v1', port: 3000 },
        { id: 'web', name: 'Website', port: 8080 },
      ],
    };
    const after = {
      services: [
        { id: 'web', name: 'Public website', port: 8080 },
        { id: 'api', name: 'API v1', port: 3000 },
      ],
    };

    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assertEvent(events, {
      type: 'changed',
      path: 'services["web"].name',
      before: 'Website',
      after: 'Public website',
    });
  });

  test('arrays auto-detect name when id is unavailable', () => {
    const before = { services: [{ name: 'api', port: 3000 }, { name: 'web', port: 8080 }] };
    const after = { services: [{ name: 'web', port: 8080 }, { name: 'api', port: 4000 }] };

    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assertEvent(events, {
      type: 'changed',
      path: 'services["api"].port',
      before: 3000,
      after: 4000,
    });
  });

  test('custom array identity key overrides auto-detection', () => {
    const before = { services: [{ id: 1, key: 'api', port: 3000 }, { id: 2, key: 'web', port: 8080 }] };
    const after = { services: [{ id: 2, key: 'web', port: 8080 }, { id: 1, key: 'api', port: 4000 }] };

    const events = diffTrees(before, after, { arrayIdKey: 'key' });
    assert.equal(events.length, 1);
    assertEvent(events, {
      type: 'changed',
      path: 'services["api"].port',
      before: 3000,
      after: 4000,
    });
  });

  test('arrayIdentity false restores index-based diffs', () => {
    const before = { services: [{ id: 'api', port: 3000 }, { id: 'web', port: 8080 }] };
    const after = { services: [{ id: 'web', port: 8080 }, { id: 'api', port: 3000 }] };

    const events = diffTrees(before, after, { arrayIdentity: false });
    assert.ok(events.length > 0);
    assertEvent(events, { type: 'changed', path: 'services[0].id', before: 'api', after: 'web' });
  });

  test('explicit arrayIdKey wins over arrayIdentity false', () => {
    const before = { services: [{ id: 1, key: 'api', port: 3000 }, { id: 2, key: 'web', port: 8080 }] };
    const after = { services: [{ id: 2, key: 'web', port: 8080 }, { id: 1, key: 'api', port: 4000 }] };

    const events = diffTrees(before, after, { arrayIdKey: 'key', arrayIdentity: false });
    assert.equal(events.length, 1);
    assertEvent(events, {
      type: 'changed',
      path: 'services["api"].port',
      before: 3000,
      after: 4000,
    });
  });

});
