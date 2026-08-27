import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));

/**
 * Parse a semver-ish version into [major, minor, patch]. Missing parts are 0.
 * @param {string} version
 * @returns {[number, number, number] | null}
 */
function parseVersion(version) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/**
 * Compare two [major, minor, patch] tuples.
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {number} negative when a < b, 0 when equal, positive when a > b
 */
function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Does `floor` satisfy a single comparator such as `>=20.19.0` or `^14.13`?
 *
 * Throws on any comparator shape this does not model, so an unrecognized range
 * fails the test loudly instead of silently passing. That matters: the whole
 * point of this guard is to catch a dependency quietly outgrowing our floor.
 * @param {[number, number, number]} floor
 * @param {string} comparator
 * @returns {boolean}
 */
function satisfiesComparator(floor, comparator) {
  const text = comparator.trim();
  if (text === '' || text === '*') return true;

  const match = /^(>=|<=|>|<|\^|~|=)?\s*v?(\d.*)$/.exec(text);
  if (!match) throw new Error(`unsupported comparator: "${comparator}"`);

  const operator = match[1] ?? '=';
  const bound = parseVersion(match[2]);
  if (!bound) throw new Error(`unsupported version in comparator: "${comparator}"`);

  const cmp = compare(floor, bound);
  if (operator === '>=') return cmp >= 0;
  if (operator === '>') return cmp > 0;
  if (operator === '<=') return cmp <= 0;
  if (operator === '<') return cmp < 0;
  if (operator === '=') return cmp === 0;
  // ^ and ~ both pin the major here; a Node floor never legitimately sits below
  // the range's own lower bound, so the major check is what actually matters.
  if (operator === '^' || operator === '~') return floor[0] === bound[0] && cmp >= 0;
  throw new Error(`unsupported operator: "${operator}"`);
}

/**
 * Does `floor` satisfy an `engines.node` range, including `||` disjunctions and
 * space-separated conjunctions?
 * @param {[number, number, number]} floor
 * @param {string} range
 * @returns {boolean}
 */
function satisfies(floor, range) {
  return range.split('||').some((branch) => {
    const parts = branch.trim().split(/\s+(?=[<>=^~])/).filter(Boolean);
    return parts.every((part) => satisfiesComparator(floor, part));
  });
}

/**
 * Read an installed dependency's package.json off disk.
 *
 * Deliberately not `require('<name>/package.json')`: a package whose "exports"
 * map omits ./package.json makes that throw, and the manifest is precisely what
 * we need in order to check its engines. Walks up node_modules the same way
 * `resolvePackPackageDir` in src/policy.js does.
 * @param {string} name
 * @returns {Record<string, any> | null}
 */
function readDependencyManifest(name) {
  let dir = resolve(process.cwd());
  for (;;) {
    try {
      return JSON.parse(readFileSync(resolve(dir, 'node_modules', name, 'package.json'), 'utf8'));
    } catch {
      const parent = resolve(dir, '..');
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

test('every runtime dependency supports the Node version Flecto claims', () => {
  const declared = pkg.engines?.node;
  assert.ok(declared, 'package.json must declare engines.node');

  const floor = parseVersion(declared.replace(/^[^\d]*/, ''));
  assert.ok(floor, `could not parse Flecto's own engines.node: "${declared}"`);

  /** @type {string[]} */
  const offenders = [];
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    const manifest = readDependencyManifest(name);
    // Never skip on failure: a package we cannot inspect is exactly where an
    // incompatible engines range would hide. chalk 6 is the live example — its
    // "exports" map hides ./package.json, so require() throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED and a skip-on-error guard waves it through.
    assert.ok(manifest, `could not read node_modules/${name}/package.json to check its engines`);

    const range = manifest.engines?.node;
    if (!range) continue;
    if (!satisfies(floor, range)) {
      offenders.push(`${name} requires node "${range}" but Flecto declares "${declared}"`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Dependencies require a newer Node than Flecto supports:\n  ${offenders.join('\n  ')}\n\n` +
    'Either raise engines.node (and the CI matrix, both composite actions, the ' +
    'doctor check, and the docs), or hold the dependency back in ' +
    '.github/dependabot.yml. See #104.',
  );
});

/**
 * The `test` job's matrix, flattened to one entry per runner. Parsed as YAML
 * rather than pattern-matched, so the assertions below survive a reshaping of
 * the matrix and fail only when a runner is genuinely gone.
 * @returns {{ os: string, nodeVersion: number }[]}
 */
function ciMatrixEntries() {
  const workflow = yaml.load(
    readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8'),
  );
  const strategy = workflow?.jobs?.test?.strategy;
  assert.ok(strategy?.matrix, 'ci.yml must declare a matrix for the test job');

  const { include, os, 'node-version': nodeVersion } = strategy.matrix;
  if (Array.isArray(include)) {
    return include.map((entry) => ({
      os: String(entry.os ?? os ?? workflow.jobs.test['runs-on']),
      nodeVersion: Number(entry['node-version']),
    }));
  }
  // A plain cross-product matrix, should it ever go back to one.
  const platforms = Array.isArray(os) ? os : [String(workflow.jobs.test['runs-on'])];
  return platforms.flatMap((platform) =>
    (nodeVersion ?? []).map((version) => ({ os: String(platform), nodeVersion: Number(version) })),
  );
}

test('the CI matrix covers the declared Node floor', () => {
  const versions = [...new Set(ciMatrixEntries().map((entry) => entry.nodeVersion))];
  const floorMajor = parseVersion(pkg.engines.node.replace(/^[^\d]*/, ''))[0];

  assert.ok(
    versions.includes(floorMajor),
    `CI matrix [${versions.join(', ')}] does not test the declared floor (Node ${floorMajor}). ` +
    'A floor nothing exercises is a claim, not a guarantee.',
  );
});

test('the CI matrix covers Linux, Windows, and macOS', () => {
  // Flecto's primary local mode is watching files by glob, and both the glob
  // engine's separator handling and chokidar's backend differ per platform.
  // A matrix that quietly loses a runner takes the only check on that with it.
  const entries = ciMatrixEntries();
  const families = new Set(entries.map((entry) => entry.os.split('-')[0]));

  for (const family of ['ubuntu', 'windows', 'macos']) {
    assert.ok(
      families.has(family),
      `CI matrix runs on [${[...families].join(', ')}] but not ${family}. `
      + 'See #148: Windows and macOS were untested for the first three minor versions.',
    );
  }
});

test('the CI matrix does not cancel siblings on the first failure', () => {
  // Platform divergence is what this matrix exists to surface, so a Windows
  // failure must not cancel the macOS job that shows whether it is platform-wide.
  const workflow = yaml.load(
    readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8'),
  );
  assert.equal(workflow.jobs.test.strategy['fail-fast'], false);
});

test('the engines range parser rejects shapes it does not model', () => {
  // Guards the guard: a range this cannot parse must throw rather than quietly
  // return true, which would let an incompatible dependency through.
  assert.throws(() => satisfies([20, 19, 0], 'not-a-range'), /unsupported/);
  assert.throws(() => satisfies([20, 19, 0], '>=abc'), /unsupported/);

  // Shapes that are modelled, including the ones our dependencies actually use.
  assert.equal(satisfies([20, 19, 0], '>=20.19.0'), true);
  assert.equal(satisfies([20, 19, 0], '>= 20.19.0'), true);
  assert.equal(satisfies([20, 19, 0], '>=22'), false);
  assert.equal(satisfies([20, 19, 0], '>=18'), true);
  assert.equal(satisfies([20, 19, 0], '^12.17.0 || ^14.13 || >=16.0.0'), true);
  assert.equal(satisfies([20, 19, 0], '^12.17.0 || ^14.13'), false);
  assert.equal(satisfies([20, 19, 0], '*'), true);
});
