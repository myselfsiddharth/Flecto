/**
 * Synthetic repository generator for the Flecto performance benchmark.
 *
 * Everything here is deterministic: the same `fileCount` and `mutate` flag
 * always produce byte-identical files, so a benchmark run can be repeated and
 * compared. Fixtures are written into a caller-supplied temp directory and are
 * never committed.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import TOML from '@iarna/toml';

/** Formats cycled across generated files, weighted toward YAML/JSON. */
const FORMATS = ['yaml', 'json', 'yaml', 'toml', 'json', 'yaml', 'ini', 'json', 'yaml', 'env'];
const EXTENSIONS = { yaml: 'yaml', json: 'json', toml: 'toml', ini: 'ini', env: 'env' };
const REGIONS = ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-south-1'];

/** Every 50th file carries a large array; every 10th (offset 3) is deeply nested. */
const BIG_ARRAY_EVERY = 50;
const BIG_ARRAY_ITEMS = 5000;
const DEEP_EVERY = 10;
const DEEP_OFFSET = 3;
const DEEP_DEPTH = 15;
/** Every 10th file is mutated between the baseline snapshot and the diff run. */
const MUTATE_EVERY = 10;

/**
 * @typedef {{
 *   index: number,
 *   relPath: string,
 *   format: 'yaml' | 'json' | 'toml' | 'ini' | 'env',
 *   deep: boolean,
 *   bigArray: boolean,
 *   mutated: boolean
 * }} FixtureFile
 */

/**
 * Describe the files a repo of a given size contains, without writing anything.
 * @param {number} fileCount
 * @returns {FixtureFile[]}
 */
function planFiles(fileCount) {
  /** @type {FixtureFile[]} */
  const files = [];
  for (let i = 0; i < fileCount; i++) {
    const bigArray = i % BIG_ARRAY_EVERY === 0;
    // Large arrays are always JSON: a 5k-entry YAML dump would make fixture
    // generation, not Flecto, the thing being measured.
    const format = bigArray ? 'json' : FORMATS[i % FORMATS.length];
    const group = `group-${String(i % 12).padStart(2, '0')}`;
    const sub = `svc-${Math.floor(i / 12) % 8}`;
    files.push({
      index: i,
      relPath: join('config', group, sub, `service-${i}.${EXTENSIONS[format]}`),
      format,
      deep: i % DEEP_EVERY === DEEP_OFFSET,
      bigArray,
      mutated: i % MUTATE_EVERY === 0,
    });
  }
  return files;
}

/**
 * Build a nested chain `DEEP_DEPTH` levels deep, so the differ has to recurse.
 * @param {number} index
 * @returns {Record<string, unknown>}
 */
function deepBranch(index) {
  /** @type {Record<string, unknown>} */
  let node = { leaf_value: `depth-${DEEP_DEPTH}-${index}`, enabled: index % 2 === 0, weight: index % 97 };
  for (let level = DEEP_DEPTH - 1; level >= 0; level--) {
    node = {
      [`level_${level}`]: node,
      annotations: { level, owner: `team-${level % 5}` },
    };
  }
  return node;
}

/**
 * A large array of identity-bearing objects — the shape array identity matching
 * has to work hardest on.
 * @param {number} index
 * @param {boolean} mutate
 * @returns {Array<Record<string, unknown>>}
 */
function bigArrayEntries(index, mutate) {
  const entries = [];
  for (let i = 0; i < BIG_ARRAY_ITEMS; i++) {
    entries.push({
      id: `entry-${index}-${i}`,
      name: `rule-${i}`,
      weight: (i * 7) % 1000,
      enabled: i % 3 !== 0,
      selector: { kind: i % 2 === 0 ? 'header' : 'cookie', key: `k-${i % 50}` },
      tags: [`t${i % 11}`, `t${i % 13}`],
    });
  }
  if (!mutate) return entries;

  // A realistic edit: one value changed, one entry removed, one appended, and
  // the whole array rotated so order alone differs.
  entries[Math.floor(BIG_ARRAY_ITEMS / 2)].weight += 1;
  entries.splice(10, 1);
  entries.push({
    id: `entry-${index}-new`,
    name: 'rule-new',
    weight: 42,
    enabled: true,
    selector: { kind: 'header', key: 'k-new' },
    tags: ['t0'],
  });
  return [...entries.slice(1), entries[0]];
}

/**
 * The tree for one generated config file.
 * @param {FixtureFile} file
 * @param {boolean} mutate apply the post-baseline edits for this file
 * @returns {Record<string, unknown>}
 */
function serviceTree(file, mutate) {
  const i = file.index;
  const edited = mutate && file.mutated;

  /** @type {Record<string, unknown>} */
  const tree = {
    service: {
      name: `svc-${i}`,
      version: `1.${i % 20}.${edited ? (i % 7) + 1 : i % 7}`,
      owner: `team-${i % 12}`,
      tier: i % 5 === 0 ? 'critical' : 'standard',
    },
    server: {
      host: '0.0.0.0',
      port: 8000 + (i % 500),
      timeout_ms: 3000,
      workers: 4 + (i % 8),
      tls: { enabled: true, min_version: '1.2', ciphers: ['TLS_AES_128_GCM_SHA256'] },
    },
    database: {
      url: `postgres://db-${i % 30}.internal:5432/app`,
      // Tripling this trips the built-in pool-size-jump rule.
      pool_size: edited ? (8 + (i % 12)) * 3 : 8 + (i % 12),
      ssl: true,
      retry: { attempts: 3, backoff_ms: 250, jitter: true },
    },
    features: {
      // Trips the dangerous-toggle rule.
      debug: Boolean(edited),
      beta_ui: i % 3 === 0,
      new_pricing: i % 4 === 0,
      async_export: i % 6 === 0,
    },
    env: {
      LOG_LEVEL: 'info',
      REGION: REGIONS[i % REGIONS.length],
      // Trips the secret-key and secret-value rules.
      API_KEY: edited ? `sk_live_${i}_rotated_9f2c4b71a8` : `sk_live_${i}_a71c3e90fd`,
      CACHE_TTL: String(60 + (i % 300)),
    },
    limits: edited ? { cpu: '500m' } : { cpu: '500m', memory: '512Mi', ephemeral: '1Gi' },
    routes: [
      { id: 'health', path: '/healthz', public: true, timeout_ms: 500 },
      { id: 'api', path: '/api/v1', public: false, timeout_ms: 2000 },
      { id: 'metrics', path: '/metrics', public: false, timeout_ms: 1000 },
    ],
    meta: { revision: edited ? i + 1 : i, generated: true },
  };

  if (edited) {
    /** @type {any} */ (tree.server).keepalive_ms = 15000;
    /** @type {any} */ (tree.routes)[1].timeout_ms = 5000;
    /** @type {any} */ (tree.routes).push({ id: 'admin', path: '/admin', public: false, timeout_ms: 3000 });
    tree.routes = [/** @type {any} */ (tree.routes).at(-1), .../** @type {any} */ (tree.routes).slice(0, -1)];
  }
  if (file.deep) tree.deep = deepBranch(i);
  if (file.bigArray) tree.entries = bigArrayEntries(i, edited);
  return tree;
}

/**
 * Flatten a tree to the `KEY=value` pairs a .env fixture can hold.
 * @param {Record<string, unknown>} tree
 * @returns {string}
 */
function renderEnv(tree) {
  const lines = [];
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node)) {
      const name = prefix ? `${prefix}_${key.toUpperCase()}` : key.toUpperCase();
      if (value && typeof value === 'object' && !Array.isArray(value)) walk(value, name);
      else if (!Array.isArray(value)) lines.push(`${name}=${String(value)}`);
    }
  };
  walk(tree, '');
  return `${lines.join('\n')}\n`;
}

/**
 * Render a tree as INI: scalar roots first, then one section per object.
 * @param {Record<string, unknown>} tree
 * @returns {string}
 */
function renderIni(tree) {
  const lines = [];
  for (const [key, value] of Object.entries(tree)) {
    if (value == null || typeof value !== 'object') lines.push(`${key}=${String(value)}`);
  }
  for (const [section, value] of Object.entries(tree)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    lines.push('', `[${section}]`);
    for (const [key, inner] of Object.entries(value)) {
      if (inner == null || typeof inner === 'object') continue;
      lines.push(`${key}=${String(inner)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * TOML cannot express every shape the generic tree uses, so arrays of scalars
 * and nested tables are kept but plain `null` never appears.
 * @param {Record<string, unknown>} tree
 * @returns {string}
 */
function renderToml(tree) {
  const { deep, entries, ...rest } = tree;
  return TOML.stringify(/** @type {any} */ (rest));
}

/**
 * @param {FixtureFile} file
 * @param {Record<string, unknown>} tree
 * @returns {string}
 */
function render(file, tree) {
  if (file.format === 'json') return `${JSON.stringify(tree, null, 2)}\n`;
  if (file.format === 'yaml') return yaml.dump(tree, { lineWidth: 120 });
  if (file.format === 'toml') return renderToml(tree);
  if (file.format === 'ini') return renderIni(tree);
  return renderEnv(tree);
}

/**
 * Write (or rewrite) a synthetic repo. Called once for the baseline state and
 * again with `mutate: true` to produce the "after" state the diff runs against.
 * @param {{ dir: string, fileCount: number, mutate?: boolean }} options
 * @returns {{ files: FixtureFile[], bytes: number }}
 */
export function writeRepo(options) {
  const { dir, fileCount, mutate = false } = options;
  const files = planFiles(fileCount);
  let bytes = 0;

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '.flectorc'),
    `${JSON.stringify(
      {
        files: ['config/**/*.{yaml,yml,json,toml,ini,env}'],
        exclude: ['**/node_modules/**', '.flecto-snapshots/**'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  /** @type {Set<string>} */
  const madeDirs = new Set();
  for (const file of files) {
    const abs = join(dir, file.relPath);
    const parent = dirname(abs);
    if (!madeDirs.has(parent)) {
      mkdirSync(parent, { recursive: true });
      madeDirs.add(parent);
    }
    const text = render(file, serviceTree(file, mutate));
    bytes += Buffer.byteLength(text);
    writeFileSync(abs, text, 'utf8');
  }

  return { files, bytes };
}

/**
 * Build one pair of arrays for the differ microbenchmarks.
 *
 * With `identity: false` the items carry neither `id` nor a unique `name`, so
 * auto-detection finds no identity key and the differ falls back to index or
 * multiset comparison — the paths worth timing separately.
 * @param {number} size
 * @param {{ identity?: boolean, reorder?: boolean }} [shape]
 * @returns {{ before: unknown[], after: unknown[] }}
 */
export function arrayPair(size, shape = {}) {
  const identity = shape.identity !== false;
  const build = (mutate) => {
    const items = [];
    for (let i = 0; i < size; i++) {
      /** @type {Record<string, unknown>} */
      const item = {
        name: identity ? `rule-${i}` : `rule-${i % 10}`,
        weight: (i * 7) % 1000,
        enabled: i % 3 !== 0,
        selector: { kind: i % 2 === 0 ? 'header' : 'cookie', key: `k-${i % 50}` },
        tags: [`t${i % 11}`],
      };
      if (identity) item.id = `entry-${i}`;
      // One item in every 100 differs between the two sides.
      if (mutate && i % 100 === 0) item.weight += 1;
      items.push(item);
    }
    return items;
  };

  const before = build(false);
  const after = build(true);
  return { before, after: shape.reorder ? [...after.slice(1), after[0]] : after };
}
