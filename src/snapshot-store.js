import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { dirname, join, relative, resolve, sep } from 'path';

import { containsSecret } from './secrets.js';
import { documentKeysOf, withDocumentKeys } from './documents.js';

/**
 * Where snapshot history lives (#141).
 *
 * Until now there was one answer: `.flecto-snapshots/` in the working
 * directory, keyed by a hash of each file's **absolute** path. That is right for
 * a laptop and useless everywhere else — an ephemeral CI runner starts with an
 * empty directory on every run, and even a cached one would key `/home/runner/
 * work/repo/config/prod.yaml` differently from the `/Users/me/repo/...` the same
 * file has on the machine that wrote the snapshot. So `history` and `report` are
 * local-only by construction, and `ci` has to be handed `--snapshot-ref`.
 *
 * This module makes the store pluggable and adds one shared backend:
 *
 * - **`local`** — unchanged, still the default. Absolute-path hash, one
 *   `<id>.json` baseline plus timestamped history entries, written byte-for-byte
 *   as before so an existing `.flecto-snapshots/` keeps working.
 * - **`shared`** — a git-tracked store under `.flecto/snapshots/`, designed to be
 *   committed and read back on a runner that has never seen the file before.
 *
 * Four things make the shared store shareable, and each is a deliberate
 * difference from `local`:
 *
 * 1. **Keyed by repo-relative path**, resolved from the git top level, so the
 *    same config file has the same key on every checkout and from any
 *    subdirectory.
 * 2. **One file per config file**, holding that file's history oldest-first, so
 *    a new snapshot is an appended block in a diff rather than a new file with a
 *    hashed name nobody can review.
 * 3. **Stable serialization** — keys sorted at every level, one scalar per line.
 *    Reordering keys in the source config produces no diff at all, and a real
 *    change produces exactly the lines that changed.
 * 4. **Masking is a recorded property of the store**, defaulting to on, because
 *    committing snapshots writes config values into git history permanently.
 *
 * Masked values are stored as a digest rather than dropped or replaced with a
 * constant: `flecto:sha256:…` still *changes* when the underlying value
 * rotates, so a masked store detects "the production key was rotated" without
 * ever recording either key. The honest limitation is that a digest of a
 * low-entropy value can be brute-forced — it is a change detector, not a vault.
 */

export const SNAPSHOT_STORE_IDS = /** @type {const} */ (['local', 'shared']);
export const SNAPSHOT_MASK_MODES = /** @type {const} */ (['hash', 'none']);

export const LOCAL_SNAPSHOT_DIR = '.flecto-snapshots';
export const SHARED_SNAPSHOT_DIR = join('.flecto', 'snapshots');

/** Schema version of a shared-store file, for a future reshaping. */
export const SHARED_STORE_VERSION = 1;

/**
 * How many snapshots per file the shared store keeps. An append-forever store
 * inside a repository becomes its own problem, and drift is a recent-history
 * question — nobody reviews the 200th-oldest snapshot of `prod.yaml`.
 * `local` stays unbounded by default: it is not committed, and changing what an
 * existing directory holds is not this change's business.
 */
export const DEFAULT_SHARED_RETENTION = 20;

const MASK_PREFIX = 'flecto:sha256:';
const MASK_DIGEST_LENGTH = 12;

/**
 * @typedef {'local' | 'shared'} SnapshotStoreId
 * @typedef {'hash' | 'none'} SnapshotMaskMode
 *
 * @typedef {{
 *   file: string,
 *   state: unknown,
 *   documents?: string[],
 *   createdAt: string
 * }} SnapshotRecord
 *
 * @typedef {{
 *   id: SnapshotStoreId,
 *   root: string,
 *   label: string,
 *   maskMode: SnapshotMaskMode,
 *   retention: number,
 *   emptyHint: string,
 *   exists: () => boolean,
 *   readLatest: (absFile: string) => SnapshotRecord | null,
 *   readHistory: () => SnapshotRecord[],
 *   write: (absFile: string, record: { state: unknown, documents?: string[], createdAt?: string })
 *     => { path: string, pruned: number, warning?: string }
 * }} SnapshotStore
 */

/**
 * Validate and resolve the store selection into a store instance.
 * @param {{
 *   store?: unknown,
 *   dir?: unknown,
 *   mask?: unknown,
 *   retention?: unknown,
 *   cwd?: string
 * }} [options]
 * @returns {SnapshotStore}
 */
export function resolveSnapshotStore(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const id = normalizeStoreId(options.store);
  const maskMode = normalizeMaskMode(options.mask, id);
  const retention = normalizeRetention(options.retention, id);

  if (id === 'local') {
    const root = resolve(cwd, options.dir ? String(options.dir) : LOCAL_SNAPSHOT_DIR);
    return createLocalStore({ root, retention, maskMode, cwd });
  }

  const projectRoot = resolveProjectRoot(cwd);
  const root = options.dir
    ? resolve(cwd, String(options.dir))
    : resolve(projectRoot, SHARED_SNAPSHOT_DIR);
  return createSharedStore({ root, projectRoot, retention, maskMode });
}

/**
 * @param {unknown} raw
 * @returns {SnapshotStoreId}
 */
function normalizeStoreId(raw) {
  if (raw === undefined || raw === null || raw === '') return 'local';
  const id = String(raw);
  if (!SNAPSHOT_STORE_IDS.includes(/** @type {SnapshotStoreId} */ (id))) {
    throw new Error(`--snapshot-store must be one of: ${SNAPSHOT_STORE_IDS.join(', ')} (got "${id}")`);
  }
  return /** @type {SnapshotStoreId} */ (id);
}

/**
 * Masking defaults **on** for the shared store and **off** for the local one.
 * The inversion is the point: a local store is a scratch directory on the
 * author's own machine, a shared one is headed for a commit, and a default that
 * writes plaintext secrets into git history is not a default worth having.
 * @param {unknown} raw
 * @param {SnapshotStoreId} storeId
 * @returns {SnapshotMaskMode}
 */
function normalizeMaskMode(raw, storeId) {
  if (raw === undefined || raw === null || raw === '') {
    return storeId === 'shared' ? 'hash' : 'none';
  }
  const mode = String(raw);
  if (!SNAPSHOT_MASK_MODES.includes(/** @type {SnapshotMaskMode} */ (mode))) {
    throw new Error(`--snapshot-mask must be one of: ${SNAPSHOT_MASK_MODES.join(', ')} (got "${mode}")`);
  }
  return /** @type {SnapshotMaskMode} */ (mode);
}

/**
 * @param {unknown} raw
 * @param {SnapshotStoreId} storeId
 * @returns {number} 0 means "keep everything"
 */
function normalizeRetention(raw, storeId) {
  if (raw === undefined || raw === null || raw === '') {
    return storeId === 'shared' ? DEFAULT_SHARED_RETENTION : 0;
  }
  const retention = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(retention) || retention < 0) {
    throw new Error('--snapshot-retention must be a non-negative integer (0 keeps every snapshot)');
  }
  return retention;
}

/**
 * The directory repo-relative snapshot keys are measured from: the git top
 * level when there is one, else the working directory.
 *
 * Using the top level rather than `process.cwd()` is what lets `flecto history`
 * run from `services/api/` and still find the snapshots `flecto watch` wrote
 * from the repository root — the same reason `--snapshot-ref` resolves paths
 * through `git rev-parse` (#79).
 * @param {string} cwd
 * @returns {string}
 */
function resolveProjectRoot(cwd) {
  try {
    const top = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (top) return resolve(top);
  } catch {
    // Not a git repository, or git is not installed. A shared store still works
    // relative to the working directory; it is only *sharing* it that wants git.
  }
  return resolve(cwd);
}

/* ------------------------------------------------------------------ local -- */

function snapshotIdForPath(absPath) {
  const normalized = absPath.replaceAll('\\', '/');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * The `.flecto-snapshots/` store, unchanged in every observable way: same
 * filenames, same JSON, same absolute-path keying. It is wrapped in the store
 * interface so the consumers have exactly one code path.
 * @param {{ root: string, retention: number, maskMode: SnapshotMaskMode, cwd: string }} options
 * @returns {SnapshotStore}
 */
function createLocalStore({ root, retention, maskMode, cwd }) {
  const label = `${relative(cwd, root).split(sep).join('/') || root}/`;

  const baselinePath = (absFile) => join(root, `${snapshotIdForPath(absFile)}.json`);

  /**
   * Timestamped history entries per snapshot id, listed **once** per run and
   * then maintained in memory. Probing the directory per file made writing N
   * baselines cost N listings of O(N) entries each, which is quadratic in the
   * number of tracked files (see `docs/performance.md`); the store is the only
   * writer during a run, so keeping the map in step is exact.
   * @type {Map<string, string[]> | null}
   */
  let historyNames = null;

  const historyNamesById = () => {
    if (historyNames) return historyNames;
    historyNames = new Map();
    if (!existsSync(root)) return historyNames;
    for (const name of readdirSync(root)) {
      const match = /^([a-f0-9]{16})\.\d+\.json$/.exec(name);
      if (!match) continue;
      const names = historyNames.get(match[1]) ?? [];
      names.push(name);
      historyNames.set(match[1], names);
    }
    for (const names of historyNames.values()) {
      names.sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1]));
    }
    return historyNames;
  };

  const historyPath = (absFile) => {
    const id = snapshotIdForPath(absFile);
    const taken = new Set(historyNamesById().get(id) ?? []);
    let timestamp = Date.now();
    while (taken.has(`${id}.${timestamp}.json`) || existsSync(join(root, `${id}.${timestamp}.json`))) {
      timestamp += 1;
    }
    const name = `${id}.${timestamp}.json`;
    historyNamesById().set(id, [...(historyNamesById().get(id) ?? []), name]);
    return join(root, name);
  };

  return {
    id: 'local',
    root,
    label,
    maskMode,
    retention,
    emptyHint: `${label} holds none. Save one with "flecto watch <file> --snapshot",`
      + ' or pass --snapshot-ref <git-ref> to diff against a committed revision instead',

    exists: () => existsSync(root),

    readLatest(absFile) {
      const path = baselinePath(absFile);
      if (!existsSync(path)) return null;
      const snapshot = JSON.parse(readFileSync(path, 'utf8'));
      return {
        file: typeof snapshot?.file === 'string' ? snapshot.file : absFile,
        state: restoreDocumentKeys(snapshot?.state ?? snapshot, snapshot?.documents),
        documents: Array.isArray(snapshot?.documents) ? snapshot.documents.map(String) : undefined,
        createdAt: snapshot?.createdAt ?? statSync(path).mtime.toISOString(),
      };
    },

    readHistory() {
      if (!existsSync(root)) return [];
      const entries = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
      const timestamped = entries.filter((entry) => /^[a-f0-9]{16}\.\d+\.json$/.test(entry.name));
      const withHistory = new Set(timestamped.map((entry) => entry.name.slice(0, 16)));
      // A `<id>.json` with no timestamped sibling is a store written before
      // history existed; it is that file's only snapshot.
      const legacy = entries.filter((entry) =>
        /^[a-f0-9]{16}\.json$/.test(entry.name) && !withHistory.has(entry.name.slice(0, 16)));

      return [...timestamped, ...legacy].map((entry) => {
        const path = join(root, entry.name);
        const snapshot = JSON.parse(readFileSync(path, 'utf8'));
        if (typeof snapshot?.file !== 'string') {
          throw new Error(`Invalid snapshot file: ${path}`);
        }
        return {
          file: snapshot.file,
          state: restoreDocumentKeys(snapshot?.state ?? snapshot, snapshot?.documents),
          documents: Array.isArray(snapshot?.documents) ? snapshot.documents.map(String) : undefined,
          createdAt: snapshot.createdAt ?? statSync(path).mtime.toISOString(),
        };
      });
    },

    write(absFile, record) {
      mkdirSync(root, { recursive: true });
      const createdAt = record.createdAt ?? new Date().toISOString();
      const documents = record.documents ?? [];
      const state = maskMode === 'hash' ? maskState(record.state) : record.state;
      // Field order is the order this file has always written, so an unmasked
      // local snapshot is byte-for-byte what it was before the store existed.
      const snapshot = {
        file: absFile,
        state,
        ...(documents.length > 0 ? { documents: [...documents] } : {}),
        createdAt,
      };
      const serialized = JSON.stringify(snapshot, null, 2);

      const id = snapshotIdForPath(absFile);
      const path = baselinePath(absFile);
      // A store written before timestamped history existed holds a baseline and
      // nothing else; promote it to a history entry before it is overwritten, so
      // the first `--snapshot` after an upgrade does not silently drop it.
      if (existsSync(path) && (historyNamesById().get(id) ?? []).length === 0) {
        const legacy = JSON.parse(readFileSync(path, 'utf8'));
        writeFileSync(historyPath(absFile), `${JSON.stringify({
          file: legacy.file ?? absFile,
          state: legacy.state ?? legacy,
          ...(Array.isArray(legacy.documents) ? { documents: legacy.documents } : {}),
          createdAt: legacy.createdAt ?? statSync(path).mtime.toISOString(),
        }, null, 2)}`, 'utf8');
      }

      writeFileSync(path, serialized, 'utf8');
      writeFileSync(historyPath(absFile), serialized, 'utf8');

      let pruned = 0;
      if (retention > 0) {
        const names = historyNamesById().get(id) ?? [];
        const excess = names.slice(0, Math.max(0, names.length - retention));
        for (const name of excess) {
          rmSync(join(root, name), { force: true });
          pruned += 1;
        }
        historyNamesById().set(id, names.slice(excess.length));
      }
      return { path, pruned };
    },
  };
}

/* ----------------------------------------------------------------- shared -- */

/**
 * @param {{ root: string, projectRoot: string, retention: number, maskMode: SnapshotMaskMode }} options
 * @returns {SnapshotStore}
 */
function createSharedStore({ root, projectRoot, retention, maskMode }) {
  const label = `${relative(projectRoot, root).split(sep).join('/') || root}/`;

  /**
   * The store key for a file: its path relative to the project root, POSIX
   * slashed. A file outside the project has no such key, and inventing one (a
   * hash, an absolute path) would produce a store entry that is meaningless on
   * any other checkout — so it is refused rather than written somewhere useless.
   * @param {string} absFile
   * @returns {string}
   */
  const keyFor = (absFile) => {
    const rel = relative(projectRoot, resolve(absFile));
    if (!rel || rel.startsWith('..') || rel.startsWith(`..${sep}`)) {
      throw new Error(
        `The shared snapshot store keys snapshots by repo-relative path, and "${absFile}" is`
        + ` outside ${projectRoot}. Run Flecto from the repository that holds the file, or use`
        + ' --snapshot-store local for files outside a repository.',
      );
    }
    return rel.split(sep).join('/');
  };

  const pathForKey = (key) => join(root, `${key.split('/').join(sep)}.json`);

  /** @returns {string[]} every `*.json` under the store root, POSIX-keyed */
  const storeFiles = () => {
    if (!existsSync(root)) return [];
    /** @type {string[]} */
    const out = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
      }
    };
    walk(root);
    return out.sort();
  };

  /**
   * @param {string} path
   * @returns {{ version: number, file: string, masking: SnapshotMaskMode, snapshots: any[] }}
   */
  const readStoreFile = (path) => {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`Snapshot store file is not valid JSON: ${path}: ${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.snapshots)) {
      throw new Error(`Snapshot store file is malformed (expected a "snapshots" array): ${path}`);
    }
    if (typeof parsed.file !== 'string') {
      throw new Error(`Snapshot store file is missing its "file" key: ${path}`);
    }
    return parsed;
  };

  return {
    id: 'shared',
    root,
    label,
    maskMode,
    retention,
    emptyHint: `${label} holds none. Save one with "flecto watch <file> --snapshot`
      + ' --snapshot-store shared" and commit it, so every runner reads the same history',

    exists: () => existsSync(root),

    readLatest(absFile) {
      const path = pathForKey(keyFor(absFile));
      if (!existsSync(path)) return null;
      const stored = readStoreFile(path);
      const latest = stored.snapshots.at(-1);
      if (!latest) return null;
      return {
        file: resolve(projectRoot, stored.file),
        state: restoreDocumentKeys(latest.state, latest.documents),
        documents: Array.isArray(latest.documents) ? latest.documents.map(String) : undefined,
        createdAt: String(latest.createdAt ?? statSync(path).mtime.toISOString()),
      };
    },

    readHistory() {
      /** @type {SnapshotRecord[]} */
      const records = [];
      for (const path of storeFiles()) {
        const stored = readStoreFile(path);
        // Absolute, because every consumer compares a snapshot's file against
        // resolved CLI targets. The stored form stays repo-relative.
        const file = resolve(projectRoot, stored.file);
        for (const entry of stored.snapshots) {
          records.push({
            file,
            state: restoreDocumentKeys(entry?.state, entry?.documents),
            documents: Array.isArray(entry?.documents) ? entry.documents.map(String) : undefined,
            createdAt: String(entry?.createdAt ?? statSync(path).mtime.toISOString()),
          });
        }
      }
      return records;
    },

    write(absFile, record) {
      const key = keyFor(absFile);
      const path = pathForKey(key);
      const createdAt = record.createdAt ?? new Date().toISOString();
      const documents = record.documents ?? [];
      const state = maskMode === 'hash' ? maskState(record.state) : record.state;

      let snapshots = [];
      let warning;
      if (existsSync(path)) {
        const stored = readStoreFile(path);
        snapshots = stored.snapshots;
        const previousMask = stored.masking === 'hash' ? 'hash' : 'none';
        if (previousMask !== maskMode) {
          // Say it rather than let the next diff read as "every secret changed",
          // which is what switching masking mid-history looks like downstream.
          warning = `${label}${key}.json was written with masking "${previousMask}" and this run`
            + ` uses "${maskMode}". Existing entries keep the form they were written in, so the`
            + ' next diff will report masked values as changed.';
        }
      }

      snapshots.push({
        createdAt,
        ...(documents.length > 0 ? { documents: [...documents] } : {}),
        state,
      });

      let pruned = 0;
      if (retention > 0 && snapshots.length > retention) {
        pruned = snapshots.length - retention;
        snapshots = snapshots.slice(pruned);
      }

      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${stableStringify({
        version: SHARED_STORE_VERSION,
        file: key,
        masking: maskMode,
        snapshots,
      })}\n`, 'utf8');
      return { path, pruned, warning };
    },
  };
}

/**
 * Put the parser's multi-document signal back on a state read out of a store.
 * A stored snapshot is plain JSON, so the in-memory marking is gone; one written
 * before the field existed leaves the provenance unknown, which is what it is.
 * @param {unknown} state
 * @param {unknown} documents
 * @returns {unknown} the same state
 */
function restoreDocumentKeys(state, documents) {
  if (!Array.isArray(documents)) return state;
  return withDocumentKeys(state, documents.map(String));
}

/* ------------------------------------------------------------ serialization */

/**
 * JSON with object keys sorted at every level, two-space indent, one scalar per
 * line — the serialization a committed store needs.
 *
 * `JSON.stringify` preserves insertion order, which is the parser's order, which
 * is the file's order: moving a key in `prod.yaml` would rewrite the snapshot
 * from that point down and bury the one line that actually changed. Sorting
 * makes the diff of a snapshot the diff of the config's *meaning*, which is the
 * whole premise of the tool.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  return JSON.stringify(sortDeep(value), null, 2);
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(/** @type {object} */ (value)).sort()) {
    // defineProperty so a config key literally named `__proto__` stays an
    // ordinary own property instead of reaching Object.prototype, matching how
    // the parser and the differ handle the same name.
    Object.defineProperty(out, key, {
      value: sortDeep(/** @type {Record<string, unknown>} */ (value)[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/* ---------------------------------------------------------------- masking -- */

/**
 * The stored form of a secret value: a truncated digest, prefixed so it is
 * obvious in a review what it is and where it came from.
 * @param {string} value
 * @returns {string}
 */
export function maskedDigest(value) {
  return MASK_PREFIX + createHash('sha256').update(value).digest('hex').slice(0, MASK_DIGEST_LENGTH);
}

/**
 * True for a value this module produced, so masking is idempotent: re-masking a
 * store that already holds digests must not digest the digests.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isMaskedDigest(value) {
  return typeof value === 'string' && value.startsWith(MASK_PREFIX);
}

/**
 * Replace every secret-like string in a parsed state with its digest.
 *
 * Whole values, not just the matched span: a connection string keeps its shape
 * under `redactSecretString`, and a shape that stays constant while the embedded
 * credential rotates is exactly the silent all-clear a drift store must not
 * produce. The digest changes when any part of the value does.
 * @param {unknown} state
 * @returns {unknown}
 */
export function maskState(state) {
  if (typeof state === 'string') {
    if (isMaskedDigest(state)) return state;
    return containsSecret(state) ? maskedDigest(state) : state;
  }
  if (Array.isArray(state)) return state.map(maskState);
  if (!isPlainObject(state)) return state;
  const masked = Object.fromEntries(
    Object.entries(/** @type {Record<string, unknown>} */ (state))
      .map(([key, value]) => [key, maskState(value)]),
  );
  // Rebuilding the root drops the parser's multi-document marking, which
  // secret-name matching reads to tell a resource *named* `token-service` from a
  // secret. Carry it across rather than making the masked tree look
  // single-document.
  const documents = documentKeysOf(state);
  return documents ? withDocumentKeys(masked, documents) : masked;
}
