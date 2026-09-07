/**
 * The fuzz driver's decision about *which* failures it is entitled to believe.
 *
 * Fuzzing runs nightly on a shared runner, and three of six consecutive nightly
 * runs went red on a single case out of hundreds of thousands that missed a
 * wall-clock deadline and then would not do it again. A gate that cries wolf on
 * half its runs stops being read, which costs more than the findings it was
 * built to surface — so a timing failure now has to reproduce in isolation
 * before it fails the run, while a behavioural failure still fails on sight.
 *
 * What is tested here is that split. The confirmation loop itself is ordinary
 * control flow; the part that can quietly rot is the classification, because it
 * matches on the text of a thrown message.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isTimingFailure, budgetExceededMessage, CASE_BUDGET_MS } from './fuzz/targets.js';

test('a hang is a timing failure — the watchdog only ever measures time', () => {
  assert.equal(isTimingFailure('hang'), true);
  assert.equal(isTimingFailure('hang', undefined), true);
  assert.equal(isTimingFailure('hang', 'anything at all'), true);
});

test('a real budget-exceeded message classifies as timing', () => {
  // Built by the same function `assertWithinBudget` throws with, so rewording
  // the throw cannot leave this passing against a message that no longer exists.
  const message = budgetExceededMessage('secret-scan', CASE_BUDGET_MS + 430);
  assert.equal(isTimingFailure('violation', message), true);
});

test('the message builder produces what the classifier expects, at any budget', () => {
  for (const [where, elapsed, budget] of [
    ['diff-trees', 2430, 2000],
    ['pack-eval', 10, 1],
    ['parse-yaml', 999999, 500],
  ]) {
    const message = budgetExceededMessage(String(where), Number(elapsed), Number(budget));
    assert.match(message, /took \d+ms, over the \d+ms budget/);
    assert.equal(isTimingFailure('violation', message), true);
  }
});

test('behavioural violations are not timing failures and still fail on sight', () => {
  // These are properties of the input, not of the machine: they reproduce, so
  // they must never be routed through the "unconfirmed, do not fail" path.
  for (const message of [
    'parse-yaml returned a prototype-polluted object',
    'diff-trees threw a non-Error',
    'pack-eval threw an Error with a non-string message',
    'secret-scan exhausted memory',
  ]) {
    assert.equal(isTimingFailure('violation', message), false, message);
  }
});

test('a harness error is never a timing failure', () => {
  // The harness breaking is a bug in the fuzzer, and retrying it five times
  // would only hide it.
  assert.equal(isTimingFailure('harness-error', 'Cannot find module'), false);
  assert.equal(isTimingFailure('harness-error', budgetExceededMessage('x', 3000)), false);
});

test('ok is not a failure of any kind', () => {
  assert.equal(isTimingFailure('ok'), false);
  assert.equal(isTimingFailure('ok', budgetExceededMessage('x', 3000)), false);
});

test('a violation with no message is not assumed to be timing', () => {
  // Absence of evidence is not evidence of a stalled runner: an unexplained
  // violation should fail the run rather than be retried away.
  assert.equal(isTimingFailure('violation'), false);
  assert.equal(isTimingFailure('violation', ''), false);
});
