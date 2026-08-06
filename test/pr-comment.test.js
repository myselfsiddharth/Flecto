import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PR_COMMENT_MARKER,
  deliverPrComment,
  renderPrComment,
  resolvePrCommentContext,
  upsertPrComment,
} from '../src/pr-comment.js';

/**
 * Build a CI result shaped like the ones `flecto ci` collects.
 * @param {string} file
 * @param {import('../src/differ.js').ChangeEvent[]} changes
 * @param {import('../src/policy.js').PolicyFinding[]} [policies]
 */
function result(file, changes, policies = []) {
  return { file, envelope: { file, changes, policies }, policies };
}

/**
 * Fake Response with just the surface `pr-comment.js` uses.
 * @param {number} status
 * @param {unknown} body
 */
function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/**
 * A fetch stub that records every call. No test in this file touches the network.
 * @param {(url: string, init: Record<string, any>) => unknown} handler
 */
function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

const CONTEXT = {
  repo: 'acme/widgets',
  prNumber: 42,
  token: 'tok-super-secret',
  apiUrl: 'https://api.github.com',
};

/** Rows of a markdown table, excluding the header and separator rows. */
function tableRows(markdown) {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|[\s-]*\|[\s|-]*$/u.test(line));
}

test('renderPrComment starts with the sticky marker', () => {
  const body = renderPrComment([]);
  assert.equal(body.split('\n')[0], PR_COMMENT_MARKER);
  assert.equal(body.indexOf(PR_COMMENT_MARKER), 0);
  assert.equal(PR_COMMENT_MARKER, '<!-- flecto:pr-comment -->');
});

test('renderPrComment stays readable with zero changes', () => {
  const body = renderPrComment([result('/repo/config/prod.yaml', [])], {
    cwd: '/repo',
    failed: false,
  });

  assert.match(body, /## Flecto — config change report/u);
  assert.match(body, /✅ \*\*Check passing\*\* — no semantic changes in 1 file\./u);
  assert.match(body, /\*\*Policy:\*\* no findings\./u);
  assert.doesNotMatch(body, /### Changes/u);
  assert.doesNotMatch(body, /### Policy findings/u);
});

test('renderPrComment reports an empty run when nothing was diffed', () => {
  const body = renderPrComment([], { failed: false });
  assert.match(body, /no files were diffed\./u);
});

test('renderPrComment summarizes changes without findings', () => {
  const body = renderPrComment([
    result('/repo/config/prod.yaml', [
      { type: 'changed', path: 'database.pool_size', before: 5, after: 20 },
      { type: 'added', path: 'logging.level', after: 'debug' },
    ]),
    result('/repo/config/staging.yaml', [
      { type: 'removed', path: 'cache.ttl', before: 60 },
    ]),
  ], { cwd: '/repo', failed: true });

  assert.match(body, /❌ \*\*Check failing\*\* — 3 changes in 2 files — 1 changed, 1 added, 1 removed\./u);
  assert.match(body, /\*\*Policy:\*\* no findings\./u);
  assert.doesNotMatch(body, /### Policy findings/u);
  assert.match(body, /### Changes/u);
  assert.match(body, /\*\*`config\/prod\.yaml`\*\* — 2 changes/u);
  assert.match(body, /\*\*`config\/staging\.yaml`\*\* — 1 change/u);
  assert.match(body, /\| changed \| `database\.pool_size` \| `5` \| `20` \|/u);
  // An added key has no "before" side, and a removed key has no "after" side.
  assert.match(body, /\| added \| `logging\.level` \| — \| `"debug"` \|/u);
  assert.match(body, /\| removed \| `cache\.ttl` \| `60` \| — \|/u);
});

test('renderPrComment omits the status prefix when the outcome is unknown', () => {
  const body = renderPrComment([result('/repo/a.json', [])], { cwd: '/repo' });
  assert.doesNotMatch(body, /Check (failing|passing)/u);
  assert.match(body, /^no semantic changes in 1 file\.$/mu);
});

test('renderPrComment groups findings by severity with file and path', () => {
  const body = renderPrComment([
    result('/repo/config/prod.yaml', [], [
      { id: 'dangerous-toggle-enabled', severity: 'error', path: 'logging.debug', message: 'Dangerous toggle enabled.', pack: 'default' },
      { id: 'pool-size-jump', severity: 'warn', path: 'database.pool_size', message: 'Pool size increased.', pack: 'default' },
      { id: 'note-rule', severity: 'info', path: 'meta.owner', message: 'Ownership changed.' },
    ]),
  ], { cwd: '/repo', failed: true });

  assert.match(body, /\*\*Policy:\*\* 1 error, 1 warning, 1 notice\./u);
  assert.match(body, /#### Errors \(1\)/u);
  assert.match(body, /#### Warnings \(1\)/u);
  assert.match(body, /#### Notices \(1\)/u);
  assert.match(body, /\| `config\/prod\.yaml` \| `logging\.debug` \| `dangerous-toggle-enabled` \(`default`\) \| Dangerous toggle enabled\. \|/u);
  assert.match(body, /\| `config\/prod\.yaml` \| `database\.pool_size` \| `pool-size-jump` \(`default`\) \| Pool size increased\. \|/u);
  // A finding without a pack shows the bare rule id.
  assert.match(body, /\| `config\/prod\.yaml` \| `meta\.owner` \| `note-rule` \| Ownership changed\. \|/u);

  // Errors come before warnings, which come before notices.
  assert.ok(body.indexOf('#### Errors') < body.indexOf('#### Warnings'));
  assert.ok(body.indexOf('#### Warnings') < body.indexOf('#### Notices'));
});

test('renderPrComment pluralizes finding counts', () => {
  const body = renderPrComment([
    result('/repo/a.json', [], [
      { id: 'r1', severity: 'error', path: 'a', message: 'one' },
      { id: 'r2', severity: 'error', path: 'b', message: 'two' },
    ]),
  ], { cwd: '/repo' });

  assert.match(body, /\*\*Policy:\*\* 2 errors\./u);
  assert.doesNotMatch(body, /warning/u);
});

test('renderPrComment escapes pipes and backticks so tables survive', () => {
  const body = renderPrComment([
    result('/repo/con|fig.yaml', [
      { type: 'changed', path: 'command|args', before: 'a`b', after: 'x|y' },
    ], [
      { id: 'pipe|rule', severity: 'error', path: 'command|args', message: 'Uses a | pipe.\nSecond line.', pack: 'pa|ck' },
    ]),
  ], { cwd: '/repo' });

  // Every pipe that is part of content is escaped, so each row keeps 4 columns.
  for (const row of tableRows(body)) {
    const columns = row.replaceAll('\\|', '').split('|').length - 2;
    assert.equal(columns, 4, `row has ${columns} columns: ${row}`);
  }
  assert.match(body, /`command\\\|args`/u);
  // A backtick in the value widens the code fence instead of ending it early.
  assert.ok(body.includes('``"a`b"``'), body);
  // A newline in a message would otherwise end the table row early.
  assert.match(body, /Uses a \\\| pipe\. Second line\./u);
  assert.equal(tableRows(body).filter((row) => row.includes('pipe\\|rule')).length, 1);
});

test('renderPrComment quotes a path that is entirely backticks', () => {
  const body = renderPrComment([
    result('/repo/a.json', [{ type: 'added', path: '`', after: 1 }]),
  ], { cwd: '/repo' });

  // Padding spaces keep the code span parseable when content touches the fence.
  assert.match(body, /`` ` ``/u);
});

test('renderPrComment collapses long change lists into a details block', () => {
  const many = Array.from({ length: 11 }, (_, i) => ({
    type: 'changed', path: `a.b${i}`, before: i, after: i + 1,
  }));
  const collapsed = renderPrComment([result('/repo/a.json', many)], { cwd: '/repo' });

  assert.match(collapsed, /<details>\n<summary>Show all 11 changes<\/summary>/u);
  assert.match(collapsed, /<\/details>/u);
  assert.ok(collapsed.indexOf('<details>') < collapsed.indexOf('| changed | `a.b0` |'));
  assert.ok(collapsed.indexOf('| changed | `a.b10` |') < collapsed.indexOf('</details>'));

  const short = renderPrComment([result('/repo/a.json', many.slice(0, 10))], { cwd: '/repo' });
  assert.doesNotMatch(short, /<details>/u);
  assert.match(short, /\| changed \| `a\.b0` \|/u);
});

test('renderPrComment truncates a body that exceeds the comment size limit', () => {
  const many = Array.from({ length: 4000 }, (_, i) => ({
    type: 'changed', path: `service.replicas.${i}`, before: i, after: i + 1,
  }));
  const body = renderPrComment([result('/repo/a.json', many)], { cwd: '/repo' });

  assert.ok(body.length <= 60_000, `body was ${body.length} chars`);
  assert.match(body, /_Report truncated to fit GitHub's comment size limit\._/u);
  assert.equal(body.split('\n')[0], PR_COMMENT_MARKER);
});

test('renderPrComment truncates very long values instead of dumping them', () => {
  const body = renderPrComment([
    result('/repo/a.json', [{ type: 'added', path: 'blob', after: 'x'.repeat(500) }]),
  ], { cwd: '/repo' });

  assert.match(body, /…/u);
  assert.ok(!body.includes('x'.repeat(200)));
});

test('renderPrComment keeps absolute paths that fall outside the working directory', () => {
  const body = renderPrComment([result('/elsewhere/config.yaml', [])], { cwd: '/repo' });
  assert.match(body, /No files? were diffed|no semantic changes/u);

  const withChange = renderPrComment([
    result('/elsewhere/config.yaml', [{ type: 'added', path: 'a', after: 1 }]),
  ], { cwd: '/repo' });
  assert.match(withChange, /`\/elsewhere\/config\.yaml`/u);
});

test('renderPrComment labels a change note', () => {
  const body = renderPrComment([
    result('/repo/a.json', [
      { type: 'changed', path: 'servers[0].port', before: 1, after: 2, note: 'matched by id' },
    ]),
  ], { cwd: '/repo' });

  assert.match(body, /\| changed \(matched by id\) \| `servers\[0\]\.port` \|/u);
});

test('resolvePrCommentContext refuses without GITHUB_TOKEN', () => {
  const resolved = resolvePrCommentContext({
    GITHUB_REPOSITORY: 'acme/widgets',
    GITHUB_REF: 'refs/pull/42/merge',
  });
  assert.deepEqual(resolved, { ok: false, reason: 'GITHUB_TOKEN is not set' });
});

test('resolvePrCommentContext ignores GH_TOKEN from a local gh login', () => {
  const resolved = resolvePrCommentContext({
    GH_TOKEN: 'tok-from-gh-cli',
    GITHUB_REPOSITORY: 'acme/widgets',
    GITHUB_REF: 'refs/pull/42/merge',
  });
  assert.equal(resolved.ok, false);
  assert.match(resolved.reason, /GITHUB_TOKEN/u);
});

test('resolvePrCommentContext refuses without a well-formed GITHUB_REPOSITORY', () => {
  for (const repo of [undefined, '', 'widgets', 'a/b/c']) {
    const resolved = resolvePrCommentContext({
      GITHUB_TOKEN: 'tok',
      GITHUB_REPOSITORY: repo,
      GITHUB_REF: 'refs/pull/42/merge',
    });
    assert.equal(resolved.ok, false);
    assert.match(resolved.reason, /GITHUB_REPOSITORY/u);
  }
});

test('resolvePrCommentContext reads the PR number from GITHUB_REF', () => {
  for (const ref of ['refs/pull/42/merge', 'refs/pull/42/head']) {
    const resolved = resolvePrCommentContext({
      GITHUB_TOKEN: 'tok',
      GITHUB_REPOSITORY: 'acme/widgets',
      GITHUB_REF: ref,
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.context.prNumber, 42);
    assert.equal(resolved.context.repo, 'acme/widgets');
    assert.equal(resolved.context.apiUrl, 'https://api.github.com');
  }
});

test('resolvePrCommentContext refuses a branch push ref', () => {
  const resolved = resolvePrCommentContext({
    GITHUB_TOKEN: 'tok',
    GITHUB_REPOSITORY: 'acme/widgets',
    GITHUB_REF: 'refs/heads/main',
  });
  assert.equal(resolved.ok, false);
  assert.match(resolved.reason, /not a pull request run/u);
});

test('resolvePrCommentContext falls back to the event payload', () => {
  const resolved = resolvePrCommentContext({
    GITHUB_TOKEN: 'tok',
    GITHUB_REPOSITORY: 'acme/widgets',
    GITHUB_REF: 'refs/heads/feature',
    GITHUB_EVENT_PATH: '/github/event.json',
  }, {
    readEventFile: () => JSON.stringify({ pull_request: { number: 7 } }),
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.context.prNumber, 7);
});

test('resolvePrCommentContext accepts an issue event only when it is a PR', () => {
  const env = {
    GITHUB_TOKEN: 'tok',
    GITHUB_REPOSITORY: 'acme/widgets',
    GITHUB_EVENT_PATH: '/github/event.json',
  };

  const pr = resolvePrCommentContext(env, {
    readEventFile: () => JSON.stringify({ issue: { number: 9, pull_request: { url: 'x' } } }),
  });
  assert.equal(pr.ok, true);
  assert.equal(pr.context.prNumber, 9);

  const plainIssue = resolvePrCommentContext(env, {
    readEventFile: () => JSON.stringify({ issue: { number: 9 } }),
  });
  assert.equal(plainIssue.ok, false);
});

test('resolvePrCommentContext survives an unreadable or malformed event file', () => {
  const env = {
    GITHUB_TOKEN: 'tok',
    GITHUB_REPOSITORY: 'acme/widgets',
    GITHUB_EVENT_PATH: '/github/event.json',
  };

  const unreadable = resolvePrCommentContext(env, {
    readEventFile: () => { throw new Error('ENOENT'); },
  });
  assert.equal(unreadable.ok, false);

  const malformed = resolvePrCommentContext(env, { readEventFile: () => 'not json' });
  assert.equal(malformed.ok, false);
});

test('resolvePrCommentContext honors GITHUB_API_URL for GitHub Enterprise', () => {
  const resolved = resolvePrCommentContext({
    GITHUB_TOKEN: 'tok',
    GITHUB_REPOSITORY: 'acme/widgets',
    GITHUB_REF: 'refs/pull/1/merge',
    GITHUB_API_URL: 'https://ghe.example.test/api/v3/',
  });
  assert.equal(resolved.context.apiUrl, 'https://ghe.example.test/api/v3');
});

test('upsertPrComment creates a comment when no sticky comment exists', async () => {
  const { fetchImpl, calls } = recordingFetch((url, init) => {
    if (init.method === 'POST') return response(201, { html_url: 'https://gh.test/c/1' });
    return response(200, [{ id: 5, body: 'unrelated review note' }]);
  });

  const body = renderPrComment([result('/repo/a.json', [])]);
  const outcome = await upsertPrComment(body, CONTEXT, { fetchImpl });

  assert.deepEqual(outcome, { action: 'created', url: 'https://gh.test/c/1' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://api.github.com/repos/acme/widgets/issues/42/comments?per_page=100&page=1');
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].url, 'https://api.github.com/repos/acme/widgets/issues/42/comments');
  assert.deepEqual(calls[1].body, { body });
  assert.equal(calls[1].headers.Authorization, 'Bearer tok-super-secret');
  assert.equal(calls[1].headers.Accept, 'application/vnd.github+json');
});

test('upsertPrComment updates the existing comment found by marker', async () => {
  const { fetchImpl, calls } = recordingFetch((url, init) => {
    if (init.method === 'PATCH') return response(200, { html_url: 'https://gh.test/c/77' });
    return response(200, [
      { id: 5, body: 'unrelated' },
      { id: 77, body: `${PR_COMMENT_MARKER}\n\nstale report`, html_url: 'https://gh.test/c/77' },
      { id: 90, body: 'also unrelated' },
    ]);
  });

  const body = renderPrComment([result('/repo/a.json', [])]);
  const outcome = await upsertPrComment(body, CONTEXT, { fetchImpl });

  assert.equal(outcome.action, 'updated');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].url, 'https://api.github.com/repos/acme/widgets/issues/comments/77');
  assert.deepEqual(calls[1].body, { body });
  // Exactly one sticky comment: nothing is ever created alongside an existing one.
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('upsertPrComment skips the write when the body is unchanged', async () => {
  const body = renderPrComment([result('/repo/a.json', [])]);
  const { fetchImpl, calls } = recordingFetch(() => response(200, [
    { id: 77, body, html_url: 'https://gh.test/c/77' },
  ]));

  const outcome = await upsertPrComment(body, CONTEXT, { fetchImpl });

  assert.deepEqual(outcome, { action: 'unchanged', url: 'https://gh.test/c/77' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
});

test('upsertPrComment pages through comments to find the marker', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `note ${i}` }));
  const { fetchImpl, calls } = recordingFetch((url, init) => {
    if (init.method === 'PATCH') return response(200, { html_url: 'https://gh.test/c/500' });
    if (url.endsWith('&page=1')) return response(200, page1);
    if (url.endsWith('&page=2')) {
      return response(200, [{ id: 500, body: `${PR_COMMENT_MARKER} old`, html_url: 'https://gh.test/c/500' }]);
    }
    return response(200, []);
  });

  const outcome = await upsertPrComment('new body', CONTEXT, { fetchImpl });

  assert.equal(outcome.action, 'updated');
  assert.ok(calls[1].url.includes('page=2'));
  assert.equal(calls[2].url, 'https://api.github.com/repos/acme/widgets/issues/comments/500');
});

test('upsertPrComment stops paging once a short page comes back', async () => {
  const { fetchImpl, calls } = recordingFetch((url, init) => {
    if (init.method === 'POST') return response(201, {});
    return response(200, [{ id: 1, body: 'nothing here' }]);
  });

  await upsertPrComment('body', CONTEXT, { fetchImpl });

  assert.equal(calls.filter((c) => c.method === 'GET').length, 1);
});

test('deliverPrComment does nothing when posting is not enabled', async () => {
  const fetchImpl = () => { throw new Error('network must not be touched'); };

  const outcome = await deliverPrComment('body', {
    enabled: false,
    env: {
      GITHUB_TOKEN: 'tok',
      GITHUB_REPOSITORY: 'acme/widgets',
      GITHUB_REF: 'refs/pull/42/merge',
    },
    fetchImpl,
  });

  assert.equal(outcome.posted, false);
  assert.match(outcome.reason, /--pr-comment-post/u);
});

test('deliverPrComment does nothing outside a pull request context', async () => {
  const fetchImpl = () => { throw new Error('network must not be touched'); };

  const outcome = await deliverPrComment('body', {
    enabled: true,
    env: { GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'acme/widgets', GITHUB_REF: 'refs/heads/main' },
    fetchImpl,
  });

  assert.equal(outcome.posted, false);
  assert.match(outcome.reason, /pull request/u);
});

test('deliverPrComment posts when opted in with a complete context', async () => {
  const { fetchImpl, calls } = recordingFetch((url, init) => (
    init.method === 'POST' ? response(201, { html_url: 'https://gh.test/c/3' }) : response(200, [])
  ));

  const outcome = await deliverPrComment('body', {
    enabled: true,
    env: {
      GITHUB_TOKEN: 'tok',
      GITHUB_REPOSITORY: 'acme/widgets',
      GITHUB_REF: 'refs/pull/42/merge',
    },
    fetchImpl,
  });

  assert.deepEqual(outcome, { posted: true, action: 'created', url: 'https://gh.test/c/3' });
  assert.equal(calls.length, 2);
});

test('deliverPrComment reports an API failure without throwing or leaking the token', async () => {
  const fetchImpl = async () => response(401, { message: 'Bad credentials for tok-super-secret' });

  const outcome = await deliverPrComment('body', {
    enabled: true,
    env: {
      GITHUB_TOKEN: 'tok-super-secret',
      GITHUB_REPOSITORY: 'acme/widgets',
      GITHUB_REF: 'refs/pull/42/merge',
    },
    fetchImpl,
  });

  assert.equal(outcome.posted, false);
  assert.match(outcome.reason, /HTTP 401/u);
  assert.match(outcome.reason, /Bad credentials for \*\*\*/u);
  assert.ok(!outcome.reason.includes('tok-super-secret'));
});

test('deliverPrComment reports a transport failure without leaking the token', async () => {
  const fetchImpl = async () => { throw new Error('connect ECONNREFUSED using tok-super-secret'); };

  const outcome = await deliverPrComment('body', {
    enabled: true,
    env: {
      GITHUB_TOKEN: 'tok-super-secret',
      GITHUB_REPOSITORY: 'acme/widgets',
      GITHUB_REF: 'refs/pull/42/merge',
    },
    fetchImpl,
  });

  assert.equal(outcome.posted, false);
  assert.match(outcome.reason, /GitHub API GET failed/u);
  assert.ok(!outcome.reason.includes('tok-super-secret'));
});

test('deliverPrComment reports a failed update of an existing comment', async () => {
  const fetchImpl = async (url, init = {}) => (
    init.method === 'PATCH'
      ? response(403, { message: 'Resource not accessible by integration' })
      : response(200, [{ id: 77, body: `${PR_COMMENT_MARKER} old` }])
  );

  const outcome = await deliverPrComment('body', {
    enabled: true,
    env: {
      GITHUB_TOKEN: 'tok',
      GITHUB_REPOSITORY: 'acme/widgets',
      GITHUB_REF: 'refs/pull/42/merge',
    },
    fetchImpl,
  });

  assert.equal(outcome.posted, false);
  assert.match(outcome.reason, /HTTP 403: Resource not accessible by integration/u);
});
