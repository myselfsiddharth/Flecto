import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { testPolicyFixture } from '../src/policy-test.js';

/**
 * Findings as a comparable set. `testPolicyFixture` already asserts the fixture's
 * own `expected` list, so these assertions exist to pin the cases a reviewer
 * would look for by name -- and to keep them from being silently weakened by an
 * edit to the fixture JSON alone.
 * @param {{ findings: Array<{ id: string, severity: string, path: string }> }} result
 * @returns {string[]}
 */
function summarize(result) {
  return result.findings.map(({ id, severity, path }) => `${severity} ${id} ${path}`).sort();
}

test('github-actions fixture covers changed workflow trust boundaries', async () => {
  const result = await testPolicyFixture(resolve('examples/fixtures/policies/github-actions'));

  assert.equal(result.findings.length, 11);
  assert.deepEqual(summarize(result), [
    'error github-actions-permissions-write-all permissions',
    'error github-actions-pull-request-head-checkout jobs.deploy.steps[0].with.ref',
    'error github-actions-pull-request-head-checkout jobs.test.steps[0].with.ref',
    'error github-actions-pull-request-target on.pull_request_target',
    'error github-actions-secrets-in-run jobs.test.steps[1].run',
    'error github-actions-self-hosted-runner jobs.deploy.runs-on[0]',
    'error github-actions-self-hosted-runner jobs.test.runs-on',
    'error github-actions-unpinned-action jobs.deploy.steps[0].uses',
    'error github-actions-unpinned-action jobs.test.steps[0].uses',
    'warn github-actions-schedule-exposed on.schedule',
    'warn github-actions-workflow-dispatch-exposed on.workflow_dispatch',
  ]);
});

test('pull-request head checkout matches the wrapped expression real workflows use', async () => {
  // The rule originally compared against the unwrapped string, so the form
  // every production workflow actually writes -- `${{ ... }}` -- produced no
  // finding, and the fixture green-lit it by using the bare value too.
  const result = await testPolicyFixture(resolve('examples/fixtures/policies/github-actions'));
  const paths = result.findings
    .filter((finding) => finding.id === 'github-actions-pull-request-head-checkout')
    .map((finding) => finding.path)
    .sort();

  // jobs.test uses `${{ github.event.pull_request.head.sha }}`; jobs.deploy the bare form.
  assert.deepEqual(paths, ['jobs.deploy.steps[0].with.ref', 'jobs.test.steps[0].with.ref']);
});

test('unpinned actions are reported on a newly added step, not only a changed one', async () => {
  // With `expandSubtrees`, a step introduced with its job arrives as an `added`
  // leaf at `....uses`. Matching only `changed` missed every brand-new step.
  const result = await testPolicyFixture(resolve('examples/fixtures/policies/github-actions'));
  const finding = result.findings.find((item) => item.path === 'jobs.deploy.steps[0].uses');

  assert.equal(finding?.id, 'github-actions-unpinned-action');
  assert.equal(finding.severity, 'error');
});

test('self-hosted runners are reported when runs-on is a list', async () => {
  // `runs-on: [self-hosted, linux]` is diffed element by element, so the label
  // lands at `runs-on[0]` rather than at `runs-on`.
  const result = await testPolicyFixture(resolve('examples/fixtures/policies/github-actions'));
  const paths = result.findings
    .filter((finding) => finding.id === 'github-actions-self-hosted-runner')
    .map((finding) => finding.path)
    .sort();

  assert.deepEqual(paths, ['jobs.deploy.runs-on[0]', 'jobs.test.runs-on']);
});

test('a removed permissions block and a reusable-workflow trigger are reported', async () => {
  const result = await testPolicyFixture(
    resolve('examples/fixtures/policies/github-actions-permissions-removed'),
  );

  assert.equal(result.findings.length, 2);
  assert.deepEqual(summarize(result), [
    'error github-actions-permissions-removed permissions',
    'warn github-actions-workflow-call-exposed on.workflow_call',
  ]);
});

test('a permissions block removal reports once, not once per dropped scope', async () => {
  // Subtree expansion emits a `removed` leaf for every scope in the block. The
  // rule is anchored with `pathEquals`, so the reviewer sees one finding.
  const result = await testPolicyFixture(
    resolve('examples/fixtures/policies/github-actions-permissions-removed'),
  );
  const removals = result.findings.filter((finding) => finding.id === 'github-actions-permissions-removed');

  assert.equal(removals.length, 1);
  assert.equal(removals[0].path, 'permissions');
});

test('a single scope widened to write is reported without flagging the untouched scopes', async () => {
  const result = await testPolicyFixture(
    resolve('examples/fixtures/policies/github-actions-permission-scope'),
  );

  assert.equal(result.findings.length, 2);
  assert.deepEqual(summarize(result), [
    'error github-actions-self-hosted-runner jobs.publish.runs-on[0]',
    'warn github-actions-permission-write-scope permissions.packages',
  ]);
});

test('non-triggering workflow changes produce no findings', async () => {
  // The cases that matter most for a security pack: a pack that cannot stay
  // quiet gets suppressed wholesale. Each change here is a near miss for a
  // rule -- see the fixture README for the change-to-rule mapping.
  const result = await testPolicyFixture(resolve('examples/fixtures/policies/github-actions-benign'));

  assert.deepEqual(result.findings, []);
  // The fixture must actually exercise the pack, or it proves nothing.
  assert.ok(result.changes.length > 0, 'benign fixture must still produce change events');
});
