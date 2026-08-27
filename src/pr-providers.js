/**
 * Delivery adapters for the sticky review comment.
 *
 * Everything upstream of delivery — the differ, the policy engine, the
 * envelope, and the rendered comment body — is provider-agnostic markdown.
 * Only the last step differs, so only the last step lives here: which
 * environment variables identify a merge request, how the host authenticates,
 * and the three URLs needed to list, create, and update a comment.
 *
 * Adding a provider means adding one object to {@link PR_PROVIDERS}. Nothing
 * else in Flecto needs to know it exists.
 */

const GITHUB_API_URL = 'https://api.github.com';
const GITLAB_API_URL = 'https://gitlab.com/api/v4';
const BITBUCKET_API_URL = 'https://api.bitbucket.org/2.0';

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   perPage: number,
 *   detect: (env: Record<string, string | undefined>) => boolean,
 *   resolve: (
 *     env: Record<string, string | undefined>,
 *     helpers: { readEventFile: (path: string) => string },
 *   ) => { ok: true, context: object } | { ok: false, reason: string },
 *   authHeaders: (token: string) => Record<string, string>,
 *   accept?: string,
 *   listUrl: (context: any, page: number) => string,
 *   readList: (payload: unknown) => { id: string | number, body: string, url?: string }[],
 *   createUrl: (context: any) => string,
 *   updateUrl: (context: any, id: string | number) => string,
 *   updateMethod: string,
 *   payload: (body: string) => object,
 *   readOne: (payload: any, context: any) => { url?: string },
 * }} PrProvider
 */

/** Trim trailing slashes from a base URL. */
function trimUrl(value, fallback) {
  return String(value || fallback).replace(/\/+$/u, '');
}

/**
 * Pull request number from the GitHub ref, then the event payload.
 * @param {Record<string, string | undefined>} env
 * @param {(path: string) => string} readEventFile
 * @returns {number | null}
 */
function githubPrNumber(env, readEventFile) {
  const fromRef = /^refs\/pull\/(\d+)\/(?:merge|head)$/u.exec(env.GITHUB_REF ?? '');
  if (fromRef) return Number(fromRef[1]);

  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) return null;

  let event;
  try {
    event = JSON.parse(readEventFile(eventPath));
  } catch {
    return null;
  }

  const candidates = [
    event?.pull_request?.number,
    // issue_comment events on a PR carry the PR number under `issue`, but a
    // plain issue must not be mistaken for one.
    event?.issue?.pull_request ? event?.issue?.number : undefined,
    event?.number,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return null;
}

/** @type {PrProvider} */
const github = {
  id: 'github',
  label: 'GitHub',
  perPage: 100,
  accept: 'application/vnd.github+json',
  detect: (env) => Boolean(env.GITHUB_ACTIONS || env.GITHUB_REPOSITORY || env.GITHUB_EVENT_PATH),

  resolve(env, { readEventFile }) {
    // Only GITHUB_TOKEN is honored — GH_TOKEN is deliberately ignored because
    // `gh auth login` exports it on developer machines, where posting would be
    // a surprise.
    const token = String(env.GITHUB_TOKEN ?? '').trim();
    if (!token) return { ok: false, reason: 'GITHUB_TOKEN is not set' };

    const repo = String(env.GITHUB_REPOSITORY ?? '').trim();
    if (!/^[^/\s]+\/[^/\s]+$/u.test(repo)) {
      return { ok: false, reason: 'GITHUB_REPOSITORY is not set to "owner/repo"' };
    }

    const prNumber = githubPrNumber(env, readEventFile);
    if (!prNumber) {
      return {
        ok: false,
        reason: 'no pull request number in GITHUB_REF or GITHUB_EVENT_PATH (not a pull request run)',
      };
    }

    return {
      ok: true,
      context: { provider: 'github', repo, prNumber, token, apiUrl: trimUrl(env.GITHUB_API_URL, GITHUB_API_URL) },
    };
  },

  authHeaders: (token) => ({ Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }),
  listUrl: (c, page) => `${c.apiUrl}/repos/${c.repo}/issues/${c.prNumber}/comments?per_page=${github.perPage}&page=${page}`,
  readList: (payload) => (Array.isArray(payload) ? payload : []).map((c) => ({ id: c?.id, body: c?.body, url: c?.html_url })),
  createUrl: (c) => `${c.apiUrl}/repos/${c.repo}/issues/${c.prNumber}/comments`,
  updateUrl: (c, id) => `${c.apiUrl}/repos/${c.repo}/issues/comments/${id}`,
  updateMethod: 'PATCH',
  payload: (body) => ({ body }),
  readOne: (payload) => ({ url: payload?.html_url }),
};

/** @type {PrProvider} */
const gitlab = {
  id: 'gitlab',
  label: 'GitLab',
  perPage: 100,
  detect: (env) => Boolean(env.GITLAB_CI || env.CI_MERGE_REQUEST_IID),

  resolve(env) {
    // CI_JOB_TOKEN is present on every GitLab job and cannot write notes, so
    // silently trying it would produce a 401 that reads like a broken setup.
    // Name the fix instead.
    const token = String(env.FLECTO_GITLAB_TOKEN ?? env.GITLAB_TOKEN ?? '').trim();
    if (!token) {
      return {
        ok: false,
        reason: env.CI_JOB_TOKEN
          ? 'no GitLab API token: CI_JOB_TOKEN cannot post merge request notes. '
            + 'Set FLECTO_GITLAB_TOKEN to a project or group access token with the "api" scope.'
          : 'FLECTO_GITLAB_TOKEN (or GITLAB_TOKEN) is not set',
      };
    }

    const projectId = String(env.CI_PROJECT_ID ?? '').trim();
    if (!projectId) return { ok: false, reason: 'CI_PROJECT_ID is not set' };

    const iid = Number(env.CI_MERGE_REQUEST_IID);
    if (!Number.isInteger(iid) || iid <= 0) {
      return { ok: false, reason: 'CI_MERGE_REQUEST_IID is not set (not a merge request pipeline)' };
    }

    return {
      ok: true,
      context: {
        provider: 'gitlab',
        projectId,
        prNumber: iid,
        token,
        apiUrl: trimUrl(env.CI_API_V4_URL, GITLAB_API_URL),
        webUrl: String(env.CI_MERGE_REQUEST_PROJECT_URL ?? '').replace(/\/+$/u, ''),
      },
    };
  },

  authHeaders: (token) => ({ 'PRIVATE-TOKEN': token }),
  listUrl: (c, page) => `${gitlabNotesBase(c)}?per_page=${gitlab.perPage}&page=${page}`,
  readList: (payload) => (Array.isArray(payload) ? payload : []).map((n) => ({ id: n?.id, body: n?.body })),
  createUrl: (c) => gitlabNotesBase(c),
  updateUrl: (c, id) => `${gitlabNotesBase(c)}/${id}`,
  updateMethod: 'PUT',
  payload: (body) => ({ body }),
  readOne: (payload, c) => (c?.webUrl && payload?.id
    ? { url: `${c.webUrl}/-/merge_requests/${c.prNumber}#note_${payload.id}` }
    : {}),
};

/** Notes collection for the merge request. Project ids may be paths, so encode. */
function gitlabNotesBase(c) {
  return `${c.apiUrl}/projects/${encodeURIComponent(c.projectId)}/merge_requests/${c.prNumber}/notes`;
}

/** @type {PrProvider} */
const bitbucket = {
  id: 'bitbucket',
  label: 'Bitbucket',
  perPage: 100,
  detect: (env) => Boolean(env.BITBUCKET_PR_ID || env.BITBUCKET_REPO_SLUG),

  resolve(env) {
    const token = String(env.FLECTO_BITBUCKET_TOKEN ?? env.BITBUCKET_TOKEN ?? '').trim();
    if (!token) return { ok: false, reason: 'FLECTO_BITBUCKET_TOKEN (or BITBUCKET_TOKEN) is not set' };

    const workspace = String(env.BITBUCKET_WORKSPACE ?? '').trim();
    const repoSlug = String(env.BITBUCKET_REPO_SLUG ?? '').trim();
    if (!workspace || !repoSlug) {
      return { ok: false, reason: 'BITBUCKET_WORKSPACE and BITBUCKET_REPO_SLUG must both be set' };
    }

    const prId = Number(env.BITBUCKET_PR_ID);
    if (!Number.isInteger(prId) || prId <= 0) {
      return { ok: false, reason: 'BITBUCKET_PR_ID is not set (not a pull request pipeline)' };
    }

    return {
      ok: true,
      context: {
        provider: 'bitbucket',
        workspace,
        repoSlug,
        prNumber: prId,
        token,
        apiUrl: trimUrl(env.BITBUCKET_API_URL, BITBUCKET_API_URL),
      },
    };
  },

  authHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
  listUrl: (c, page) => `${bitbucketCommentsBase(c)}?pagelen=${bitbucket.perPage}&page=${page}`,
  readList: (payload) => (Array.isArray(payload?.values) ? payload.values : []).map((c) => ({
    id: c?.id,
    body: c?.content?.raw,
    url: c?.links?.html?.href,
  })),
  createUrl: (c) => bitbucketCommentsBase(c),
  updateUrl: (c, id) => `${bitbucketCommentsBase(c)}/${id}`,
  updateMethod: 'PUT',
  payload: (body) => ({ content: { raw: body } }),
  readOne: (payload) => ({ url: payload?.links?.html?.href }),
};

function bitbucketCommentsBase(c) {
  return `${c.apiUrl}/repositories/${c.workspace}/${c.repoSlug}/pullrequests/${c.prNumber}/comments`;
}

/** Detection order. GitHub stays first so its behavior is unchanged. */
export const PR_PROVIDERS = [github, gitlab, bitbucket];

export const PR_PROVIDER_IDS = PR_PROVIDERS.map((p) => p.id);

/**
 * Pick the delivery adapter.
 *
 * An explicit id always wins. Otherwise the first provider whose CI variables
 * are present is used, and GitHub is the fallback so an unrecognized
 * environment produces the same message it always did rather than a new one
 * about provider detection.
 * @param {Record<string, string | undefined>} env
 * @param {string} [explicit]
 * @returns {{ ok: true, provider: PrProvider } | { ok: false, reason: string }}
 */
export function selectPrProvider(env, explicit) {
  if (explicit) {
    const found = PR_PROVIDERS.find((p) => p.id === explicit);
    if (!found) {
      return { ok: false, reason: `unknown pr provider "${explicit}" (expected ${PR_PROVIDER_IDS.join(', ')})` };
    }
    return { ok: true, provider: found };
  }
  return { ok: true, provider: PR_PROVIDERS.find((p) => p.detect(env)) ?? github };
}
