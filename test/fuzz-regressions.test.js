/**
 * Replays every input in `test/fixtures/fuzz/` through the fuzz target that
 * found it.
 *
 * This is the half of #150 that keeps a finding fixed. Fuzzing is scheduled and
 * probabilistic: it will not rediscover a regression on the pull request that
 * reintroduces it, and by the time the nightly run notices, the change is
 * merged. So the fuzzer's job ends at *finding* an input; this file's job is
 * that the input runs on every commit, forever, in the ordinary suite.
 *
 * Adding one is two steps: `npm run fuzz` writes the minimized input to
 * `test/fuzz/findings/`, and moving that file into `test/fixtures/fuzz/` is the
 * whole of "turn it into a regression test". No code is written here per
 * finding — the fixture names its own target.
 *
 * The corpus is seeded with the vectors from the security review record, which
 * are fixed: they must keep passing, and a fixture that starts failing means the
 * fix regressed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { TARGETS_BY_ID, CASE_BUDGET_MS } from './fuzz/targets.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fuzz');

const files = readdirSync(FIXTURES).filter((name) => name.endsWith('.json')).sort();

test('the fuzz corpus is not empty', () => {
  // A corpus that quietly emptied would make every test below vacuous.
  assert.ok(files.length > 0, `no fixtures in ${FIXTURES}`);
});

for (const name of files) {
  test(`fuzz regression: ${name}`, () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
    const target = TARGETS_BY_ID.get(fixture.target);
    assert.ok(
      target,
      `${name} names target "${fixture.target}", which does not exist. `
      + 'Rename the target in the fixture, or restore it in test/fuzz/targets.js.',
    );

    const ctx = target.setup ? target.setup() : {};
    const startedAt = Date.now();
    try {
      // `run` throws FuzzViolation when the invariant breaks — including its own
      // per-case time budget, so a fixture that starts hanging fails here rather
      // than stalling the suite up to the runner's timeout.
      target.run(fixture.input, ctx);
    } finally {
      if (target.teardown) target.teardown(ctx);
    }

    assert.ok(
      Date.now() - startedAt < CASE_BUDGET_MS * 3,
      `${name} took longer than the fuzz budget allows`,
    );
  });
}
