import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PR_COMMENT_MARKER,
  renderPrComment,
  resolvePrCommentContext,
  upsertPrComment,
} from '../src/pr-comment.js';
import { PR_PROVIDER_IDS, selectPrProvider } from '../src/pr-providers.js';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** A fetch stub that records every call. No test here touches the network. */
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

const BODY = renderPrComment([
  { file: '/repo/config/prod.yaml', envelope: { changes: [] }, policies: [] },
]);

const GITLAB_ENV = {
  GITLAB_CI: 'true',
  CI_PROJECT_ID: '4321',
  CI_MERGE_REQUEST_IID: '17',
  CI_API_V4_URL: 'https://gitlab.example.test/api/v4',
  FLECTO_GITLAB_TOKEN: 'glpat-secret',
};

const BITBUCKET_ENV = {
  BITBUCKET_WORKSPACE: 'acme',
  BITBUCKET_REPO_SLUG: 'widgets',
  BITBUCKET_PR_ID: '23',
  FLECTO_BITBUCKET_TOKEN: 'bb-secret',
};

/* ------------------------------------------------------------- selection */

test('the provider is detected from CI environment variables', () => {
  assert.equal(selectPrProvider(GITLAB_ENV).provider.id, 'gitlab');
  assert.equal(selectPrProvider(BITBUCKET_ENV).provider.id, 'bitbucket');
  assert.equal(selectPrProvider({ GITHUB_ACTIONS: 'true' }).provider.id, 'github');
});

test('an unrecognized environment falls back to github, unchanged from before', () => {
  assert.equal(selectPrProvider({}).provider.id, 'github');
  const resolved = resolvePrCommentContext({});
  assert.equal(resolved.ok, false);
  assert.match(resolved.reason, /GITHUB_TOKEN/u);
});

test('an explicit provider overrides detection', () => {
  const selected = selectPrProvider(GITLAB_ENV, 'github');
  assert.equal(selected.provider.id, 'github');
});

test('an unknown provider id is refused by name', () => {
  const selected = selectPrProvider({}, 'gerrit');
  assert.equal(selected.ok, false);
  assert.match(selected.reason, /unknown pr provider "gerrit"/u);
  for (const id of PR_PROVIDER_IDS) assert.match(selected.reason, new RegExp(id, 'u'));
});

/* ---------------------------------------------------------------- gitlab */

test('gitlab resolves a merge request pipeline', () => {
  const resolved = resolvePrCommentContext(GITLAB_ENV);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.context.provider, 'gitlab');
  assert.equal(resolved.context.projectId, '4321');
  assert.equal(resolved.context.prNumber, 17);
  assert.equal(resolved.context.apiUrl, 'https://gitlab.example.test/api/v4');
});

test('gitlab names the CI_JOB_TOKEN trap instead of failing with a bare 401', () => {
  const resolved = resolvePrCommentContext({
    GITLAB_CI: 'true',
    CI_PROJECT_ID: '4321',
    CI_MERGE_REQUEST_IID: '17',
    CI_JOB_TOKEN: 'job-token-that-cannot-post',
  });
  assert.equal(resolved.ok, false);
  assert.match(resolved.reason, /CI_JOB_TOKEN cannot post merge request notes/u);
  assert.match(resolved.reason, /FLECTO_GITLAB_TOKEN/u);
});

test('gitlab refuses a branch pipeline that is not a merge request', () => {
  const resolved = resolvePrCommentContext({ ...GITLAB_ENV, CI_MERGE_REQUEST_IID: undefined });
  assert.equal(resolved.ok, false);
  assert.match(resolved.reason, /not a merge request pipeline/u);
});

test('gitlab creates a note with a PRIVATE-TOKEN header', async () => {
  const { fetchImpl, calls } = recordingFetch((url, init) => {
    if (init.method === 'POST') return response(201, { id: 900 });
    return response(200, []);
  });

  const { context } = resolvePrCommentContext(GITLAB_ENV);
  const outcome = await upsertPrComment(BODY, context, { fetchImpl });

  assert.equal(outcome.action, 'created');
  assert.equal(calls[0].url, 'https://gitlab.example.test/api/v4/projects/4321/merge_requests/17/notes?per_page=100&page=1');
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].url, 'https://gitlab.example.test/api/v4/projects/4321/merge_requests/17/notes');
  assert.deepEqual(calls[1].body, { body: BODY });
  assert.equal(calls[1].headers['PRIVATE-TOKEN'], 'glpat-secret');
  // The GitHub bearer scheme must not leak onto another host.
  assert.equal(calls[1].headers.Authorization, undefined);
});

test('gitlab updates the sticky note in place with PUT', async () => {
  const { fetchImpl, calls } = recordingFetch((url, init) => {
    if (init.method === 'PUT') return response(200, { id: 55 });
    return response(200, [
      { id: 12, body: 'unrelated review note' },
      { id: 55, body: `${PR_COMMENT_MARKER}\n\nstale report` },
    ]);
  });

  const { context } = resolvePrCommentContext(GITLAB_ENV);
  const outcome = await upsertPrComment(BODY, context, { fetchImpl });

  assert.equal(outcome.action, 'updated');
  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].url, 'https://gitlab.example.test/api/v4/projects/4321/merge_requests/17/notes/55');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('gitlab links the created note when the pipeline exports a project URL', async () => {
  const { fetchImpl } = recordingFetch((url, init) => {
    if (init.method === 'POST') return response(201, { id: 900 });
    return response(200, []);
  });

  const { context } = resolvePrCommentContext({
    ...GITLAB_ENV,
    CI_MERGE_REQUEST_PROJECT_URL: 'https://gitlab.example.test/acme/widgets/',
  });
  const outcome = await upsertPrComment(BODY, context, { fetchImpl });

  // A note payload carries no web URL, so the anchor is built from the project
  // URL the pipeline already exports.
  assert.equal(outcome.url, 'https://gitlab.example.test/acme/widgets/-/merge_requests/17#note_900');
});

test('gitlab reports the action with no link when no project URL is exported', async () => {
  const { fetchImpl } = recordingFetch((url, init) => {
    if (init.method === 'POST') return response(201, { id: 900 });
    return response(200, []);
  });

  const { context } = resolvePrCommentContext(GITLAB_ENV);
  const outcome = await upsertPrComment(BODY, context, { fetchImpl });

  assert.equal(outcome.action, 'created');
  assert.equal(outcome.url, undefined);
});

test('a gitlab project path is url-encoded rather than splitting the route', () => {
  const { context } = resolvePrCommentContext({ ...GITLAB_ENV, CI_PROJECT_ID: 'acme/group/widgets' });
  const { provider } = selectPrProvider(GITLAB_ENV);
  assert.match(provider.listUrl(context, 1), /projects\/acme%2Fgroup%2Fwidgets\/merge_requests\/17\/notes/u);
});

/* ------------------------------------------------------------- bitbucket */

test('bitbucket resolves a pull request pipeline', () => {
  const resolved = resolvePrCommentContext(BITBUCKET_ENV);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.context.provider, 'bitbucket');
  assert.equal(resolved.context.workspace, 'acme');
  assert.equal(resolved.context.prNumber, 23);
});

test('bitbucket refuses a build that is not a pull request', () => {
  const resolved = resolvePrCommentContext({ ...BITBUCKET_ENV, BITBUCKET_PR_ID: undefined });
  assert.equal(resolved.ok, false);
  assert.match(resolved.reason, /not a pull request pipeline/u);
});

test('bitbucket wraps the body in content.raw and reads the values page', async () => {
  const { fetchImpl, calls } = recordingFetch((url, init) => {
    if (init.method === 'POST') {
      return response(201, { id: 7, links: { html: { href: 'https://bb.test/c/7' } } });
    }
    return response(200, { values: [{ id: 1, content: { raw: 'unrelated' } }] });
  });

  const { context } = resolvePrCommentContext(BITBUCKET_ENV);
  const outcome = await upsertPrComment(BODY, context, { fetchImpl });

  assert.deepEqual(outcome, { action: 'created', url: 'https://bb.test/c/7' });
  assert.equal(calls[0].url, 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/23/comments?pagelen=100&page=1');
  assert.deepEqual(calls[1].body, { content: { raw: BODY } });
  assert.equal(calls[1].headers.Authorization, 'Bearer bb-secret');
});

test('bitbucket finds the sticky comment inside content.raw and updates it', async () => {
  const { fetchImpl, calls } = recordingFetch((url, init) => {
    if (init.method === 'PUT') return response(200, { id: 42 });
    return response(200, {
      values: [
        { id: 1, content: { raw: 'unrelated' } },
        { id: 42, content: { raw: `${PR_COMMENT_MARKER}\n\nstale report` } },
      ],
    });
  });

  const { context } = resolvePrCommentContext(BITBUCKET_ENV);
  const outcome = await upsertPrComment(BODY, context, { fetchImpl });

  assert.equal(outcome.action, 'updated');
  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].url, 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/23/comments/42');
});

/* ------------------------------------------------------- shared guarantees */

test('an unchanged body skips the write on every provider', async () => {
  for (const [env, listed] of [
    [GITLAB_ENV, () => response(200, [{ id: 55, body: BODY }])],
    [BITBUCKET_ENV, () => response(200, { values: [{ id: 42, content: { raw: BODY } }] })],
  ]) {
    const { fetchImpl, calls } = recordingFetch(listed);
    const { context } = resolvePrCommentContext(env);
    const outcome = await upsertPrComment(BODY, context, { fetchImpl });
    assert.equal(outcome.action, 'unchanged');
    assert.equal(calls.length, 1, 'no write should follow an identical body');
  }
});

test('an API failure names the provider it came from', async () => {
  const { fetchImpl } = recordingFetch(() => response(401, { message: 'invalid token' }));
  const { context } = resolvePrCommentContext(GITLAB_ENV);
  await assert.rejects(
    () => upsertPrComment(BODY, context, { fetchImpl }),
    /GitLab API GET returned HTTP 401/u,
  );
});

test('the token never appears in a provider error', async () => {
  const { fetchImpl } = recordingFetch(() => response(403, { message: 'denied for glpat-secret' }));
  const { context } = resolvePrCommentContext(GITLAB_ENV);
  await assert.rejects(
    () => upsertPrComment(BODY, context, { fetchImpl }),
    (err) => {
      assert.ok(!err.message.includes('glpat-secret'), err.message);
      assert.match(err.message, /denied for \*\*\*/u);
      return true;
    },
  );
});
