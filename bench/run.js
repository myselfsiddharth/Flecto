#!/usr/bin/env node
/**
 * Flecto performance benchmark harness.
 *
 * Answers one question: on a large repo, where does `flecto ci` actually spend
 * its time — parsing, diffing, or policy evaluation? Everything is measured
 * with `node:perf_hooks`; no benchmarking dependency is used.
 *
 * The harness generates a synthetic repo in a temp directory, snapshots it,
 * mutates it, and then measures:
 *   1. `flecto ci` end-to-end wall time (real subprocess, real CLI)
 *   2. the same pipeline in-process, with per-phase attribution
 *   3. `flecto watch --snapshot`, the batch baseline-writing path
 *   4. differ and policy microbenchmarks that isolate suspected hot spots
 *   5. context savings: the size of the semantic diff against the size of the
 *      config it describes, across three mutation rates
 *
 * Usage:
 *   npm run bench
 *   npm run bench -- --runs 15 --scales 50,250,1000
 *   npm run bench -- --quick          # fast smoke run
 *   npm run bench -- --json out.json  # also write raw samples
 *   npm run bench -- --keep           # keep the generated repo for inspection
 *
 * This never runs during `npm test` and is excluded from the published package.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { loadRcConfig, resolveFiles } from '../src/config.js';
import { diffTrees } from '../src/differ.js';
import { createEnvelope } from '../src/envelope.js';
import { parseFile, isSupported } from '../src/parser.js';
import { evaluatePack, evaluatePolicies, loadPack } from '../src/policy.js';
import { MUTATE_EVERY, arrayPair, writeRepo } from './fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'index.js');
const DEFAULT_SCALES = [50, 250, 1000];
const DEFAULT_RUNS = 11;
const ARRAY_SIZES = [1000, 2000, 4000, 8000, 16000, 32000];
const SNAPSHOT_DIR = '.flecto-snapshots';

/* ------------------------------------------------------------------ stats */

/**
 * @param {number[]} values
 * @param {number} q quantile in [0, 1]
 * @returns {number}
 */
function quantile(values, q) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: with the sample sizes a benchmark can afford, interpolation
  // would only invent precision that is not there.
  const rank = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, rank)];
}

/**
 * @param {number[]} values
 * @returns {{ n: number, min: number, median: number, p95: number, max: number }}
 */
function summarize(values) {
  return {
    n: values.length,
    min: Math.min(...values),
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    max: Math.max(...values),
  };
}

/**
 * Format a millisecond duration for a report cell.
 * @param {number} value
 * @param {number} [digits]
 * @returns {string}
 */
function ms(value, digits = 1) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(digits)} ms`;
}

/**
 * Render a markdown table so results paste straight into an issue.
 * @param {string[]} headers
 * @param {Array<Array<string | number>>} rows
 * @returns {string}
 */
function table(headers, rows) {
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
  return lines.join('\n');
}

/* ------------------------------------------------------------- harness IO */

/**
 * Mirror of index.js snapshotPathForFile(). Kept local so the benchmark never
 * forces the CLI to export internals just to be measured.
 * @param {string} repoDir
 * @param {string} absPath
 * @returns {string}
 */
function snapshotPathFor(repoDir, absPath) {
  const id = createHash('sha256').update(absPath.replaceAll('\\', '/')).digest('hex').slice(0, 16);
  return join(repoDir, SNAPSHOT_DIR, `${id}.json`);
}

/**
 * Run the real CLI in a subprocess and return its wall time.
 * @param {string[]} args
 * @param {string} cwd
 * @param {number[]} [okStatuses] exit codes that are expected (ci exits 1 on changes)
 * @returns {number} elapsed milliseconds
 */
function runCli(args, cwd, okStatuses = [0]) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    // stdout is discarded: this measures Flecto, not the terminal. stderr is
    // captured so a broken run fails loudly instead of posting a fast lie.
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const elapsed = performance.now() - started;
  if (!okStatuses.includes(result.status)) {
    throw new Error(`flecto ${args.join(' ')} exited ${result.status}\n${result.stderr ?? ''}`);
  }
  return elapsed;
}

/**
 * Re-implement the `flecto ci` per-file pipeline in-process with a timer around
 * each phase. This is the attribution deliverable: it calls the same exported
 * functions the CLI calls, in the same order.
 * @param {string} repoDir
 * @param {string[]} packIds
 * @returns {Promise<Record<string, number>>}
 */
async function attributePhases(repoDir, packIds) {
  const phases = { discovery: 0, baseline: 0, parse: 0, diff: 0, policy: 0, serialize: 0 };
  const startedAt = performance.now();

  let mark = performance.now();
  const { config } = loadRcConfig(repoDir);
  const targets = (await resolveFiles({
    cwd: repoDir,
    files: config?.files ?? [],
    exclude: config?.exclude ?? [],
  })).map((f) => resolve(f));
  phases.discovery = performance.now() - mark;

  const diffOptions = { ignorePaths: [], arrayIdKey: null, arrayIdentity: true, arrayIgnoreOrder: false };
  const results = [];
  let changeCount = 0;
  let findingCount = 0;

  for (const filepath of targets) {
    if (!existsSync(filepath) || !isSupported(filepath)) continue;

    mark = performance.now();
    const after = parseFile(filepath);
    phases.parse += performance.now() - mark;

    mark = performance.now();
    const snapshot = JSON.parse(readFileSync(snapshotPathFor(repoDir, filepath), 'utf8'));
    const before = snapshot?.state ?? snapshot;
    phases.baseline += performance.now() - mark;

    mark = performance.now();
    const events = diffTrees(before, after, diffOptions);
    phases.diff += performance.now() - mark;

    mark = performance.now();
    const findings = await evaluatePolicies(events, {
      cwd: repoDir,
      file: filepath,
      profile: null,
      source: 'ci',
      policies: packIds,
    });
    phases.policy += performance.now() - mark;

    changeCount += events.length;
    findingCount += findings.length;
    results.push({
      file: filepath,
      envelope: createEnvelope({ source: 'ci', file: filepath, changes: events, policies: findings }),
      policies: findings,
    });
  }

  mark = performance.now();
  const json = JSON.stringify(results, null, 2);
  phases.serialize = performance.now() - mark;

  phases.total = performance.now() - startedAt;
  phases.files = results.length;
  phases.changes = changeCount;
  phases.findings = findingCount;
  phases.outputBytes = json.length;
  // Measured after `total` so the extra serialization never lands in a timing.
  // Isolates the semantic payload from the per-file envelope `ci` emits for
  // every scanned file, changed or not.
  phases.changedOutputBytes = JSON.stringify(
    results.filter((result) => result.envelope.changes.length > 0),
    null,
    2,
  ).length;
  return phases;
}

/* --------------------------------------------------------------- sections */

/**
 * @param {{ scales: number[], runs: number, root: string, snapshotRuns: number }} options
 * @returns {Promise<object[]>}
 */
async function benchmarkScales(options) {
  const out = [];

  for (const fileCount of options.scales) {
    const repoDir = join(options.root, `repo-${fileCount}`);
    mkdirSync(repoDir, { recursive: true });
    process.stderr.write(`\n[bench] scale ${fileCount}: generating fixtures...\n`);
    const baseline = writeRepo({ dir: repoDir, fileCount, mutate: false });

    // --- `flecto watch --snapshot`: cold (no snapshot dir) then warm (a prior
    // run's snapshots and history already on disk). Directory resets happen
    // outside the timer.
    const snapshotDir = join(repoDir, SNAPSHOT_DIR);
    const pristine = join(options.root, `pristine-${fileCount}`);
    const coldSnapshot = [];
    for (let i = 0; i < options.snapshotRuns + 1; i++) {
      rmSync(snapshotDir, { recursive: true, force: true });
      const elapsed = runCli(['watch', '--snapshot'], repoDir);
      if (i > 0) coldSnapshot.push(elapsed);
      if (i === 0) {
        rmSync(pristine, { recursive: true, force: true });
        cpSync(snapshotDir, pristine, { recursive: true });
      }
    }

    const warmSnapshot = [];
    for (let i = 0; i < options.snapshotRuns + 1; i++) {
      rmSync(snapshotDir, { recursive: true, force: true });
      cpSync(pristine, snapshotDir, { recursive: true });
      const elapsed = runCli(['watch', '--snapshot'], repoDir);
      if (i > 0) warmSnapshot.push(elapsed);
    }

    // Leave exactly the baseline snapshots in place, then mutate the repo so
    // the diff runs have real work to do.
    rmSync(snapshotDir, { recursive: true, force: true });
    cpSync(pristine, snapshotDir, { recursive: true });
    rmSync(pristine, { recursive: true, force: true });
    const mutated = writeRepo({ dir: repoDir, fileCount, mutate: true });

    // --- `flecto ci` end to end.
    process.stderr.write(`[bench] scale ${fileCount}: ci end-to-end (${options.runs} runs)...\n`);
    const ciWall = [];
    for (let i = 0; i < options.runs + 1; i++) {
      const elapsed = runCli(['ci', '--format', 'json'], repoDir, [0, 1]);
      if (i > 0) ciWall.push(elapsed);
    }

    // --- in-process phase attribution.
    process.stderr.write(`[bench] scale ${fileCount}: phase attribution (${options.runs} runs)...\n`);
    /** @type {Record<string, number[]>} */
    const phaseSamples = {};
    let lastPhases = null;
    for (let i = 0; i < options.runs + 1; i++) {
      const phases = await attributePhases(repoDir, ['default']);
      lastPhases = phases;
      if (i === 0) continue;
      for (const [key, value] of Object.entries(phases)) {
        (phaseSamples[key] ??= []).push(value);
      }
    }

    out.push({
      fileCount,
      repoDir,
      bytes: mutated.bytes,
      baselineBytes: baseline.bytes,
      files: lastPhases.files,
      changes: lastPhases.changes,
      findings: lastPhases.findings,
      outputBytes: lastPhases.outputBytes,
      ciWall: summarize(ciWall),
      coldSnapshot: summarize(coldSnapshot),
      warmSnapshot: summarize(warmSnapshot),
      phases: Object.fromEntries(Object.entries(phaseSamples).map(([k, v]) => [k, summarize(v)])),
      samples: { ciWall, coldSnapshot, warmSnapshot, phases: phaseSamples },
    });
  }

  return out;
}

/**
 * Time one function, discarding a warmup run.
 * @param {() => unknown} fn
 * @param {number} runs
 * @returns {{ n: number, min: number, median: number, p95: number, max: number }}
 */
/**
 * Context savings: how much smaller is the semantic diff than the config it
 * describes?
 *
 * Two denominators are reported, because they answer different questions:
 *
 *   corpus  — every config byte in the repo. This is what something that had
 *             to read the repo to find out what changed would consume.
 *   changed — only the files that actually changed. This is the honest floor:
 *             it assumes the reader already knows which files to open, and it
 *             is the number to quote when comparing against a reader that is
 *             handed the file list for free.
 *
 * The ratio is governed almost entirely by how much of the corpus a change
 * touches, so all three mutation rates are measured rather than the flattering
 * one. `every file changed` is the worst case the design can produce.
 *
 * The corpus here excludes the 5,000-item array fixtures the timing sections
 * use. They are a differ stress test, they are ~90% of the corpus by byte
 * count, and leaving them in would mean reporting a ratio for a repo nobody
 * has rather than for ordinary service config.
 * @param {{ root: string, fileCount: number }} options
 */
async function benchmarkContext(options) {
  const { root, fileCount } = options;
  const repoDir = join(root, `context-${fileCount}`);

  const scenarios = [
    { label: 'one file changed', mutateEvery: fileCount },
    { label: `every ${MUTATE_EVERY}th file changed`, mutateEvery: MUTATE_EVERY },
    { label: 'every file changed', mutateEvery: 1 },
  ];

  const rows = [];
  for (const scenario of scenarios) {
    process.stderr.write(`[bench] context: ${fileCount} files, ${scenario.label}...\n`);
    rmSync(repoDir, { recursive: true, force: true });
    mkdirSync(repoDir, { recursive: true });

    const shape = { dir: repoDir, fileCount, mutateEvery: scenario.mutateEvery, bigArrays: false };
    writeRepo({ ...shape, mutate: false });
    runCli(['watch', '--snapshot'], repoDir);
    const mutated = writeRepo({ ...shape, mutate: true });

    // Same envelope `flecto ci --format json` prints, serialized the same way,
    // so the byte count is what a consumer would actually receive.
    const phases = await attributePhases(repoDir, ['default']);

    rows.push({
      label: scenario.label,
      changedFiles: mutated.files.filter((file) => file.mutated).length,
      corpusBytes: mutated.bytes,
      changedBytes: mutated.changedBytes,
      envelopeBytes: phases.outputBytes,
      payloadBytes: phases.changedOutputBytes,
      changes: phases.changes,
    });
  }

  rmSync(repoDir, { recursive: true, force: true });
  return { fileCount, rows };
}

/**
 * Where the semantic diff starts paying off.
 *
 * The context-savings claim is really about one shape: a small change inside a
 * large file. This isolates that variable — exactly one key changes, and the
 * file it lives in grows — and reports the file size at which reading the diff
 * becomes cheaper than reading the file.
 *
 * The envelope is built exactly as `flecto ci --format json` builds it, one
 * file's worth, so the byte count is directly comparable.
 * @returns {{ keys: number, fileBytes: number, payloadBytes: number, changes: number }[]}
 */
function benchmarkCrossover() {
  const diffOptions = { ignorePaths: [], arrayIdKey: null, arrayIdentity: true, arrayIgnoreOrder: false };
  const file = '/srv/repo/config/services.json';
  const rows = [];

  for (const keys of [10, 50, 200, 1000, 5000]) {
    /** @type {Record<string, unknown>} */
    const before = {};
    for (let i = 0; i < keys; i++) {
      before[`service_${i}`] = {
        host: `svc-${i}.internal.example.com`,
        pool_size: 8,
        timeout_ms: 3000,
        retries: 3,
        tls: true,
      };
    }
    const after = JSON.parse(JSON.stringify(before));
    // Exactly one key changes, whatever the file size.
    after.service_0.pool_size = 32;

    const changes = diffTrees(before, after, diffOptions);
    const envelope = createEnvelope({ source: 'ci', file, changes, policies: [] });
    const payload = JSON.stringify([{ file, envelope, policies: [] }], null, 2);

    rows.push({
      keys,
      fileBytes: Buffer.byteLength(JSON.stringify(before, null, 2)),
      payloadBytes: payload.length,
      changes: changes.length,
    });
  }

  return rows;
}

function timeIt(fn, runs) {
  fn();
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  return summarize(samples);
}

/**
 * Array diffing across sizes, for each strategy. A linear path roughly doubles
 * when the size doubles; anything approaching 4x is superlinear.
 * @param {number} runs
 * @param {number[]} sizes
 * @returns {object[]}
 */
function benchmarkArrays(runs, sizes) {
  const modes = [
    { id: 'identity (auto id)', shape: {}, options: { arrayIdentity: true } },
    { id: 'identity + rotated', shape: { reorder: true }, options: { arrayIdentity: true } },
    { id: 'by index', shape: {}, options: { arrayIdentity: false } },
    { id: 'ignoreOrder (no id)', shape: { identity: false }, options: { arrayIdentity: true, arrayIgnoreOrder: true } },
  ];

  const out = [];
  for (const mode of modes) {
    let previous = null;
    for (const size of sizes) {
      const { before, after } = arrayPair(size, mode.shape);
      const stats = timeIt(() => diffTrees({ items: before }, { items: after }, mode.options), runs);
      out.push({
        mode: mode.id,
        size,
        ...stats,
        growth: previous ? stats.median / previous : null,
      });
      previous = stats.median;
    }
  }
  return out;
}

/**
 * Policy evaluation throughput, plus the cost of the per-file `evaluatePolicies`
 * entry point (which re-resolves and re-validates the pack on every call).
 * @param {number} runs
 * @returns {Promise<object>}
 */
async function benchmarkPolicy(runs) {
  const events = [];
  for (let i = 0; i < 20000; i++) {
    const kind = i % 4;
    if (kind === 0) events.push({ type: 'changed', path: `services[${i}].database.pool_size`, before: 8, after: 32 });
    else if (kind === 1) events.push({ type: 'changed', path: `services[${i}].features.debug`, before: false, after: true });
    else if (kind === 2) events.push({ type: 'added', path: `services[${i}].env.API_KEY`, after: `sk_live_${i}_a71c3e90fd` });
    else events.push({ type: 'changed', path: `services[${i}].server.timeout_ms`, before: 3000, after: 4000 });
  }

  const pack = loadPack('default', resolve(HERE, '..'));
  const perPack = timeIt(() => evaluatePack(pack, events), runs);

  // The shape `flecto ci` actually uses: one call per file, each with a handful
  // of change events.
  const smallBatch = events.slice(0, 12);
  const cwd = resolve(HERE, '..');
  const callSamples = [];
  await evaluatePolicies(smallBatch, { cwd, source: 'ci', policies: ['default'] });
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    for (let call = 0; call < 200; call++) {
      await evaluatePolicies(smallBatch, { cwd, source: 'ci', policies: ['default'] });
    }
    callSamples.push((performance.now() - started) / 200);
  }

  // Isolate the regex handling inside matchClause(): a rule's `match.path` is
  // compiled inside the per-change loop rather than once per rule. This times
  // the same pattern against the same paths both ways, so the difference is the
  // cost the current placement adds.
  const paths = events.map((event) => event.path);
  const source = '(secret|token|password|api[_-]?key|private[_-]?key)';
  const compiled = new RegExp(source, 'i');
  const regexPerEvent = timeIt(() => {
    let hits = 0;
    for (const path of paths) if (new RegExp(source, 'i').test(path)) hits++;
    return hits;
  }, runs);
  const regexHoisted = timeIt(() => {
    let hits = 0;
    for (const path of paths) if (compiled.test(path)) hits++;
    return hits;
  }, runs);

  // The per-file entry point re-resolves and re-validates the pack every call.
  const packLoad = timeIt(() => loadPack('default', cwd), runs);

  return {
    eventCount: events.length,
    ruleCount: pack.rules.length,
    perPack,
    perEventUs: (perPack.median * 1000) / events.length,
    perFileCall: summarize(callSamples),
    packLoad,
    regexPerEvent,
    regexHoisted,
    regexOverheadNs: ((regexPerEvent.median - regexHoisted.median) * 1e6) / paths.length,
  };
}

/**
 * Node process startup plus Flecto's module graph — the floor under any CLI run.
 * @param {number} runs
 * @returns {{ node: object, cli: object }}
 */
function benchmarkStartup(runs) {
  const nodeSamples = [];
  const cliSamples = [];
  for (let i = 0; i < runs + 1; i++) {
    const started = performance.now();
    spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const nodeElapsed = performance.now() - started;
    const cliElapsed = runCli(['--version'], HERE);
    if (i === 0) continue;
    nodeSamples.push(nodeElapsed);
    cliSamples.push(cliElapsed);
  }
  return { node: summarize(nodeSamples), cli: summarize(cliSamples) };
}

/* ------------------------------------------------------------------- main */

/**
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const quick = Boolean(args.quick);
  const runs = Number(args.runs ?? (quick ? 3 : DEFAULT_RUNS));
  const scales = args.scales
    ? String(args.scales).split(',').map((s) => Number(s.trim())).filter(Boolean)
    : quick ? [50] : DEFAULT_SCALES;
  const arraySizes = quick ? ARRAY_SIZES.slice(0, 3) : ARRAY_SIZES;
  const snapshotRuns = Math.min(runs, quick ? 2 : 5);

  const root = args.dir
    ? resolve(String(args.dir))
    : mkdtempSync(join(realpathSync(tmpdir()), 'flecto-bench-'));
  mkdirSync(root, { recursive: true });

  const startedAt = Date.now();
  process.stderr.write(`[bench] node ${process.version} — fixtures in ${root}\n`);

  try {
    const startup = benchmarkStartup(runs);
    const scaleResults = await benchmarkScales({ scales, runs, root, snapshotRuns });
    const arrays = benchmarkArrays(runs, arraySizes);
    const policy = await benchmarkPolicy(runs);
    // Scale-invariant (it is a per-file property), so it runs once, at the
    // largest configured scale.
    const context = await benchmarkContext({ root, fileCount: scales[scales.length - 1] });
    const crossover = benchmarkCrossover();

    const report = {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpu: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
      memGb: Math.round(totalmem() / 1024 ** 3),
      runs,
      snapshotRuns,
      startup,
      scales: scaleResults,
      arrays,
      policy,
      context,
      crossover,
      durationS: Math.round((Date.now() - startedAt) / 1000),
    };

    printReport(report);
    if (args.json) {
      const path = resolve(String(args.json === true ? 'bench-results.json' : args.json));
      writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      process.stderr.write(`\n[bench] raw samples written to ${path}\n`);
    }
  } finally {
    if (!args.keep && !args.dir) {
      rmSync(root, { recursive: true, force: true });
    } else {
      process.stderr.write(`\n[bench] fixtures kept at ${root}\n`);
    }
  }
}

/**
 * @param {object} report
 */
function printReport(report) {
  const lines = [];
  lines.push('# Flecto benchmark');
  lines.push('');
  lines.push(`- Node: ${report.node} (${report.platform})`);
  lines.push(`- CPU: ${report.cpu} — ${report.cores} logical cores, ${report.memGb} GB RAM`);
  lines.push(`- Runs per measurement: ${report.runs} (plus 1 discarded warmup); snapshot runs: ${report.snapshotRuns}`);
  lines.push(`- Total harness time: ${report.durationS}s`);
  lines.push('- Results are machine-dependent; compare ratios, not absolutes.');
  lines.push('');

  lines.push('## 1. End-to-end wall time');
  lines.push('');
  lines.push(table(
    ['files', 'config bytes', 'changes', 'findings', '`ci` median', '`ci` p95', 'snapshot cold (median)', 'snapshot warm (median)'],
    report.scales.map((s) => [
      s.fileCount,
      `${(s.bytes / 1024 / 1024).toFixed(1)} MB`,
      s.changes,
      s.findings,
      ms(s.ciWall.median, 0),
      ms(s.ciWall.p95, 0),
      ms(s.coldSnapshot.median, 0),
      ms(s.warmSnapshot.median, 0),
    ]),
  ));
  lines.push('');
  lines.push(`Process floor: bare \`node -e 0\` ${ms(report.startup.node.median)}, \`flecto --version\` ${ms(report.startup.cli.median)} (module graph load).`);
  lines.push('');

  lines.push('## 2. Phase attribution (in-process, medians)');
  lines.push('');
  const phaseKeys = ['discovery', 'baseline', 'parse', 'diff', 'policy', 'serialize'];
  const phaseLabels = {
    discovery: 'glob discovery',
    baseline: 'snapshot load',
    parse: 'parse',
    diff: 'diff',
    policy: 'policy',
    serialize: 'serialize output',
  };
  for (const scale of report.scales) {
    const total = scale.phases.total.median;
    const accounted = phaseKeys.reduce((sum, key) => sum + scale.phases[key].median, 0);
    lines.push(`**${scale.fileCount} files** — pipeline total ${ms(total, 0)} (median of ${scale.phases.total.n} runs), ${scale.changes} change events, ${scale.findings} policy findings`);
    lines.push('');
    lines.push(table(
      ['phase', 'median', 'p95', 'share'],
      [
        ...phaseKeys.map((key) => [
          phaseLabels[key],
          ms(scale.phases[key].median),
          ms(scale.phases[key].p95),
          `${((scale.phases[key].median / total) * 100).toFixed(1)}%`,
        ]),
        ['other (fs stat, envelope)', ms(total - accounted), '—', `${(((total - accounted) / total) * 100).toFixed(1)}%`],
      ],
    ));
    lines.push('');
  }

  lines.push('## 3. Array diff scaling');
  lines.push('');
  lines.push('`growth` is median(size) / median(size/2): ~2.0 is linear, ~4.0 is quadratic.');
  lines.push('');
  lines.push(table(
    ['strategy', 'items', 'median', 'p95', 'growth'],
    report.arrays.map((row) => [
      row.mode,
      row.size,
      ms(row.median, 2),
      ms(row.p95, 2),
      row.growth ? `${row.growth.toFixed(2)}x` : '—',
    ]),
  ));
  lines.push('');

  lines.push('## 4. Policy evaluation');
  lines.push('');
  lines.push(table(
    ['measurement', 'median'],
    [
      [`evaluatePack over ${report.policy.eventCount} events (${report.policy.ruleCount} rules)`, ms(report.policy.perPack.median)],
      ['per change event', `${report.policy.perEventUs.toFixed(2)} µs`],
      ['evaluatePolicies() call with 12 events (the per-file shape `ci` uses)', ms(report.policy.perFileCall.median, 3)],
      ['— of which loadPack() re-resolve + re-validate', ms(report.policy.packLoad.median, 3)],
      [`${report.policy.eventCount} path tests, regex built per event (as today)`, ms(report.policy.regexPerEvent.median, 2)],
      [`${report.policy.eventCount} path tests, regex built once`, ms(report.policy.regexHoisted.median, 2)],
      ['— per-event cost of building the regex in the loop', `${report.policy.regexOverheadNs.toFixed(0)} ns`],
    ],
  ));
  lines.push('');

  lines.push('## 5. Context savings');
  lines.push('');
  lines.push(`Semantic diff size against the config it describes — ${report.context.fileCount} files, \`--format json\`.`);
  lines.push('');
  lines.push(table(
    ['change', 'files', 'changes', 'corpus', 'changed files', '`ci` output', 'payload only', 'payload vs changed'],
    report.context.rows.map((row) => [
      row.label,
      String(row.changedFiles),
      String(row.changes),
      kb(row.corpusBytes),
      kb(row.changedBytes),
      kb(row.envelopeBytes),
      kb(row.payloadBytes),
      ratio(row.changedBytes, row.payloadBytes),
    ]),
  ));
  lines.push('');
  lines.push('`ci` output is everything `flecto ci --format json` prints. It carries one envelope');
  lines.push('per **scanned** file — schema version, two UUIDs, a timestamp, an absolute path —');
  lines.push('whether or not that file changed, so it grows with repo size rather than with the');
  lines.push('size of the change. `payload only` counts the envelopes that actually carry changes.');
  lines.push('');
  lines.push('The gap between those two columns is the cost of the current output shape, and at');
  lines.push('these scales it dominates: the boilerplate for unchanged files is far larger than');
  lines.push('the semantic content. Any claim about a semantic diff being cheaper to read than');
  lines.push('the config must be made about `payload only`, and must state the mutation rate —');
  lines.push('the ratio collapses as more of the corpus changes, and inverts once a change');
  lines.push('touches most keys, because a change event costs more bytes than the value it describes.');
  lines.push('');
  lines.push('### Where a diff starts paying off');
  lines.push('');
  lines.push('One key changed, in a file that grows. This is the shape the claim is actually about.');
  lines.push('');
  lines.push(table(
    ['keys in file', 'file', 'one-file `ci` payload', 'payload vs file'],
    report.crossover.map((row) => [
      String(row.keys),
      kb(row.fileBytes),
      kb(row.payloadBytes),
      ratio(row.fileBytes, row.payloadBytes),
    ]),
  ));
  lines.push('');
  lines.push('A single change event plus its envelope costs a fixed ~600 bytes, so the diff only');
  lines.push('wins once the file is bigger than that — and then it wins by more and more, because');
  lines.push('the payload stays flat while the file grows. That fixed floor, not the change itself,');
  lines.push('is what decides whether reading a diff is cheaper than reading the file.');
  lines.push('');

  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function kb(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Size ratio, rendered as the multiple a reader saves. Below 1x the diff is
 * larger than what it describes, which the worst case can genuinely produce.
 * @param {number} from
 * @param {number} to
 * @returns {string}
 */
function ratio(from, to) {
  if (!to) return '—';
  return `${(from / to).toFixed(1)}x`;
}

main().catch((error) => {
  process.stderr.write(`[bench] failed: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
