/**
 * Fuzz targets: the boundary an untrusted pull request controls.
 *
 * `flecto ci` runs on a pull request, and everything it reads there is
 * attacker-supplied — the config files, their names, `.flectorc`, and the
 * regexes inside a policy pack a PR can add. GHSA-wq8m-fc3q-8m5x came out of
 * exactly this surface. Manual review found two DoS vectors after it; manual
 * review finds what someone thought to look for, and these targets keep looking
 * after the reviewer has moved on (#150).
 *
 * A target is `{ id, description, generate(rng) -> input, run(input, ctx) }`:
 *
 * - `generate` is a pure function of a seeded RNG, so `(target, seed, index)`
 *   identifies an input exactly and `--case N` replays it.
 * - the input is JSON-serializable, so a crash can be written to
 *   `test/fixtures/fuzz/` and replayed by the normal test suite forever after.
 * - `run` throws `FuzzViolation` when an invariant breaks. Anything else
 *   thrown is a bug in the harness and is reported as such.
 *
 * The shared invariant, in the issue's words: it either parses or throws a
 * clean `Error` — never hangs, never exhausts memory, never returns a
 * prototype-polluted object.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { parseContent } from '../../src/parser.js';
import { diffTrees } from '../../src/differ.js';
import { expandChangeSubtrees, evaluatePack, loadPack } from '../../src/policy.js';
import { containsSecret, detectSecretKind, redactSecretString, looksLikeSecret } from '../../src/secrets.js';
import {
  isEncryptedSentinel,
  sentinelScheme,
  encryptedValueScheme,
  isArmoredAgeFile,
  opaqueFileState,
  encryptionState,
} from '../../src/encrypted.js';

import {
  adversarialValue,
  changeEvents,
  deepTree,
  documentText,
  mutate,
  policyPack,
  regexSource,
  tree,
} from './generators.js';

/** An invariant broke. Distinct from a harness bug, which is any other throw. */
export class FuzzViolation extends Error {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [detail]
   */
  constructor(message, detail = {}) {
    super(message);
    this.name = 'FuzzViolation';
    this.detail = detail;
  }
}

/**
 * The longest a single case may take. The property under test is largely "it
 * terminates", so a case that merely takes seconds is a finding: on a CI job
 * that is a denial of service whether or not it eventually returns.
 */
export const CASE_BUDGET_MS = 2000;

const POLLUTION_PROBES = ['flectoFuzzPolluted', 'polluted', 'toString', 'isAdmin'];

/**
 * Prototypes a parsed tree is allowed to carry.
 *
 * `Uint8Array` is on the list because YAML's safe schema resolves `!!binary` to
 * one and `normalizeParsedValue` leaves it alone — odd, but it is a builtin the
 * parser is documented to produce, not an attacker-chosen prototype. Anything
 * *not* on this list is the thing worth catching: an object arriving with a
 * prototype that came out of the document. A new builtin showing up here after
 * a js-yaml upgrade will fail this check too, and that is the right outcome —
 * it means the shape of what a parser hands the differ changed.
 */
const ALLOWED_PROTOTYPES = new Set([
  Object.prototype,
  Array.prototype,
  Uint8Array.prototype,
  null,
]);

/**
 * Nothing may have written through a prototype. Checked after every case rather
 * than once per run, so the failing case is named rather than the batch.
 * @param {string} where
 */
function assertNoPrototypePollution(where) {
  for (const probe of ['flectoFuzzPolluted', 'polluted', 'isAdmin']) {
    if (probe in {} || probe in [] || probe in (() => {})) {
      throw new FuzzViolation(`${where} wrote "${probe}" onto a prototype`);
    }
  }
  if (typeof {}.toString !== 'function' || typeof [].length !== 'number') {
    throw new FuzzViolation(`${where} replaced a builtin prototype member`);
  }
}

/**
 * Every object in a returned tree must be an ordinary plain object or array.
 * An object whose prototype is something else is how a polluted value gets
 * carried out of a parser without touching `Object.prototype` itself.
 * @param {unknown} value
 * @param {string} where
 * @param {number} [budget] node budget, so the check cannot itself be the hang
 */
function assertPlainResult(value, where, budget = 200000) {
  const stack = [value];
  const seen = new Set();
  let visited = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);
    visited += 1;
    if (visited > budget) return;

    const proto = Object.getPrototypeOf(node);
    if (!ALLOWED_PROTOTYPES.has(proto)) {
      throw new FuzzViolation(`${where} returned an object with an unexpected prototype`, {
        prototype: String(proto?.constructor?.name ?? proto),
      });
    }
    for (const probe of POLLUTION_PROBES) {
      const descriptor = Object.getOwnPropertyDescriptor(node, probe);
      if (descriptor && typeof descriptor.get === 'function') {
        throw new FuzzViolation(`${where} returned an object with a getter on "${probe}"`);
      }
    }
    for (const child of Object.values(node)) stack.push(child);
  }
}

/**
 * Run the code under test. Returning normally is fine; throwing is fine *if*
 * what came out is a real `Error` with a string message — that is the contract
 * every caller in `src/` is written against. Throwing a string, an object, or
 * `undefined` means a `catch` block upstream renders "[error] undefined".
 * @template T
 * @param {string} where
 * @param {() => T} fn
 * @returns {{ ok: true, value: T } | { ok: false }}
 */
function cleanly(where, fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    if (err instanceof FuzzViolation) throw err;
    if (!(err instanceof Error)) {
      throw new FuzzViolation(`${where} threw a non-Error`, { thrown: String(err) });
    }
    if (typeof err.message !== 'string') {
      throw new FuzzViolation(`${where} threw an Error with a non-string message`);
    }
    return { ok: false };
  }
}

/**
 * Enforce the per-case budget from inside the case as well as from the parent
 * process. The parent's watchdog is what catches a true hang; this catches the
 * slow-but-finite case, which the parent would otherwise miss entirely.
 * @param {string} where
 * @param {number} startedAt
 */
function assertWithinBudget(where, startedAt) {
  const elapsed = Date.now() - startedAt;
  if (elapsed > CASE_BUDGET_MS) {
    throw new FuzzViolation(`${where} took ${elapsed}ms, over the ${CASE_BUDGET_MS}ms budget`, {
      elapsedMs: elapsed,
    });
  }
}

/**
 * Rebuild a generated input that could not be JSON-serialized as-is. Cycles are
 * flagged rather than encoded so a crash fixture stays plain JSON.
 * @param {{ tree: unknown, cyclic?: boolean }} input
 * @returns {unknown}
 */
function materialize(input) {
  if (!input?.cyclic) return input?.tree;
  const value = input.tree;
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */ (value).self = value;
  }
  return value;
}

/**
 * One parse target per format. The formats do not share a parser, an error
 * shape, or a failure mode, and merging them would hide which one regressed.
 * @param {string} id
 * @param {string} format
 * @param {string} filename
 * @returns {object}
 */
function parseTarget(id, format, filename) {
  return {
    id,
    description: `parseContent() on ${format} — valid, damaged, deeply nested, and oversized documents`,
    generate: (rng) => ({
      filename: rng.bool(0.9) ? filename : `${rng.chars('abc. -', rng.between(1, 8))}${filename}`,
      text: rng.weighted([
        [45, () => documentText(rng, format)],
        [35, () => mutate(rng, documentText(rng, format))],
        [8, () => documentText(rng, format).repeat(rng.between(20, 200))],
        [6, () => `${'  '.repeat(rng.between(200, 4000))}${documentText(rng, format)}`],
        [3, () => ` ${documentText(rng, format)} `],
        [3, () => documentText(rng, format === 'yaml' ? 'json' : 'yaml')],
      ])(),
    }),
    run: (input) => {
      const startedAt = Date.now();
      const result = cleanly(id, () => parseContent(String(input.filename), String(input.text)));
      assertWithinBudget(id, startedAt);
      assertNoPrototypePollution(id);
      if (result.ok) assertPlainResult(result.value, id);
    },
  };
}

/** @type {Array<{ id: string, description: string, generate: Function, run: Function, setup?: Function, teardown?: Function }>} */
export const TARGETS = [
  parseTarget('parse-yaml', 'yaml', 'config.yaml'),
  parseTarget('parse-json', 'jsonc', 'config.json'),
  parseTarget('parse-toml', 'toml', 'config.toml'),
  parseTarget('parse-ini', 'ini', 'config.ini'),
  parseTarget('parse-dotenv', 'env', '.env'),

  {
    id: 'diff-trees',
    description: 'diffTrees() over generated tree pairs, including hostile keys, cycles, and deep nesting',
    generate: (rng) => ({
      before: rng.weighted([
        [70, () => tree(rng, rng.between(1, 4))],
        [15, () => deepTree(rng, rng.between(50, 2000))],
        [15, () => tree(rng, 0)],
      ])(),
      after: rng.weighted([
        [70, () => tree(rng, rng.between(1, 4))],
        [15, () => deepTree(rng, rng.between(50, 2000))],
        [15, () => tree(rng, 0)],
      ])(),
      cyclic: rng.bool(0.08),
      options: {
        ...(rng.bool(0.3) ? { ignorePaths: [regexSource(rng)] } : {}),
        ...(rng.bool(0.3) ? { arrayIdKey: rng.pick(['id', 'name', '__proto__', '']) } : {}),
        ...(rng.bool(0.2) ? { arrayIdentity: rng.bool() } : {}),
        ...(rng.bool(0.2) ? { arrayIgnoreOrder: rng.bool() } : {}),
      },
    }),
    run: (input) => {
      // A cycle cannot reach diffTrees from a parsed file — the parser replaces
      // one with CIRCULAR_SENTINEL first — so a clean throw here (including the
      // RangeError a self-referential tree produces) satisfies the contract.
      // What must not happen is a hang, a non-Error, or pollution.
      const before = materialize({ tree: input.before, cyclic: input.cyclic });
      const after = materialize({ tree: input.after, cyclic: input.cyclic });
      const startedAt = Date.now();
      const result = cleanly('diff-trees', () => diffTrees(before, after, input.options ?? {}));
      assertWithinBudget('diff-trees', startedAt);
      assertNoPrototypePollution('diff-trees');
      if (!result.ok) return;
      if (!Array.isArray(result.value)) {
        throw new FuzzViolation('diff-trees returned a non-array');
      }
      for (const event of result.value) {
        if (typeof event?.path !== 'string') {
          throw new FuzzViolation('diff-trees returned an event with a non-string path');
        }
      }
      assertPlainResult(result.value, 'diff-trees');
    },
  },

  {
    id: 'expand-subtrees',
    description: 'expandChangeSubtrees() over generated change events with hostile keys and cycles',
    generate: (rng) => ({
      changes: changeEvents(rng),
      cyclic: rng.bool(0.1),
      deep: rng.bool(0.1) ? rng.between(50, 3000) : 0,
    }),
    run: (input) => {
      const changes = (input.changes ?? []).map((change, index) => {
        if (input.deep && index === 0) return { ...change, after: deepTreeFromDepth(input.deep) };
        if (input.cyclic && index === 0 && change?.after) return { ...change, after: withCycleSafe(change.after) };
        return change;
      });
      const startedAt = Date.now();
      const result = cleanly('expand-subtrees', () => expandChangeSubtrees(changes));
      assertWithinBudget('expand-subtrees', startedAt);
      assertNoPrototypePollution('expand-subtrees');
      if (result.ok && !Array.isArray(result.value)) {
        throw new FuzzViolation('expand-subtrees returned a non-array');
      }
    },
  },

  {
    id: 'secret-scan',
    description: "Flecto's own secret-detection regexes against adversarial values",
    generate: (rng) => ({ value: adversarialValue(rng) }),
    run: (input) => {
      const value = String(input.value ?? '');
      const startedAt = Date.now();
      cleanly('secret-scan', () => {
        containsSecret(value);
        looksLikeSecret(value);
        detectSecretKind(value);
        redactSecretString(value);
      });
      // The ReDoS finding in the 3.0 review record lived here: two of these
      // patterns were O(n^2) on a long value with a failing tail, and a few
      // hundred kilobytes in one config value hung the CI job.
      assertWithinBudget('secret-scan', startedAt);
    },
  },

  {
    id: 'encrypted-scan',
    description: "Flecto's own SOPS/age detection regexes against adversarial values",
    generate: (rng) => ({
      value: adversarialValue(rng),
      tree: rng.bool(0.3) ? tree(rng, 2) : null,
    }),
    run: (input) => {
      const value = String(input.value ?? '');
      const startedAt = Date.now();
      cleanly('encrypted-scan', () => {
        isEncryptedSentinel(value);
        sentinelScheme(value);
        encryptedValueScheme(value);
        isArmoredAgeFile(value);
        opaqueFileState(value);
        if (input.tree) encryptionState(input.tree);
      });
      assertWithinBudget('encrypted-scan', startedAt);
    },
  },

  {
    id: 'pack-load',
    description: 'loadPack() on malformed, oversized, and deeply nested pack JSON a pull request could add',
    setup: () => {
      const dir = mkdtempSync(join(tmpdir(), 'flecto-fuzz-packs-'));
      mkdirSync(join(dir, 'policies'), { recursive: true });
      return { dir };
    },
    teardown: (ctx) => rmSync(ctx.dir, { recursive: true, force: true }),
    generate: (rng) => ({
      pack: policyPack(rng),
      // Pack ids come from `.flectorc`, which a pull request controls, so the
      // id itself is part of the attack surface.
      id: rng.weighted([
        [70, () => rng.chars('abcdefghij-', rng.between(1, 10))],
        [10, () => '../'.repeat(rng.between(1, 6)) + rng.chars('abc', 4)],
        [10, () => rng.chars('.$*?[]{}|\\', rng.between(1, 6))],
        [10, () => ''],
      ])(),
    }),
    run: (input, ctx) => {
      // A fresh filename per case: loadPack caches on (path, mtime), and reusing
      // one would test the cache rather than the loader.
      const id = `fz${(ctx.counter = (ctx.counter ?? 0) + 1)}`;
      const path = join(ctx.dir, 'policies', `${id}.json`);
      const serialized = safeStringify(input.pack);
      if (serialized === undefined) return;
      writeFileSync(path, serialized, 'utf8');

      const startedAt = Date.now();
      const result = cleanly('pack-load', () => loadPack(id, ctx.dir));
      assertWithinBudget('pack-load', startedAt);
      assertNoPrototypePollution('pack-load');
      if (result.ok) assertPlainResult(result.value, 'pack-load', 20000);

      // The pack id is a separate input: it must never resolve outside the
      // directories the loader searches, and must fail cleanly when it tries.
      cleanly('pack-load-id', () => loadPack(String(input.id ?? ''), ctx.dir));
      assertNoPrototypePollution('pack-load-id');
    },
  },

  {
    id: 'pack-eval',
    description: 'evaluatePack() with pack-supplied regexes against generated change events',
    generate: (rng) => ({
      pack: {
        id: 'fuzz',
        expandSubtrees: rng.bool(0.3),
        rules: Array.from({ length: rng.between(1, 6) }, () => ({
          id: rng.chars('abcdef', 6),
          severity: rng.pick(['info', 'warn', 'error']),
          message: '{path} {before} {after}',
          ...(rng.bool(0.8) ? { match: { path: regexSource(rng) } } : {}),
          ...(rng.bool(0.5) ? { afterMatches: regexSource(rng) } : {}),
          ...(rng.bool(0.3) ? { afterAnyMatches: regexSource(rng) } : {}),
        })),
      },
      changes: changeEvents(rng),
    }),
    run: (input) => {
      // Straight to evaluatePack, uncompiled: the fallback in pathRegexFor()
      // compiles on demand, so this exercises the evaluation path rather than
      // the loader's — which pack-load already covers.
      const startedAt = Date.now();
      cleanly('pack-eval', () => evaluatePack(input.pack, input.changes ?? []));
      assertWithinBudget('pack-eval', startedAt);
      assertNoPrototypePollution('pack-eval');
    },
  },
];

/** @type {Map<string, (typeof TARGETS)[number]>} */
export const TARGETS_BY_ID = new Map(TARGETS.map((target) => [target.id, target]));

/**
 * @param {number} depth
 * @returns {unknown}
 */
function deepTreeFromDepth(depth) {
  let node = /** @type {unknown} */ ('leaf');
  for (let i = 0; i < depth; i += 1) node = { n: node };
  return node;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function withCycleSafe(value) {
  if (value === null || typeof value !== 'object') return value;
  /** @type {Record<string, unknown>} */ (value).self = value;
  return value;
}

/**
 * JSON.stringify, tolerating the values a generator can produce that it cannot
 * encode (BigInt is not generated, but `undefined` at the root is).
 * @param {unknown} value
 * @returns {string | undefined}
 */
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
