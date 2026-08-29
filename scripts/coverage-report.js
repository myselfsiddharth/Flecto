#!/usr/bin/env node
/**
 * Focused coverage report for the modules where a gap is a security question
 * rather than a style one.
 *
 * `node --test --experimental-test-coverage` already prints a table, but it
 * prints one row per file with every uncovered line range appended, so the
 * numbers that matter are read out of several hundred columns of line numbers —
 * and the summary it ends on is a single repo-wide average, which is exactly
 * the number that averages away the parts worth looking at.
 *
 * This reads the lcov the same run emits and answers a narrower question:
 * **how many branches in the security-relevant modules have never executed in a
 * test?** That is the number that turns "we should look at src/alerter.js" into
 * a place to start a review, and into a way to know when one is finished.
 *
 * It never fails the build on a coverage number. A threshold chosen before
 * anyone has read the report is arbitrary, and the usual outcome is tests
 * written to satisfy the gate rather than to find defects (#149).
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

/**
 * The modules whose untested branches are a security question. Each is here for
 * a stated reason — this list is meant to be argued with and edited, not to grow
 * until it is the whole repository again.
 */
const SECURITY_RELEVANT = [
  ['src/config.js', 'plugin resolution — the path GHSA-wq8m-fc3q-8m5x ran through'],
  ['src/policy.js', 'policy pack loading, including packs resolved from node_modules'],
  ['src/secrets.js', 'secret detection; a miss here leaks, a false hit trains people to ignore it'],
  ['src/encrypted.js', 'encrypted files, which must be read for structure and never decrypted'],
  ['src/pr-comment.js', 'sticky-comment rendering and GitHub comment output'],
  ['src/pr-providers.js', 'provider tokens (GitHub, GitLab, Bitbucket) and redaction of them from errors'],
];

const LCOV_PATH = process.argv[2] ?? 'coverage.lcov';
// Wide enough for every src/ module; long fixture paths are elided instead.
const NAME_WIDTH = 26;

/**
 * @typedef {{
 *   file: string,
 *   lines: { found: number, hit: number },
 *   branches: { found: number, hit: number },
 *   functions: { found: number, hit: number }
 * }} FileCoverage
 */

/**
 * Node's lcov reporter may emit cwd-relative or absolute paths. The focused list
 * is repo-relative (`src/config.js`), so an absolute `SF:` would otherwise fail
 * the "module missing from the report" check on CI.
 * @param {string} file
 * @returns {string}
 */
function repoRelative(file) {
  const normalized = file.replace(/\\/g, '/');
  if (!isAbsolute(file) && !/^[A-Za-z]:[\\/]/.test(file)) {
    return normalized.replace(/^\.\//, '');
  }
  return relative(process.cwd(), file).replace(/\\/g, '/');
}

/**
 * Parse the subset of lcov the Node reporter emits. Only the summary counters
 * are read (LF/LH, BRF/BRH, FNF/FNH); the per-line records are what the built-in
 * table already prints.
 * @param {string} raw
 * @returns {Map<string, FileCoverage>}
 */
function parseLcov(raw) {
  /** @type {Map<string, FileCoverage>} */
  const files = new Map();
  /** @type {FileCoverage | null} */
  let current = null;

  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const tag = line.slice(0, separator);
    const value = line.slice(separator + 1);

    if (tag === 'SF') {
      // Normalize separators so a report generated on Windows reads the same,
      // and strip an absolute prefix so `SF:/runner/work/Flecto/src/config.js`
      // still matches the repo-relative focused list.
      const file = repoRelative(value.trim());
      current = {
        file,
        lines: { found: 0, hit: 0 },
        branches: { found: 0, hit: 0 },
        functions: { found: 0, hit: 0 },
      };
      files.set(file, current);
      continue;
    }
    if (!current) continue;

    const count = Number(value);
    if (!Number.isFinite(count)) continue;
    switch (tag) {
      case 'LF': current.lines.found = count; break;
      case 'LH': current.lines.hit = count; break;
      case 'BRF': current.branches.found = count; break;
      case 'BRH': current.branches.hit = count; break;
      case 'FNF': current.functions.found = count; break;
      case 'FNH': current.functions.hit = count; break;
      default: break;
    }
  }
  return files;
}

/**
 * A file with nothing to count sorts as fully covered, so an empty module does
 * not sit at the top of a list whose whole purpose is "look here first".
 * @param {{ found: number, hit: number }} counter
 * @returns {number}
 */
function percent(counter) {
  return counter.found === 0 ? 100 : (counter.hit / counter.found) * 100;
}

/**
 * A metric with nothing to count is reported as `n/a`, not as 100% — a file
 * whose branches were never even enumerated is not a covered file.
 * @param {{ found: number, hit: number }} counter
 * @returns {string}
 */
function pct(counter) {
  return (counter.found === 0 ? 'n/a' : `${percent(counter).toFixed(1)}%`).padStart(6);
}

/**
 * Long fixture paths would otherwise set the column width for every row.
 * @param {string} file
 * @returns {string}
 */
function short(file) {
  return file.length <= NAME_WIDTH ? file : `…${file.slice(-(NAME_WIDTH - 1))}`;
}

/** @param {FileCoverage[]} entries @returns {FileCoverage} */
function total(entries) {
  const sum = {
    file: 'total',
    lines: { found: 0, hit: 0 },
    branches: { found: 0, hit: 0 },
    functions: { found: 0, hit: 0 },
  };
  for (const entry of entries) {
    for (const metric of /** @type {const} */ (['lines', 'branches', 'functions'])) {
      sum[metric].found += entry[metric].found;
      sum[metric].hit += entry[metric].hit;
    }
  }
  return sum;
}

/**
 * @param {FileCoverage} entry
 * @param {number} width
 * @returns {string}
 */
function row(entry, width) {
  const missedBranches = entry.branches.found - entry.branches.hit;
  return `  ${short(entry.file).padEnd(width)}  ${pct(entry.lines)}  `
    + `${pct(entry.branches)}  ${pct(entry.functions)}  ${String(missedBranches).padStart(6)}`;
}

/**
 * @param {string} title
 * @param {FileCoverage[]} entries
 * @param {number} width
 */
function printTable(title, entries, width) {
  const header = `  ${'file'.padEnd(width)}  ${'lines'.padStart(6)}  `
    + `${'branch'.padStart(6)}  ${'funcs'.padStart(6)}  ${'missed'.padStart(6)}`;
  console.log(`\n${title}`);
  console.log(header);
  console.log(`  ${'-'.repeat(width + 32)}`);
  for (const entry of entries) console.log(row(entry, width));
}

function main() {
  let raw;
  try {
    raw = readFileSync(LCOV_PATH, 'utf8');
  } catch (err) {
    console.error(`Cannot read coverage data at ${LCOV_PATH}: ${err.message}`);
    console.error('Run `npm run test:coverage` first.');
    process.exitCode = 1;
    return;
  }

  const files = parseLcov(raw);
  const missing = SECURITY_RELEVANT.filter(([file]) => !files.has(file)).map(([file]) => file);
  if (missing.length > 0) {
    // Not a coverage threshold: the report would be quietly describing fewer
    // modules than it claims to, which is worse than a low number.
    console.error(`Coverage report does not cover: ${missing.join(', ')}`);
    console.error('If a module moved, update SECURITY_RELEVANT in scripts/coverage-report.js.');
    process.exitCode = 1;
    return;
  }

  const focus = SECURITY_RELEVANT.map(([file]) => /** @type {FileCoverage} */ (files.get(file)))
    // Worst branch coverage first: this list is read top-down to decide where a
    // review starts.
    .sort((a, b) => percent(a.branches) - percent(b.branches));
  const rest = [...files.values()]
    .filter((entry) => !SECURITY_RELEVANT.some(([file]) => file === entry.file))
    .sort((a, b) => percent(a.branches) - percent(b.branches));

  const width = Math.min(
    NAME_WIDTH,
    Math.max(...[...files.values()].map((entry) => entry.file.length), 'file'.length),
  );

  printTable('Security-relevant modules (worst branch coverage first)', focus, width);
  console.log(row({ ...total(focus), file: 'subtotal' }, width));

  printTable('Everything else', rest, width);
  console.log(row({ ...total(rest), file: 'subtotal' }, width));

  console.log(`\n${row({ ...total([...files.values()]), file: 'all files' }, width)}`);

  console.log('\nWhy each module is on the focused list:');
  for (const [file, reason] of SECURITY_RELEVANT) console.log(`  ${file} — ${reason}`);
  console.log(
    '\n`missed` counts branches that never executed in any test — the number to'
    + '\nread first. No threshold gates this job: the numbers are for deciding where'
    + '\nto look (see #121), not for passing a check.',
  );
}

main();
