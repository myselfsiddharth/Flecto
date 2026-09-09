import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import {
  DEFAULT_SHARED_RETENTION,
  isMaskedDigest,
  maskState,
  resolveSnapshotStore,
  stableStringify,
} from '../src/snapshot-store.js';
import { withDocumentKeys } from '../src/documents.js';

const ROOT_INDEX = resolve(process.cwd(), 'index.js');

/** A value the entropy gate recognizes, so masking has something to act on. */
const SECRET = '9f8Kd2mQx7RtVw3ZaLpB6HnCjE4sYuT1';
const ROTATED_SECRET = 'xQ7vLp2ZmR9tKw3NbHs6YcJd8FgA5eU0';

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sharedStore(dir, options = {}) {
  return resolveSnapshotStore({ store: 'shared', cwd: dir, ...options });
}

test('shared store keys snapshots by repo-relative path, one file per config file', () => {
  withTempDir('flecto-store-key-', (dir) => {
    mkdirSync(join(dir, 'config'), { recursive: true });
    const file = join(dir, 'config', 'prod.yaml');
    writeFileSync(file, 'replicas: 2\n', 'utf8');

    const store = sharedStore(dir);
    const { path } = store.write(file, { state: { replicas: 2 }, createdAt: '2026-09-08T00:00:00.000Z' });

    assert.equal(path, join(dir, '.flecto', 'snapshots', 'config', 'prod.yaml.json'));
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    // The stored key is repo-relative and POSIX-slashed: the same file on a CI
    // runner has a different absolute path and must still resolve to this entry.
    assert.equal(stored.file, 'config/prod.yaml');
    assert.equal(stored.masking, 'hash');
    assert.equal(stored.snapshots.length, 1);
    assert.deepEqual(stored.snapshots[0].state, { replicas: 2 });
  });
});

test('a shared store written on one machine reads back at a different absolute path', () => {
  withTempDir('flecto-store-move-', (origin) => {
    mkdirSync(join(origin, 'config'), { recursive: true });
    const file = join(origin, 'config', 'prod.yaml');
    writeFileSync(file, 'replicas: 2\n', 'utf8');
    sharedStore(origin).write(file, { state: { replicas: 2 } });

    withTempDir('flecto-store-runner-', (runner) => {
      // What an ephemeral runner does: check the repository out somewhere else
      // entirely. The local store keys by absolute path and would find nothing.
      const checkout = join(runner, 'checkout');
      cpSync(origin, checkout, { recursive: true });

      const record = sharedStore(checkout).readLatest(join(checkout, 'config', 'prod.yaml'));
      assert.ok(record, 'the snapshot written in the origin checkout is visible here');
      assert.deepEqual(record.state, { replicas: 2 });

      const local = resolveSnapshotStore({ store: 'local', cwd: checkout });
      assert.equal(local.readLatest(join(checkout, 'config', 'prod.yaml')), null);
    });
  });
});

test('shared store serialization is stable under key reordering', () => {
  withTempDir('flecto-store-stable-', (dir) => {
    const file = join(dir, 'app.json');
    writeFileSync(file, '{}', 'utf8');

    const first = sharedStore(dir);
    const { path } = first.write(file, {
      state: { zebra: 1, alpha: { nested: true, another: 'x' }, list: [{ b: 2, a: 1 }] },
      createdAt: '2026-09-08T00:00:00.000Z',
    });
    const before = readFileSync(path, 'utf8');
    rmSync(path);

    // Same configuration, keys written in a different order: a store that
    // preserved insertion order would rewrite every line below the moved key.
    sharedStore(dir).write(file, {
      state: { alpha: { another: 'x', nested: true }, list: [{ a: 1, b: 2 }], zebra: 1 },
      createdAt: '2026-09-08T00:00:00.000Z',
    });
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.match(before, /\n$/, 'the file ends with a newline, so appends stay one-line diffs');
  });
});

test('stableStringify sorts every level and leaves arrays in order', () => {
  assert.equal(
    stableStringify({ b: 1, a: { d: 2, c: [3, 1, 2] } }),
    '{\n  "a": {\n    "c": [\n      3,\n      1,\n      2\n    ],\n    "d": 2\n  },\n  "b": 1\n}',
  );
});

test('a shared store masks secret-like values into digests by default', () => {
  withTempDir('flecto-store-mask-', (dir) => {
    const file = join(dir, 'app.yaml');
    writeFileSync(file, 'x: 1\n', 'utf8');

    const store = sharedStore(dir);
    const { path } = store.write(file, { state: { apiKey: SECRET, replicas: 2 } });
    const raw = readFileSync(path, 'utf8');

    assert.doesNotMatch(raw, new RegExp(SECRET), 'the plaintext secret never reaches the store');
    const stored = JSON.parse(raw);
    assert.ok(isMaskedDigest(stored.snapshots[0].state.apiKey));
    assert.equal(stored.snapshots[0].state.replicas, 2, 'ordinary values are untouched');
  });
});

test('a value is masked for its key name, not only for its shape', () => {
  // The half that shape-matching alone misses, and the half that matters most
  // for a store headed into a commit: `password: hunter2` is a credential and
  // looks like nothing. The terminal has always masked it by key name, and a
  // store that recorded it in plaintext would put in git history permanently
  // exactly what `--mask-secrets` considers too sensitive to print.
  const masked = maskState({
    database: { password: 'hunter2', host: 'db.internal', port: 5432 },
    api: { secret_key: 'correct-horse', timeout: 30 },
  });

  assert.ok(isMaskedDigest(masked.database.password));
  assert.ok(isMaskedDigest(masked.api.secret_key));
  assert.equal(masked.database.host, 'db.internal', 'ordinary values stay readable');
  assert.equal(masked.database.port, 5432);
  assert.equal(masked.api.timeout, 30);
});

test('a low-entropy credential under a secret key still reports when it rotates', () => {
  const before = maskState({ db: { password: 'hunter2' } });
  const after = maskState({ db: { password: 'hunter3' } });
  assert.notEqual(before.db.password, after.db.password);
  assert.deepEqual(maskState(before), before, 'and masking stays idempotent');
});

test('a non-string credential is masked too, because a password can parse as a number', () => {
  const masked = maskState({ password: 12345, enabled: true });
  assert.ok(isMaskedDigest(masked.password));
  assert.equal(masked.enabled, true);
});

test('an absent value under a secret key is left absent rather than digested', () => {
  // Digesting `null` would invent a secret where the config says there is none,
  // and make an unset password look like a set one in review.
  assert.deepEqual(maskState({ password: null }), { password: null });
});

test('a document named token-service does not mask every value inside it', () => {
  // Same rule the renderer follows through `secretMatchPath`: a document
  // identity is a resource name the user chose, not a key name. Masking on it
  // would collapse a whole document into digests and hide all real drift in it.
  const state = withDocumentKeys({
    'Deployment/prod/token-service': { replicas: 3, image: 'app:1.2.3', password: 'hunter2' },
  }, ['Deployment/prod/token-service']);

  const masked = maskState(state);
  const doc = masked['Deployment/prod/token-service'];
  assert.equal(doc.replicas, 3, 'the document name is not a secret key name');
  assert.equal(doc.image, 'app:1.2.3');
  assert.ok(isMaskedDigest(doc.password), 'a genuinely sensitive key inside it is still masked');
});

test('the shared store the CLI writes carries no plaintext credential', () => {
  withTempDir('flecto-store-keymask-', (dir) => {
    const file = join(dir, 'prod.yaml');
    writeFileSync(file, 'database:\n  password: hunter2\n  host: db.internal\n', 'utf8');

    const { path } = sharedStore(dir).write(file, {
      state: { database: { password: 'hunter2', host: 'db.internal' } },
    });
    const raw = readFileSync(path, 'utf8');
    assert.doesNotMatch(raw, /hunter2/, 'the committed file holds no plaintext password');
    assert.match(raw, /db\.internal/, 'and stays reviewable for everything else');
  });
});

test('a masked store still detects a rotated secret, because the digest changes', () => {
  const before = maskState({ apiKey: SECRET });
  const after = maskState({ apiKey: ROTATED_SECRET });
  assert.notEqual(before.apiKey, after.apiKey);
  // ...and is idempotent, so re-masking a store full of digests is a no-op.
  assert.deepEqual(maskState(before), before);
});

test('--snapshot-mask none opts out, and the store records which form it holds', () => {
  withTempDir('flecto-store-unmasked-', (dir) => {
    const file = join(dir, 'app.yaml');
    writeFileSync(file, 'x: 1\n', 'utf8');

    const { path } = sharedStore(dir, { mask: 'none' }).write(file, { state: { apiKey: SECRET } });
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(stored.masking, 'none');
    assert.equal(stored.snapshots[0].state.apiKey, SECRET);

    // Switching masking mid-history is reported, because every masked value in
    // the next diff will read as changed.
    const result = sharedStore(dir).write(file, { state: { apiKey: SECRET } });
    assert.match(String(result.warning), /masking "none" and this run uses "hash"/);
  });
});

test('the shared store prunes to its retention, oldest first', () => {
  withTempDir('flecto-store-retention-', (dir) => {
    const file = join(dir, 'app.yaml');
    writeFileSync(file, 'x: 1\n', 'utf8');

    let lastResult;
    for (let index = 0; index < 5; index += 1) {
      lastResult = sharedStore(dir, { retention: 3 }).write(file, {
        state: { index },
        createdAt: `2026-09-0${index + 1}T00:00:00.000Z`,
      });
    }

    assert.equal(lastResult.pruned, 1, 'each write past the cap drops exactly one entry');
    const stored = JSON.parse(readFileSync(lastResult.path, 'utf8'));
    assert.equal(stored.snapshots.length, 3);
    assert.deepEqual(stored.snapshots.map((entry) => entry.state.index), [2, 3, 4]);
    assert.equal(DEFAULT_SHARED_RETENTION, 20, 'the documented default');
  });
});

test('the shared store refuses a file it cannot key repo-relatively', () => {
  withTempDir('flecto-store-outside-', (dir) => {
    withTempDir('flecto-store-elsewhere-', (elsewhere) => {
      const outside = join(elsewhere, 'app.yaml');
      writeFileSync(outside, 'x: 1\n', 'utf8');
      assert.throws(
        () => sharedStore(dir).write(outside, { state: { x: 1 } }),
        /keys snapshots by repo-relative path/,
      );
    });
  });
});

test('an unmasked local snapshot is byte-for-byte what it was before the store existed', () => {
  withTempDir('flecto-store-compat-', (dir) => {
    const file = join(dir, 'app.json');
    writeFileSync(file, '{"a":1}', 'utf8');

    const store = resolveSnapshotStore({ store: 'local', cwd: dir });
    const { path } = store.write(file, { state: { a: 1 }, createdAt: '2026-09-08T00:00:00.000Z' });

    assert.equal(
      readFileSync(path, 'utf8'),
      JSON.stringify({ file, state: { a: 1 }, createdAt: '2026-09-08T00:00:00.000Z' }, null, 2),
    );
    assert.equal(store.maskMode, 'none', 'the local store does not mask unless asked');
    assert.equal(store.retention, 0, 'and keeps everything, as it always has');
  });
});

test('the local store still promotes a pre-history baseline into history', () => {
  withTempDir('flecto-store-legacy-', (dir) => {
    const file = join(dir, 'app.json');
    writeFileSync(file, '{"a":2}', 'utf8');
    const storeDir = join(dir, '.flecto-snapshots');

    const baseline = resolveSnapshotStore({ store: 'local', cwd: dir })
      .write(file, { state: { a: 1 }, createdAt: '2026-09-01T00:00:00.000Z' });
    // Recreate the shape of a store written before timestamped history existed:
    // a `<id>.json` baseline and nothing else.
    for (const name of readdirSync(storeDir)) {
      if (/^[a-f0-9]{16}\.\d+\.json$/.test(name)) rmSync(join(storeDir, name));
    }
    assert.ok(existsSync(baseline.path));

    resolveSnapshotStore({ store: 'local', cwd: dir })
      .write(file, { state: { a: 2 }, createdAt: '2026-09-02T00:00:00.000Z' });

    const history = resolveSnapshotStore({ store: 'local', cwd: dir }).readHistory();
    assert.deepEqual(
      history.map((record) => record.state.a).sort(),
      [1, 2],
      'the legacy baseline survives as a history entry',
    );
  });
});

test('ci reads a committed shared store on a checkout that never wrote one', () => {
  withTempDir('flecto-store-ci-', (origin) => {
    mkdirSync(join(origin, 'config'), { recursive: true });
    const file = join(origin, 'config', 'prod.yaml');
    writeFileSync(file, 'replicas: 2\n', 'utf8');

    const snapshot = spawnSync(
      process.execPath,
      [ROOT_INDEX, 'watch', 'config/prod.yaml', '--snapshot', '--snapshot-store', 'shared'],
      { cwd: origin, encoding: 'utf8' },
    );
    assert.equal(snapshot.status, 0, snapshot.stderr);
    assert.match(snapshot.stderr, /commit \.flecto\/snapshots\//);

    withTempDir('flecto-store-ci-runner-', (runner) => {
      const checkout = join(runner, 'checkout');
      cpSync(origin, checkout, { recursive: true });
      writeFileSync(join(checkout, 'config', 'prod.yaml'), 'replicas: 5\n', 'utf8');

      const ci = spawnSync(
        process.execPath,
        [ROOT_INDEX, 'ci', 'config/prod.yaml', '--snapshot-store', 'shared', '--fail-on', 'changed'],
        { cwd: checkout, encoding: 'utf8' },
      );
      assert.equal(ci.status, 1, ci.stderr);
      const [{ envelope }] = JSON.parse(ci.stdout);
      assert.equal(envelope.changes.length, 1);
      assert.equal(envelope.changes[0].path, 'replicas');
      assert.equal(envelope.changes[0].before, 2);
      assert.equal(envelope.changes[0].after, 5);
    });
  });
});

test('a masked shared store reports a rotated secret and stays quiet otherwise', () => {
  withTempDir('flecto-store-ci-mask-', (dir) => {
    const file = join(dir, 'app.yaml');
    writeFileSync(file, `apiKey: ${SECRET}\nreplicas: 2\n`, 'utf8');

    const snapshot = spawnSync(
      process.execPath,
      [ROOT_INDEX, 'watch', 'app.yaml', '--snapshot', '--snapshot-store', 'shared'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(snapshot.status, 0, snapshot.stderr);

    // Unchanged file: masking both sides means the digest matches itself, so a
    // masked store does not invent drift on every run.
    const clean = spawnSync(
      process.execPath,
      [ROOT_INDEX, 'ci', 'app.yaml', '--snapshot-store', 'shared', '--fail-on', 'changed'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(clean.status, 0, clean.stderr);

    writeFileSync(file, `apiKey: ${ROTATED_SECRET}\nreplicas: 2\n`, 'utf8');
    const rotated = spawnSync(
      process.execPath,
      [ROOT_INDEX, 'ci', 'app.yaml', '--snapshot-store', 'shared', '--fail-on', 'changed'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(rotated.status, 1, rotated.stderr);
    const [{ envelope }] = JSON.parse(rotated.stdout);
    assert.equal(envelope.changes.length, 1);
    assert.equal(envelope.changes[0].path, 'apiKey');
    // The rotation is visible; neither key is.
    assert.ok(isMaskedDigest(envelope.changes[0].before));
    assert.ok(isMaskedDigest(envelope.changes[0].after));
    assert.doesNotMatch(rotated.stdout, new RegExp(SECRET));
    assert.doesNotMatch(rotated.stdout, new RegExp(ROTATED_SECRET));
  });
});

test('history and report name the store they read, and say when it is empty', () => {
  withTempDir('flecto-store-history-', (dir) => {
    const file = join(dir, 'app.yaml');
    writeFileSync(file, 'replicas: 2\n', 'utf8');

    const empty = spawnSync(
      process.execPath,
      [ROOT_INDEX, 'history', '--snapshot-store', 'shared'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /No snapshots found in \.flecto\/snapshots\//);
    assert.match(empty.stderr, /no history is not no drift/);

    for (const replicas of [2, 5]) {
      writeFileSync(file, `replicas: ${replicas}\n`, 'utf8');
      const run = spawnSync(
        process.execPath,
        [ROOT_INDEX, 'watch', 'app.yaml', '--snapshot', '--snapshot-store', 'shared'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(run.status, 0, run.stderr);
    }

    const history = spawnSync(
      process.execPath,
      [ROOT_INDEX, 'history', '--snapshot-store', 'shared'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(history.status, 0, history.stderr);
    assert.match(history.stdout, /Snapshot history from \.flecto\/snapshots\/ \(2 snapshots, shared store\)/);
    assert.match(history.stdout, /1 change/);

    const report = spawnSync(
      process.execPath,
      [ROOT_INDEX, 'report', '--snapshot-store', 'shared', '--output', 'report.html'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(report.status, 0, report.stderr);
    assert.match(readFileSync(join(dir, 'report.html'), 'utf8'), /\.flecto\/snapshots\//);
  });
});

test('the store selection is validated rather than silently falling back', () => {
  withTempDir('flecto-store-invalid-', (dir) => {
    writeFileSync(join(dir, 'app.yaml'), 'replicas: 2\n', 'utf8');
    const run = spawnSync(
      process.execPath,
      [ROOT_INDEX, 'history', '--snapshot-store', 'redis'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(run.status, 1);
    assert.match(run.stderr, /--snapshot-store must be one of: local, shared/);
  });
});

test('the store can be selected from .flectorc, so CI and the laptop agree', () => {
  withTempDir('flecto-store-rc-', (dir) => {
    writeFileSync(join(dir, 'app.yaml'), 'replicas: 2\n', 'utf8');
    writeFileSync(
      join(dir, '.flectorc.json'),
      JSON.stringify({ defaults: { snapshotStore: 'shared' } }),
      'utf8',
    );

    const snapshot = spawnSync(
      process.execPath,
      [ROOT_INDEX, 'watch', 'app.yaml', '--snapshot'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(snapshot.status, 0, snapshot.stderr);
    assert.ok(existsSync(join(dir, '.flecto', 'snapshots', 'app.yaml.json')));

    writeFileSync(join(dir, 'app.yaml'), 'replicas: 3\n', 'utf8');
    const ci = spawnSync(
      process.execPath,
      [ROOT_INDEX, 'ci', 'app.yaml', '--fail-on', 'changed'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(ci.status, 1, ci.stderr);
  });
});

test('a malformed shared store file is an error, never a silently empty baseline', () => {
  withTempDir('flecto-store-malformed-', (dir) => {
    const file = join(dir, 'app.yaml');
    writeFileSync(file, 'replicas: 2\n', 'utf8');
    const storePath = join(dir, '.flecto', 'snapshots', 'app.yaml.json');
    mkdirSync(join(dir, '.flecto', 'snapshots'), { recursive: true });

    writeFileSync(storePath, '{ not json', 'utf8');
    assert.throws(() => sharedStore(dir).readLatest(file), /is not valid JSON/);

    writeFileSync(storePath, JSON.stringify({ version: 1, file: 'app.yaml' }), 'utf8');
    assert.throws(() => sharedStore(dir).readLatest(file), /expected a "snapshots" array/);

    writeFileSync(storePath, JSON.stringify({ version: 1, snapshots: [] }), 'utf8');
    assert.throws(() => sharedStore(dir).readHistory(), /missing its "file" key/);
  });
});

test('--snapshot-dir moves the store without changing anything else', () => {
  withTempDir('flecto-store-dir-', (dir) => {
    const file = join(dir, 'app.yaml');
    writeFileSync(file, 'replicas: 2\n', 'utf8');

    const snapshot = spawnSync(
      process.execPath,
      [ROOT_INDEX, 'watch', 'app.yaml', '--snapshot', '--snapshot-store', 'shared',
        '--snapshot-dir', 'baselines'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(snapshot.status, 0, snapshot.stderr);
    assert.ok(existsSync(join(dir, 'baselines', 'app.yaml.json')));
    assert.ok(!existsSync(join(dir, '.flecto')));

    writeFileSync(file, 'replicas: 4\n', 'utf8');
    const diff = spawnSync(
      process.execPath,
      [ROOT_INDEX, 'watch', 'app.yaml', '--diff', '--snapshot-store', 'shared',
        '--snapshot-dir', 'baselines'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(diff.status, 1);
    assert.match(diff.stdout, /replicas/);
  });
});

test('--snapshot-retention prunes the local store too, when asked', () => {
  withTempDir('flecto-store-local-retention-', (dir) => {
    const file = join(dir, 'app.yaml');
    for (const replicas of [1, 2, 3]) {
      writeFileSync(file, `replicas: ${replicas}\n`, 'utf8');
      const run = spawnSync(
        process.execPath,
        [ROOT_INDEX, 'watch', 'app.yaml', '--snapshot', '--snapshot-retention', '2'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(run.status, 0, run.stderr);
    }

    const history = resolveSnapshotStore({ store: 'local', cwd: dir }).readHistory();
    assert.equal(history.length, 2, 'the oldest entry was pruned');
    assert.deepEqual(history.map((record) => record.state.replicas).sort(), [2, 3]);
  });
});

test('a multi-document file keeps its document identity through a shared store', () => {
  withTempDir('flecto-store-multidoc-', (dir) => {
    const file = join(dir, 'k8s.yaml');
    writeFileSync(
      file,
      'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  replicas: 2\n'
      + '---\napiVersion: v1\nkind: Service\nmetadata:\n  name: api\n',
      'utf8',
    );

    const snapshot = spawnSync(
      process.execPath,
      [ROOT_INDEX, 'watch', 'k8s.yaml', '--snapshot', '--snapshot-store', 'shared'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(snapshot.status, 0, snapshot.stderr);

    const stored = JSON.parse(readFileSync(join(dir, '.flecto', 'snapshots', 'k8s.yaml.json'), 'utf8'));
    assert.ok(stored.snapshots[0].documents.length > 0, 'the synthetic document keys are recorded');

    const record = sharedStore(dir).readLatest(file);
    assert.ok(Object.keys(record.state).some((key) => key.startsWith('Deployment/')));
  });
});
