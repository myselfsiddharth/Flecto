import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { testPolicyFixture } from '../src/policy-test.js';

test('github-actions policy fixture covers changed workflow trust boundaries', async () => {
  const result = await testPolicyFixture(resolve('examples/fixtures/policies/github-actions'));

  assert.equal(result.findings.length, 8);
  assert.deepEqual(
    result.findings.map(({ id, severity, path }) => ({ id, severity, path })),
    [
      { id: 'github-actions-pull-request-target', severity: 'error', path: 'on.pull_request_target' },
      { id: 'github-actions-schedule-exposed', severity: 'warn', path: 'on.schedule' },
      { id: 'github-actions-workflow-dispatch-exposed', severity: 'warn', path: 'on.workflow_dispatch' },
      { id: 'github-actions-permissions-write-all', severity: 'error', path: 'permissions' },
      { id: 'github-actions-self-hosted-runner', severity: 'error', path: 'jobs.test.runs-on' },
      { id: 'github-actions-unpinned-action', severity: 'error', path: 'jobs.test.steps[0].uses' },
      { id: 'github-actions-pull-request-head-checkout', severity: 'error', path: 'jobs.test.steps[0].with.ref' },
      { id: 'github-actions-secrets-in-run', severity: 'error', path: 'jobs.test.steps[1].run' },
    ],
  );
});
