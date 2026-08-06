import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { parseContent, parseYamlStream } from '../src/parser.js';
import { diffTrees } from '../src/differ.js';

const DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 2
`;

const SERVICE = `apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  port: 80
`;

describe('single-document YAML is unchanged', () => {
  test('plain document parses to the document itself', () => {
    const parsed = parseContent('config.yaml', 'port: 3000\ndatabase:\n  pool_size: 5\n');
    assert.deepEqual(parsed, { port: 3000, database: { pool_size: 5 } });
  });

  test('leading --- does not create a multi-document object', () => {
    const parsed = parseContent('config.yaml', '---\nport: 3000\n');
    assert.deepEqual(parsed, { port: 3000 });
  });

  test('trailing --- does not create a phantom document', () => {
    const parsed = parseContent('config.yaml', 'port: 3000\n---\n');
    assert.deepEqual(parsed, { port: 3000 });
  });

  test('leading and trailing --- around one document', () => {
    const parsed = parseContent('config.yaml', '---\nport: 3000\n---\n');
    assert.deepEqual(parsed, { port: 3000 });
  });

  test('single document keeps its diff paths', () => {
    const before = parseContent('config.yaml', 'database:\n  pool_size: 5\n');
    const after = parseContent('config.yaml', '---\ndatabase:\n  pool_size: 20\n');
    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assert.equal(events[0].path, 'database.pool_size');
  });

  test('empty file parses to an empty object', () => {
    assert.deepEqual(parseContent('config.yaml', ''), {});
  });

  test('file of separators only parses to an empty object', () => {
    assert.deepEqual(parseContent('config.yaml', '---\n---\n'), {});
  });

  test('a single null document parses to an empty object', () => {
    assert.deepEqual(parseContent('config.yaml', '---\nnull\n'), {});
  });

  test('scalar root document is preserved', () => {
    assert.equal(parseContent('config.yaml', '42\n'), 42);
  });

  test('array root document is preserved', () => {
    assert.deepEqual(parseContent('config.yaml', '- a\n- b\n'), ['a', 'b']);
  });
});

describe('multi-document YAML', () => {
  test('documents without identity are keyed by index', () => {
    const parsed = parseYamlStream('a: 1\n---\nb: 2\n');
    assert.deepEqual(parsed, { 0: { a: 1 }, 1: { b: 2 } });
  });

  test('kubernetes documents are keyed by kind/name', () => {
    const parsed = parseContent('manifest.yaml', `${DEPLOYMENT}---\n${SERVICE}`);
    assert.deepEqual(Object.keys(parsed), ['Deployment/api', 'Service/api']);
    assert.equal(parsed['Deployment/api'].spec.replicas, 2);
  });

  test('namespaced documents include the namespace', () => {
    const parsed = parseYamlStream(`kind: Deployment
metadata:
  name: api
  namespace: prod
---
kind: Deployment
metadata:
  name: api
  namespace: staging
`);
    assert.deepEqual(Object.keys(parsed), ['Deployment/prod/api', 'Deployment/staging/api']);
  });

  test('top-level id then name is used when there is no kind', () => {
    assert.deepEqual(
      Object.keys(parseYamlStream('id: alpha\nport: 1\n---\nid: beta\nport: 2\n')),
      ['alpha', 'beta']
    );
    assert.deepEqual(
      Object.keys(parseYamlStream('name: alpha\nport: 1\n---\nname: beta\nport: 2\n')),
      ['alpha', 'beta']
    );
  });

  test('duplicate identities fall back to index keys for the whole file', () => {
    const parsed = parseContent('manifest.yaml', `${DEPLOYMENT}---\n${DEPLOYMENT}`);
    assert.deepEqual(Object.keys(parsed), ['0', '1']);
  });

  test('a document missing identity forces index keys for the whole file', () => {
    const parsed = parseContent('manifest.yaml', `${DEPLOYMENT}---\nloose: true\n`);
    assert.deepEqual(Object.keys(parsed), ['0', '1']);
  });

  test('non-object documents are kept and keyed by index', () => {
    assert.deepEqual(parseYamlStream('--- 1\n--- 2\n'), { 0: 1, 1: 2 });
    assert.deepEqual(parseYamlStream('- a\n---\n- b\n'), { 0: ['a'], 1: ['b'] });
  });

  test('empty documents are dropped and do not shift keys', () => {
    assert.deepEqual(parseYamlStream('a: 1\n---\n---\nb: 2\n'), { 0: { a: 1 }, 1: { b: 2 } });
    assert.deepEqual(parseYamlStream('---\na: 1\n---\nb: 2\n---\n'), { 0: { a: 1 }, 1: { b: 2 } });
  });

  test('a document explicitly set to null is dropped', () => {
    assert.deepEqual(parseYamlStream('a: 1\n---\nnull\n---\nb: 2\n'), { 0: { a: 1 }, 1: { b: 2 } });
  });

  test('false and 0 documents are not mistaken for empty', () => {
    assert.deepEqual(parseYamlStream('--- false\n--- 0\n--- a: 1\n'), { 0: false, 1: 0, 2: { a: 1 } });
  });

  test('a __proto__ identity does not swallow the document', () => {
    const parsed = parseYamlStream('name: __proto__\nx: 1\n---\nname: b\ny: 2\n');
    assert.deepEqual(parsed, { 0: { name: '__proto__', x: 1 }, 1: { name: 'b', y: 2 } });
  });

  test('.yml is handled like .yaml', () => {
    assert.deepEqual(Object.keys(parseContent('manifest.yml', `${DEPLOYMENT}---\n${SERVICE}`)), [
      'Deployment/api',
      'Service/api',
    ]);
  });

  test('a syntax error still reports the file name', () => {
    assert.throws(
      () => parseContent('manifest.yaml', 'a: 1\n---\n\tb: 2\n'),
      /Parse error in "manifest.yaml"/
    );
  });
});

describe('multi-document YAML diffs', () => {
  test('a change inside one document reads on a stable path', () => {
    const before = parseContent('manifest.yaml', `${DEPLOYMENT}---\n${SERVICE}`);
    const after = parseContent(
      'manifest.yaml',
      `${DEPLOYMENT.replace('replicas: 2', 'replicas: 5')}---\n${SERVICE}`
    );
    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assert.equal(events[0].path, 'Deployment/api.spec.replicas');
    assert.equal(events[0].before, 2);
    assert.equal(events[0].after, 5);
  });

  test('inserting a document at the top does not shift other paths', () => {
    const configMap = 'kind: ConfigMap\nmetadata:\n  name: api\ndata:\n  level: info\n';
    const before = parseContent('manifest.yaml', `${DEPLOYMENT}---\n${SERVICE}`);
    const after = parseContent('manifest.yaml', `${configMap}---\n${DEPLOYMENT}---\n${SERVICE}`);
    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'added');
    assert.equal(events[0].path, 'ConfigMap/api');
  });

  test('removing a document reads as one removal', () => {
    const configMap = 'kind: ConfigMap\nmetadata:\n  name: api\ndata:\n  level: info\n';
    const before = parseContent('manifest.yaml', `${DEPLOYMENT}---\n${SERVICE}---\n${configMap}`);
    const after = parseContent('manifest.yaml', `${DEPLOYMENT}---\n${configMap}`);
    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'removed');
    assert.equal(events[0].path, 'Service/api');
  });

  test('dropping to a single document rewrites the tree', () => {
    // A one-document file is the document itself, so a file that goes from two
    // documents to one changes shape. Documented rather than silently accepted.
    const before = parseContent('manifest.yaml', `${DEPLOYMENT}---\n${SERVICE}`);
    const after = parseContent('manifest.yaml', DEPLOYMENT);
    const events = diffTrees(before, after);
    assert.ok(events.some((e) => e.type === 'removed' && e.path === 'Deployment/api'));
    assert.ok(events.some((e) => e.type === 'removed' && e.path === 'Service/api'));
    assert.ok(events.some((e) => e.type === 'added' && e.path === 'kind'));
  });

  test('index-keyed documents shift when one is inserted at the top', () => {
    const before = parseYamlStream('a: 1\n---\nb: 2\n');
    const after = parseYamlStream('c: 3\n---\na: 1\n---\nb: 2\n');
    const events = diffTrees(before, after);
    assert.ok(events.length > 1, 'index keys cannot survive an insertion');
  });

  test('ignore patterns apply inside a document', () => {
    const before = parseContent('manifest.yaml', `${DEPLOYMENT}---\n${SERVICE}`);
    const after = parseContent(
      'manifest.yaml',
      `${DEPLOYMENT.replace('replicas: 2', 'replicas: 5')}---\n${SERVICE}`
    );
    const events = diffTrees(before, after, { ignorePaths: ['Deployment/api'] });
    assert.equal(events.length, 0);
  });
});

test('ci reports a change inside a multi-document manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-multidoc-'));
  const file = join(dir, 'manifest.yaml');
  const snapshot = join(dir, 'snapshot.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    writeFileSync(file, `${DEPLOYMENT}---\n${SERVICE}`, 'utf8');
    writeFileSync(
      snapshot,
      JSON.stringify({ state: parseYamlStream(`${DEPLOYMENT.replace('replicas: 2', 'replicas: 1')}---\n${SERVICE}`) }),
      'utf8'
    );

    const run = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--format', 'json'],
      { encoding: 'utf8' }
    );

    // Default --fail-on includes "changed", so a change exits non-zero.
    assert.equal(run.status, 1);
    const changes = JSON.parse(run.stdout)[0].envelope.changes;
    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, 'Deployment/api.spec.replicas');
    assert.equal(changes[0].after, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
