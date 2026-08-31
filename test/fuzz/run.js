/**
 * Fuzz driver for the untrusted boundary (#150).
 *
 *   npm run fuzz                       # every target, 30s each, random seed
 *   npm run fuzz -- --target parse-yaml --time 120
 *   npm run fuzz -- --target diff-trees --seed 1234567 --case 8812
 *   npm run fuzz -- --replay test/fixtures/fuzz/parse-yaml-alias-bomb.json
 *
 * Three properties this is built around, all of them from the issue:
 *
 * **The time budget is enforced from outside.** Each target runs in a child
 * process that writes the case index before it runs the case. When that
 * heartbeat stops for longer than the per-case budget, the driver kills the
 * child and reports a hang. A fuzz run that hangs the CI job instead of failing
 * it is worse than no fuzz run.
 *
 * **A finding is reproducible in one command.** A case is `(target, seed,
 * index)` and the generators are pure, so the driver regenerates any case —
 * including one the child died on — and prints the command that replays it.
 *
 * **A finding becomes a regression test.** The input is shrunk, written to
 * `test/fuzz/findings/`, and the printed next step is to move it into
 * `test/fixtures/fuzz/`, where `test/fuzz-regressions.test.js` replays it as
 * part of the ordinary suite forever after. The fuzzer finds it once; the suite
 * keeps it fixed.
 *
 * This is never part of `npm test`, and the workflow that runs it is scheduled
 * rather than on pull requests: a fuzz run that gates a merge is a flaky merge
 * gate.
 */

import { spawn, spawnSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

import { makeRng, caseSeed } from './rng.js';
import { TARGETS, TARGETS_BY_ID, CASE_BUDGET_MS } from './targets.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'worker.js');
const CHECKER = join(HERE, 'check.js');
const FINDINGS_DIR = join(HERE, 'findings');
const FIXTURES_DIR = join(HERE, '..', 'fixtures', 'fuzz');

/** How long one target runs before the driver moves on, in seconds. */
const DEFAULT_TIME_S = 30;
/** Cases per worker process. Small enough that a hang costs little, large enough that spawning is not the cost. */
const CHUNK = 500;
/** Candidates tried while shrinking a finding. Bounded: a rare event may be slow, but not unbounded. */
const SHRINK_ATTEMPTS = 240;

/**
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[name] = true;
    } else {
      args[name] = next;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printUsage();
  process.exit(0);
}

if (args.list) {
  for (const target of TARGETS) {
    process.stdout.write(`${target.id.padEnd(18)}${target.description}\n`);
  }
  process.exit(0);
}

if (args.replay) {
  const file = String(args.replay);
  const targetId = String(args.target ?? guessTargetFromFilename(file) ?? '');
  if (!TARGETS_BY_ID.has(targetId)) {
    process.stderr.write(
      `Cannot tell which target "${file}" belongs to. Pass --target <id>, or name the file <target-id>-<something>.json.\n`,
    );
    process.exit(2);
  }
  const outcome = runCandidate(targetId, file, budgetMs());
  process.stdout.write(`${targetId}  ${file}\n  ${describeOutcome(outcome)}\n`);
  process.exit(outcome.kind === 'ok' ? 0 : 1);
}

const seed = args.seed !== undefined
  ? Number(args.seed) >>> 0
  : (Math.floor(Math.random() * 0xffffffff) >>> 0);
const selected = selectTargets(String(args.target ?? 'all'));
if (selected.length === 0) {
  process.stderr.write(`Unknown target "${args.target}". Run with --list to see them.\n`);
  process.exit(2);
}

if (args.case !== undefined) {
  const index = Number(args.case);
  const target = selected[0];
  process.stdout.write(`Replaying ${target.id} seed=${seed} case=${index}\n`);
  const file = writeInput(join(FINDINGS_DIR, `${target.id}-${seed}-${index}.input.json`), regenerate(target, seed, index));
  const outcome = runCandidate(target.id, file, budgetMs());
  process.stdout.write(`  ${describeOutcome(outcome)}\n  input: ${rel(file)}\n`);
  process.exit(outcome.kind === 'ok' ? 0 : 1);
}

const timeMs = Number(args.time ?? DEFAULT_TIME_S) * 1000;
const findings = [];

process.stdout.write(
  `flecto fuzz — seed ${seed}, ${selected.length} target${selected.length === 1 ? '' : 's'}, `
  + `${timeMs / 1000}s each, ${budgetMs()}ms per case\n\n`,
);

for (const target of selected) {
  const finding = await fuzzTarget(target, seed, timeMs);
  if (finding) findings.push(finding);
}

process.stdout.write('\n');
if (findings.length === 0) {
  process.stdout.write(`No findings. Replay this run with: npm run fuzz -- --seed ${seed}\n`);
  process.exit(0);
}

process.stdout.write(`${findings.length} finding${findings.length === 1 ? '' : 's'}:\n\n`);
for (const finding of findings) {
  process.stdout.write(`  ${finding.target} — ${finding.summary}\n`);
  process.stdout.write(`    reproduce: npm run fuzz -- --target ${finding.target} --seed ${seed} --case ${finding.index}\n`);
  process.stdout.write(`    replay:    npm run fuzz -- --replay ${rel(finding.file)}\n`);
}
process.stdout.write(
  '\nNext: move the input into test/fixtures/fuzz/ so test/fuzz-regressions.test.js\n'
  + 'replays it in the normal suite, then fix it. If it turns out to be exploitable\n'
  + 'rather than merely a hang, report it privately per SECURITY.md — not as a public issue.\n',
);
process.exit(1);

// ---------------------------------------------------------------------------

/**
 * Fuzz one target until its time is up or something breaks.
 *
 * Cases run in chunks in a child process. The driver watches the heartbeat
 * rather than the clock of any single case, so "stopped making progress" and
 * "still working" are distinguishable without the child cooperating.
 * @param {(typeof TARGETS)[number]} target
 * @param {number} seedValue
 * @param {number} budget total wall-clock for this target, in ms
 * @returns {Promise<null | { target: string, index: number, summary: string, file: string }>}
 */
async function fuzzTarget(target, seedValue, budget) {
  const deadline = Date.now() + budget;
  let index = 0;
  let cases = 0;
  const startedAt = Date.now();

  while (Date.now() < deadline) {
    const result = await runChunk(target.id, seedValue, index, CHUNK, budgetMs());
    cases += result.cases;

    if (result.kind === 'ok') {
      index += CHUNK;
      continue;
    }

    const failingIndex = result.index ?? index;
    const summary = result.kind === 'hang'
      ? `hung on case ${failingIndex} (no progress for ${budgetMs()}ms)`
      : `${result.message} (case ${failingIndex})`;
    process.stdout.write(`  ${pad(target.id)} ${cases} cases — FAILED: ${summary}\n`);

    const original = result.input ?? regenerate(target, seedValue, failingIndex);
    const file = shrinkAndSave(target.id, seedValue, failingIndex, original, result.kind);
    return { target: target.id, index: failingIndex, summary, file };
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stdout.write(`  ${pad(target.id)} ${cases} cases in ${elapsed}s — clean\n`);
  return null;
}

/**
 * Run one chunk of cases in a child process, enforcing the per-case budget from
 * out here where a hang is still observable.
 * @param {string} targetId
 * @param {number} seedValue
 * @param {number} start
 * @param {number} count
 * @param {number} perCaseMs
 * @returns {Promise<{ kind: 'ok' | 'hang' | 'violation' | 'harness-error', cases: number, index?: number, message?: string, input?: unknown }>}
 */
function runChunk(targetId, seedValue, start, count, perCaseMs) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [
      WORKER,
      '--target', targetId,
      '--seed', String(seedValue),
      '--start', String(start),
      '--count', String(count),
    ], { stdio: ['ignore', 'pipe', 'inherit'] });

    let buffer = '';
    let lastIndex = start;
    let cases = 0;
    /** @type {{ kind: string, index?: number, message?: string, input?: unknown } | null} */
    let failure = null;
    let timer = null;

    const arm = () => {
      if (timer) clearTimeout(timer);
      // The budget is per case, not per chunk: the heartbeat resets it, so a
      // fast target runs thousands of cases inside one timer's lifetime and a
      // stalled one is caught within a single budget of stalling.
      timer = setTimeout(() => {
        failure = { kind: 'hang', index: lastIndex };
        child.kill('SIGKILL');
      }, perCaseMs + 1000);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.kind === 'case') {
          lastIndex = record.index;
          cases += 1;
          arm();
        } else if (record.kind === 'violation' || record.kind === 'harness-error') {
          failure = record;
        }
      }
    });

    arm();
    child.on('close', () => {
      if (timer) clearTimeout(timer);
      if (!failure) return done({ kind: 'ok', cases });
      done({
        kind: /** @type {any} */ (failure.kind),
        cases,
        index: failure.index,
        message: failure.message,
        input: failure.input,
      });
    });
  });
}

/**
 * Shrink a failing input and write it where a human can pick it up.
 *
 * Every candidate is verified in a child process rather than in-process, so a
 * candidate that hangs shrinks like any other failure instead of taking the
 * driver down with it.
 * @param {string} targetId
 * @param {number} seedValue
 * @param {number} index
 * @param {unknown} input
 * @param {string} kind
 * @returns {string} path the minimized input was written to
 */
function shrinkAndSave(targetId, seedValue, index, input, kind) {
  mkdirSync(FINDINGS_DIR, { recursive: true });
  const scratch = join(FINDINGS_DIR, `.${targetId}-candidate.json`);
  const perCase = budgetMs();

  const stillFails = (candidate) => {
    writeInput(scratch, candidate);
    return runCandidate(targetId, scratch, perCase).kind !== 'ok';
  };

  let best = input;
  if (stillFails(best)) {
    let attempts = 0;
    let improved = true;
    while (improved && attempts < SHRINK_ATTEMPTS) {
      improved = false;
      for (const candidate of shrinkCandidates(best)) {
        if (attempts >= SHRINK_ATTEMPTS) break;
        attempts += 1;
        if (!stillFails(candidate)) continue;
        best = candidate;
        improved = true;
        break;
      }
    }
    process.stdout.write(`    shrunk in ${attempts} attempts\n`);
  } else {
    // Order-dependent or environment-dependent: keep the original and say so,
    // rather than shipping a fixture that does not reproduce.
    process.stdout.write('    could not reproduce in isolation — saving the original input unshrunk\n');
  }

  const file = join(FINDINGS_DIR, `${targetId}-${seedValue}-${index}.json`);
  writeInput(file, {
    target: targetId,
    kind,
    seed: seedValue,
    case: index,
    foundAt: new Date().toISOString(),
    input: best,
  });
  return file;
}

/**
 * Smaller inputs that might still fail, cheapest first. Deliberately simple:
 * drop a key, drop an element, halve a string, blank a value. Structured input
 * shrinks well under exactly these moves, and a clever shrinker that produces
 * an input the generator could never have made is a worse fixture.
 * @param {unknown} value
 * @returns {Generator<unknown>}
 */
function* shrinkCandidates(value) {
  if (Array.isArray(value)) {
    if (value.length > 1) yield value.slice(0, Math.floor(value.length / 2));
    for (let i = 0; i < value.length; i += 1) {
      yield [...value.slice(0, i), ...value.slice(i + 1)];
    }
    for (let i = 0; i < value.length; i += 1) {
      for (const smaller of shrinkCandidates(value[i])) {
        yield [...value.slice(0, i), smaller, ...value.slice(i + 1)];
      }
    }
    return;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    for (const [dropped] of entries) {
      yield Object.fromEntries(entries.filter(([name]) => name !== dropped));
    }
    for (const [name, child] of entries) {
      for (const smaller of shrinkCandidates(child)) {
        yield { ...value, [name]: smaller };
      }
    }
    return;
  }

  if (typeof value === 'string' && value.length > 0) {
    yield value.slice(0, Math.floor(value.length / 2));
    yield value.slice(Math.ceil(value.length / 2));
    if (value.length > 1) yield value.slice(0, value.length - 1);
    yield '';
    return;
  }

  if (typeof value === 'number' && value !== 0) yield 0;
}

/**
 * @param {string} targetId
 * @param {string} inputFile
 * @param {number} perCaseMs
 * @returns {{ kind: 'ok' | 'violation' | 'harness-error' | 'hang', message?: string }}
 */
function runCandidate(targetId, inputFile, perCaseMs) {
  const result = spawnSync(
    process.execPath,
    [CHECKER, '--target', targetId, '--input', inputFile],
    { encoding: 'utf8', timeout: perCaseMs + 2000, killSignal: 'SIGKILL' },
  );
  if (result.signal === 'SIGKILL' || result.error?.code === 'ETIMEDOUT') return { kind: 'hang' };
  if (result.status === 0) return { kind: 'ok' };
  if (result.status === 3) return { kind: 'violation', message: (result.stderr ?? '').trim() };
  return { kind: 'harness-error', message: (result.stderr ?? '').trim() };
}

/**
 * @param {(typeof TARGETS)[number]} target
 * @param {number} seedValue
 * @param {number} index
 * @returns {unknown}
 */
function regenerate(target, seedValue, index) {
  return JSON.parse(JSON.stringify(target.generate(makeRng(caseSeed(seedValue, target.id, index)))));
}

/**
 * @param {string} path
 * @param {unknown} value
 * @returns {string}
 */
function writeInput(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * @param {string} spec
 * @returns {(typeof TARGETS)[number][]}
 */
function selectTargets(spec) {
  if (spec === 'all' || spec === 'true') return TARGETS;
  const ids = spec.split(',').map((id) => id.trim()).filter(Boolean);
  return ids.map((id) => TARGETS_BY_ID.get(id)).filter(Boolean);
}

/** @returns {number} */
function budgetMs() {
  return Number(args.budget ?? CASE_BUDGET_MS);
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function guessTargetFromFilename(file) {
  const base = file.split(/[\\/]/).pop() ?? '';
  for (const target of TARGETS) {
    if (base.startsWith(`${target.id}-`)) return target.id;
  }
  return null;
}

/**
 * @param {{ kind: string, message?: string }} outcome
 * @returns {string}
 */
function describeOutcome(outcome) {
  if (outcome.kind === 'ok') return 'invariant held';
  if (outcome.kind === 'hang') return `HUNG — no result within ${budgetMs()}ms`;
  return `FAILED — ${outcome.message || outcome.kind}`;
}

/**
 * @param {string} path
 * @returns {string}
 */
function rel(path) {
  const relative_ = relative(resolve(HERE, '..', '..'), path);
  return relative_.split('\\').join('/');
}

/**
 * @param {string} text
 * @returns {string}
 */
function pad(text) {
  return text.padEnd(16);
}

function printUsage() {
  process.stdout.write(`flecto fuzz — the parser, differ, and regex surface an untrusted PR controls

  npm run fuzz                                    every target, ${DEFAULT_TIME_S}s each
  npm run fuzz -- --target parse-yaml --time 120  one target, longer
  npm run fuzz -- --seed 12345                    replay a whole run
  npm run fuzz -- --target diff-trees --seed 1 --case 42
                                                  replay one case
  npm run fuzz -- --replay ${rel(join(FIXTURES_DIR, 'parse-yaml-example.json'))}
                                                  replay a saved input
  npm run fuzz -- --list                          what the targets are

Options:
  --target <ids>   comma-separated target ids, or "all" (default: all)
  --seed <n>       uint32 seed (default: random, printed so you can replay it)
  --time <s>       wall-clock seconds per target (default: ${DEFAULT_TIME_S})
  --budget <ms>    per-case time budget (default: ${CASE_BUDGET_MS})
  --case <n>       run exactly one case of one target
  --replay <file>  run one saved input
  --list           list targets

Findings are written to ${rel(FINDINGS_DIR)}/ and are not committed. Move one into
${rel(FIXTURES_DIR)}/ to turn it into a permanent regression test.
`);
}
