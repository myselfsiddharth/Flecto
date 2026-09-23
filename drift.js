#!/usr/bin/env node
/**
 * `flecto-drift` — compare what a repository declares against what is running.
 *
 * Flecto answers "what changed in this file". The question underneath it is
 * usually "does what we declared still match what is running" — the config
 * committed six months ago, against the value somebody hotfixed into the
 * cluster at 3 AM and never backported (#144).
 *
 * **This is a separate binary on purpose.** Core Flecto authenticates to
 * nothing, reads no key material, and shells out to nothing but `git`; every
 * other command in this package keeps that promise. Reading live state cannot,
 * so it does not share an entry point with the tool that can. `flecto ci`
 * cannot reach this file, nothing in `src/` outside `drift-sources.js` imports
 * it, and installing Flecto does not enable it. The intent is for it to become
 * its own package with its own security review and release cadence; it lives
 * here now for the same reason the MCP server did, which is that one repository
 * is easier to review than two while the shape is still settling.
 *
 * It holds no credentials. Every source delegates to a tool the operator has
 * already installed and authenticated (`kubectl`, `aws`), so Flecto inherits
 * exactly what that tool is entitled to and nothing else — which is also what
 * makes "give it a read-only role" advice an operator can enforce in their own
 * IAM rather than a promise this code makes about itself.
 *
 * Values from a secret store are compared by **shape**, never by value, and
 * there is no flag to change that.
 */

import { program } from 'commander';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { resolve } from 'path';
import { diffTrees } from './src/differ.js';
import { assertTargetContained } from './src/config.js';
import { documentKeysOf } from './src/documents.js';
import { parseFile } from './src/parser.js';
import { renderDiff, renderError, renderInfo, renderNote } from './src/renderer.js';
import { readLiveState, shapeOf } from './src/drift-sources.js';

const require = createRequire(import.meta.url);
const { version } = require('./package.json');

/**
 * Keys a declared file carries that a live store never does.
 *
 * A Kubernetes ConfigMap's `data` block is what corresponds to a config file;
 * the manifest around it (`apiVersion`, `metadata`, …) has no counterpart in
 * the live read, and reporting all of it as "removed" would bury the one line
 * that actually drifted. Descending into `data` when it is there is the whole
 * of the normalization — anything cleverer would be guessing.
 * @param {unknown} declared
 * @returns {unknown}
 */
function declaredComparable(declared) {
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return declared;
  let record = /** @type {Record<string, unknown>} */ (declared);

  // A manifest carrying apiVersion + kind + metadata.name is wrapped by the
  // parser under a synthetic `Kind/ns/name` document key, so the `data` block
  // sits one level down. Looking only at the top level found nothing, and the
  // documented headline case -- a committed ConfigMap against an identical live
  // one -- reported the whole manifest as drift and exited 1 forever.
  const documents = documentKeysOf(declared) ?? [];
  if (documents.length === 1 && typeof record[documents[0]] === 'object' && record[documents[0]] !== null) {
    record = /** @type {Record<string, unknown>} */ (record[documents[0]]);
  }

  if (record.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
    return record.data;
  }
  if (documents.length > 1) {
    throw new Error(
      `drift: ${documents.length} documents in this file, and a live source is one object.`
      + ' Point drift at a file holding a single manifest.',
    );
  }
  return record;
}

/**
 * Compare declared values against live ones, shaping the declared side for
 * exactly the keys the live side shaped.
 *
 * Comparing a plaintext declared value against a live *shape* would report that
 * key as changed on every run, which is noise that trains people to ignore the
 * tool. So a shaped key is shaped on both sides, and every other key is
 * compared by value.
 * @param {unknown} declared
 * @param {Record<string, unknown>} live
 * @param {Set<string>} shapedKeys the live keys compared by shape
 * @param {(v: string) => string} shape
 * @returns {{ before: unknown, after: unknown }}
 */
function alignForComparison(declared, live, shapedKeys, shape) {
  const comparable = declaredComparable(declared);
  if (shapedKeys.size === 0 || !comparable || typeof comparable !== 'object' || Array.isArray(comparable)) {
    return { before: comparable, after: live };
  }
  // Per key, not per source. Shaping the whole declared side because *one*
  // value was sensitive compared a shaped declared value against a raw live
  // one, so every non-secret key drifted on every run -- the "trains people to
  // ignore the tool" failure this function exists to prevent.
  const shaped = Object.fromEntries(
    Object.entries(/** @type {Record<string, unknown>} */ (comparable))
      .map(([key, value]) => [key, shapedKeys.has(key) ? shape(stableString(value)) : value]),
  );
  return { before: shaped, after: live };
}

/**
 * A value as a string, matching how the live side stringifies before hashing.
 * @param {unknown} value
 * @returns {string}
 */
function stableString(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

program
  .name('flecto-drift')
  .description(
    'Compare a declared config file against what is actually running.\n'
    + 'Reads live state through a CLI you have already authenticated; holds no credentials.',
  )
  .version(version)
  .argument('<file>', 'the declared configuration file')
  .requiredOption('--against <uri>', 'live source: k8s://<ns>/configmap/<name>, k8s://<ns>/secret/<name>, ssm://<path>, tfstate://<path>')
  .option('--format <type>', 'human or json', 'human')
  .option('--fail-on-drift', 'exit 1 when the declared file and the live state differ', false)
  .action(async (file, opts) => {
    try {
      const format = String(opts.format);
      if (!['human', 'json'].includes(format)) {
        throw new Error('--format must be human or json');
      }

      const filepath = resolve(file);
      // The same containment every other read in Flecto has: file names and
      // links are attacker-controlled on an untrusted pull request.
      assertTargetContained(filepath, process.cwd());
      const declared = parseFile(filepath);

      const { state: live, meta } = readLiveState(opts.against);
      const { before, after } = alignForComparison(declared, live, meta.shapedKeys, shapeOf);

      // Declared is `before`, live is `after`, so the verbs read the way the
      // question is asked: what has the running system done to what we wrote.
      const changes = diffTrees(before, after, {});

      if (format === 'json') {
        process.stdout.write(`${JSON.stringify({
          file: filepath,
          against: opts.against,
          source: meta.label,
          // Named, so a consumer never has to guess whether a value in here is
          // a real value or a digest of one.
          comparison: meta.sensitive ? 'shape-only' : 'values',
          drifted: changes.length > 0,
          changes,
        }, null, 2)}\n`);
      } else if (changes.length === 0) {
        renderInfo(`No drift: ${filepath} matches ${meta.label}.`);
      } else {
        // Masked, like every other render path in Flecto. Drift prints values
        // read out of a live system into a CI log, so it needs this more than
        // the others, not less -- a ConfigMap value under a secret-shaped key
        // is still a secret.
        renderDiff(filepath, changes, { maskSecrets: true, baseline: meta.label });
        if (meta.sensitive) {
          renderNote(
            'Values from a secret store are compared by shape (length and digest), never by value.',
          );
        }
      }

      if (changes.length > 0 && opts.failOnDrift) process.exitCode = 1;
    } catch (err) {
      renderError(err.message);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
