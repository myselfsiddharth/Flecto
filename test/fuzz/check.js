/**
 * Run one target against one input read from a file, and exit with what
 * happened. Used for two things: shrinking a finding (the driver spawns this
 * once per candidate, so a candidate that hangs is killable), and replaying a
 * checked-in fixture from the command line.
 *
 * Exit codes: 0 the invariant held, 3 the invariant broke, 2 the harness broke.
 * Killed by the driver means it hung, which no exit code can report.
 *
 * Not usually run directly — `node test/fuzz/run.js --replay <file>` wraps it.
 */

import { readFileSync } from 'fs';

import { TARGETS_BY_ID, FuzzViolation } from './targets.js';

const argv = process.argv.slice(2);
/** @type {Record<string, string>} */
const args = {};
for (let i = 0; i < argv.length; i += 1) {
  if (!argv[i].startsWith('--')) continue;
  args[argv[i].slice(2)] = argv[i + 1] ?? '';
  i += 1;
}

const target = TARGETS_BY_ID.get(args.target);
if (!target) {
  process.stderr.write(`Unknown fuzz target "${args.target}"\n`);
  process.exit(2);
}

let input;
try {
  input = JSON.parse(readFileSync(args.input, 'utf8'));
} catch (err) {
  process.stderr.write(`Cannot read input "${args.input}": ${err.message}\n`);
  process.exit(2);
}

// A fixture file carries its own provenance alongside the input, so the input
// itself is unwrapped when it is there.
const value = input && typeof input === 'object' && 'input' in input ? input.input : input;

const ctx = target.setup ? target.setup() : {};
try {
  target.run(value, ctx);
  process.exit(0);
} catch (err) {
  process.stderr.write(`${err?.message ?? String(err)}\n`);
  process.exit(err instanceof FuzzViolation ? 3 : 2);
} finally {
  if (target.teardown) {
    try {
      target.teardown(ctx);
    } catch {
      // Cleanup failure is not a finding.
    }
  }
}
