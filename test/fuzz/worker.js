/**
 * The fuzz worker: runs a contiguous range of cases for one target and streams
 * what it is doing on stdout as NDJSON.
 *
 * It runs in a child process, and that is the point. The invariant most of these
 * targets are checking is "it terminates", and a hang cannot be observed from
 * inside the process that hung — a timer never fires, a promise never settles.
 * So the parent watches the heartbeat this writes *before* each case and kills
 * the child when it stops arriving. The kill is a real signal to a real process,
 * which is why this is not a worker thread: `worker.terminate()` depends on V8
 * reaching an interrupt check, and a backtracking regex is exactly the case
 * where that guarantee gets thin.
 *
 * Not run directly. `node test/fuzz/run.js` drives it.
 */

import { writeSync } from 'fs';

import { makeRng, caseSeed } from './rng.js';
import { TARGETS_BY_ID, FuzzViolation } from './targets.js';

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) {
      args[arg.slice(2)] = argv[i + 1] ?? '';
      i += 1;
    } else {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return args;
}

/**
 * One NDJSON line, written straight to fd 1.
 *
 * `process.stdout.write` is **asynchronous when stdout is a pipe**, which is
 * exactly what it is here — so a heartbeat could still be sitting in the stream's
 * queue when the case it announces blocks the event loop forever, and the parent
 * would then blame the previous case for the hang. `writeSync` puts the bytes on
 * the wire before the case starts, which is the whole contract this depends on.
 *
 * EAGAIN is possible on a non-blocking pipe when the parent has not drained yet;
 * retrying is correct because there is nothing else this process could usefully
 * do with the bytes.
 * @param {Record<string, unknown>} record
 */
function emit(record) {
  const line = `${JSON.stringify(record)}\n`;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    try {
      writeSync(1, line);
      return;
    } catch (err) {
      // EPIPE means the parent gave up on us; there is nothing left to say.
      if (err?.code !== 'EAGAIN') return;
    }
  }
}

const args = parseArgs(process.argv.slice(2));
const targetId = args.target;
const target = TARGETS_BY_ID.get(targetId);
if (!target) {
  emit({ kind: 'error', message: `Unknown fuzz target "${targetId}"` });
  process.exit(2);
}

const seed = Number(args.seed);
const start = Number(args.start ?? 0);
const count = Number(args.count ?? 1);

const ctx = target.setup ? target.setup() : {};
let failed = false;

try {
  for (let index = start; index < start + count; index += 1) {
    // Written before the case, so a case that never returns still names itself.
    emit({ kind: 'case', index });

    let input;
    try {
      input = target.generate(makeRng(caseSeed(seed, targetId, index)));
    } catch (err) {
      emit({
        kind: 'harness-error',
        index,
        message: `generator threw: ${err?.message ?? String(err)}`,
      });
      failed = true;
      break;
    }

    try {
      target.run(input, ctx);
    } catch (err) {
      failed = true;
      emit({
        kind: err instanceof FuzzViolation ? 'violation' : 'harness-error',
        index,
        message: String(err?.message ?? err),
        detail: err instanceof FuzzViolation ? err.detail : undefined,
        stack: err instanceof FuzzViolation ? undefined : String(err?.stack ?? ''),
        input: serializeInput(input),
      });
      break;
    }
  }
} finally {
  if (target.teardown) {
    try {
      target.teardown(ctx);
    } catch {
      // A temp directory that will not delete is not a fuzz finding.
    }
  }
}

emit({ kind: 'done', failed });
process.exit(failed ? 1 : 0);

/**
 * Inputs are generated to be JSON-serializable so a failing one can be checked
 * in as a fixture. A generator that produces something JSON cannot hold is a
 * harness bug, and saying so beats writing `undefined` into the corpus.
 * @param {unknown} input
 * @returns {unknown}
 */
function serializeInput(input) {
  try {
    return JSON.parse(JSON.stringify(input));
  } catch (err) {
    return { __unserializable: String(err?.message ?? err) };
  }
}
