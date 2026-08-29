import { readFileSync } from 'fs';
import { isAbsolute, relative } from 'path';

import { PR_PROVIDERS, selectPrProvider } from './pr-providers.js';

/**
 * Hidden marker embedded in every rendered body. Flecto finds its own comment by
 * searching for this string, so repeated runs update one sticky comment instead
 * of appending a new one on every push.
 */
export const PR_COMMENT_MARKER = '<!-- flecto:pr-comment -->';

const DEFAULT_TIMEOUT_MS = 10_000;
/** GitHub rejects comment bodies longer than 65536 characters. */
const MAX_BODY_CHARS = 60_000;
const MAX_INLINE_CHANGES = 10;
const MAX_VALUE_CHARS = 120;
const MAX_COMMENT_PAGES = 10;
const SEVERITY_ORDER = ['error', 'warn', 'info'];
const SEVERITY_HEADINGS = { error: 'Errors', warn: 'Warnings', info: 'Notices' };
const SEVERITY_NOUNS = { error: 'error', warn: 'warning', info: 'notice' };

/**
 * @typedef {{ file: string, envelope: import('./envelope.js').FlectoEnvelope, policies?: import('./policy.js').PolicyFinding[] }} CiResult
 * @typedef {{ provider?: string, prNumber: number, token: string, apiUrl: string,
 *   repo?: string, projectId?: string, webUrl?: string, workspace?: string, repoSlug?: string
 * }} PrCommentContext The fields a delivery adapter resolved; which ones are
 *   present depends on the provider. A context built by hand carries no
 *   `provider` and is treated as GitHub.
 */

/**
 * Render a value inside a markdown code span, widening the fence so embedded
 * backticks cannot terminate it early.
 * @param {string} text
 * @returns {string}
 */
function inlineCode(text) {
  const value = String(text);
  const runs = value.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

/**
 * Make a string safe for a markdown table cell: pipes end the cell (even inside
 * a code span) and newlines end the row.
 * @param {string} text
 * @returns {string}
 */
function tableCell(text) {
  return String(text).replaceAll(/\r?\n/gu, ' ').replaceAll('|', '\\|');
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Format a change value for display, or return null when the side is absent.
 * @param {unknown} value
 * @returns {string | null}
 */
function formatValue(value) {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  return truncate(json === undefined ? String(value) : json, MAX_VALUE_CHARS);
}

/**
 * Show repository-relative paths where possible; absolute runner paths are
 * noise in a PR comment.
 * @param {string} file
 * @param {string} [cwd]
 * @returns {string}
 */
function displayPath(file, cwd) {
  const value = String(file);
  if (!cwd || !isAbsolute(value)) return value;
  const rel = relative(cwd, value);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return value;
  return rel.replaceAll('\\', '/');
}

/**
 * @param {number} count
 * @param {string} noun
 * @returns {string}
 */
function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * @param {CiResult} result
 * @returns {import('./differ.js').ChangeEvent[]}
 */
function changesOf(result) {
  return result?.envelope?.changes ?? [];
}

/**
 * @param {CiResult} result
 * @returns {import('./policy.js').PolicyFinding[]}
 */
function findingsOf(result) {
  return result?.policies ?? result?.envelope?.policies ?? [];
}

/**
 * Render the markdown body of the sticky pull request comment.
 *
 * Pure: it reads nothing but its arguments, so the exact body posted to GitHub
 * is the body printed to stdout.
 * @param {CiResult[]} results
 * @param {{ cwd?: string, failed?: boolean, marker?: string, maxInlineChanges?: number, maxBodyChars?: number }} [options]
 * @returns {string} Markdown, always beginning with the sticky marker
 */
export function renderPrComment(results, options = {}) {
  const list = Array.isArray(results) ? results : [];
  const marker = options.marker ?? PR_COMMENT_MARKER;
  const maxInlineChanges = options.maxInlineChanges ?? MAX_INLINE_CHANGES;
  const maxBodyChars = options.maxBodyChars ?? MAX_BODY_CHARS;
  const cwd = options.cwd;

  const counts = { changed: 0, added: 0, removed: 0 };
  const severityCounts = { error: 0, warn: 0, info: 0 };
  /** @type {Record<string, Array<{ file: string, finding: import('./policy.js').PolicyFinding }>>} */
  const bySeverity = { error: [], warn: [], info: [] };
  let totalChanges = 0;

  for (const result of list) {
    const file = displayPath(result.file, cwd);
    for (const change of changesOf(result)) {
      totalChanges += 1;
      if (change.type in counts) counts[change.type] += 1;
    }
    for (const finding of findingsOf(result)) {
      const severity = SEVERITY_ORDER.includes(finding.severity) ? finding.severity : 'info';
      severityCounts[severity] += 1;
      bySeverity[severity].push({ file, finding });
    }
  }

  const totalFindings = SEVERITY_ORDER.reduce((sum, s) => sum + severityCounts[s], 0);
  const lines = [marker, '', '## Flecto — config change report', ''];

  const status = options.failed === true
    ? '❌ **Check failing** — '
    : options.failed === false
      ? '✅ **Check passing** — '
      : '';

  if (list.length === 0) {
    lines.push(`${status}no files were diffed.`);
  } else if (totalChanges === 0) {
    lines.push(`${status}no semantic changes in ${plural(list.length, 'file')}.`);
  } else {
    lines.push(
      `${status}${plural(totalChanges, 'change')} in ${plural(list.length, 'file')}` +
      ` — ${counts.changed} changed, ${counts.added} added, ${counts.removed} removed.`,
    );
  }

  lines.push('');
  lines.push(totalFindings === 0
    ? '**Policy:** no findings.'
    : `**Policy:** ${SEVERITY_ORDER
      .filter((severity) => severityCounts[severity] > 0)
      .map((severity) => plural(severityCounts[severity], SEVERITY_NOUNS[severity]))
      .join(', ')}.`);

  if (totalFindings > 0) {
    lines.push('', '### Policy findings');
    for (const severity of SEVERITY_ORDER) {
      const entries = bySeverity[severity];
      if (entries.length === 0) continue;
      lines.push('', `#### ${SEVERITY_HEADINGS[severity]} (${entries.length})`, '');
      lines.push('| File | Path | Rule | Message |', '|---|---|---|---|');
      for (const { file, finding } of entries) {
        const rule = finding.pack
          ? `${inlineCode(finding.id)} (${inlineCode(finding.pack)})`
          : inlineCode(finding.id);
        lines.push(
          `| ${tableCell(inlineCode(file))} | ${tableCell(inlineCode(finding.path))}` +
          ` | ${tableCell(rule)} | ${tableCell(finding.message ?? '')} |`,
        );
      }
    }
  }

  if (totalChanges > 0) {
    const collapse = totalChanges > maxInlineChanges;
    lines.push('', '### Changes');
    if (collapse) {
      lines.push('', '<details>', `<summary>Show all ${plural(totalChanges, 'change')}</summary>`);
    }
    for (const result of list) {
      const changes = changesOf(result);
      if (changes.length === 0) continue;
      const file = displayPath(result.file, cwd);
      lines.push('', `**${inlineCode(file)}** — ${plural(changes.length, 'change')}`, '');
      lines.push('| Change | Path | Before | After |', '|---|---|---|---|');
      for (const change of changes) {
        const kind = change.note ? `${change.type} (${change.note})` : String(change.type);
        const before = formatValue(change.before);
        const after = formatValue(change.after);
        lines.push(
          `| ${tableCell(kind)} | ${tableCell(inlineCode(change.path))}` +
          ` | ${before === null ? '—' : tableCell(inlineCode(before))}` +
          ` | ${after === null ? '—' : tableCell(inlineCode(after))} |`,
        );
      }
    }
    if (collapse) lines.push('', '</details>');
  }

  lines.push(
    '',
    '---',
    '',
    '<sub>Posted by [Flecto](https://github.com/myselfsiddharth/Flecto) —' +
    ' this comment is updated in place on every run.</sub>',
    '',
  );

  const body = lines.join('\n');
  if (body.length <= maxBodyChars) return body;
  const notice = '\n\n_Report truncated to fit GitHub\'s comment size limit._\n';
  return `${body.slice(0, Math.max(marker.length, maxBodyChars - notice.length))}${notice}`;
}

/**
 * Resolve the API context needed to post a merge request comment.
 *
 * The provider is detected from CI environment variables, or forced with
 * `provider`. GitHub is the fallback, so an unrecognized environment reports
 * the message it always did rather than a new one about detection.
 * @param {Record<string, string | undefined>} [env]
 * @param {{ readEventFile?: (path: string) => string, provider?: string }} [options]
 * @returns {{ ok: true, context: PrCommentContext } | { ok: false, reason: string }}
 */
export function resolvePrCommentContext(env = process.env, options = {}) {
  const readEventFile = options.readEventFile ?? ((path) => readFileSync(path, 'utf8'));
  const selected = selectPrProvider(env, options.provider);
  if (!selected.ok) return selected;
  return selected.provider.resolve(env, { readEventFile });
}

/**
 * The adapter a resolved context belongs to. Contexts built by hand — as tests
 * and embedders do — carry no provider and are GitHub, which is what they were
 * before there was a choice.
 * @param {{ provider?: string }} context
 */
function providerFor(context) {
  return PR_PROVIDERS.find((p) => p.id === context?.provider) ?? PR_PROVIDERS[0];
}

/**
 * Remove the token from text that may be surfaced to the user.
 * @param {string} text
 * @param {string} token
 * @returns {string}
 */
function redact(text, token) {
  return token ? String(text).replaceAll(token, '***') : String(text);
}

/**
 * @param {Response} response
 * @param {string} token
 * @returns {Promise<string>}
 */
async function errorDetail(response, token) {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return '';
  }
  let message = text;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.message === 'string') message = parsed.message;
  } catch {
    // Non-JSON error bodies are used as-is.
  }
  const safe = truncate(redact(message, token).replaceAll(/\s+/gu, ' ').trim(), 200);
  return safe ? `: ${safe}` : '';
}

/**
 * @param {{ fetchImpl: typeof fetch, provider: object, url: string, method: string, token: string, body?: unknown, timeoutMs: number }} request
 * @returns {Promise<Response>}
 */
async function apiRequest({ fetchImpl, provider, url, method, token, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Accept: provider.accept ?? 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'flecto',
        ...provider.authHeaders(token),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err?.name === 'AbortError'
      ? `timed out after ${timeoutMs}ms`
      : redact(err?.message ?? String(err), token);
    throw new Error(`${provider.label} API ${method} failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(
      `${provider.label} API ${method} returned HTTP ${response.status}${await errorDetail(response, token)}`,
    );
  }
  return response;
}

/**
 * Find the sticky Flecto comment on a pull request, if one exists.
 * @param {PrCommentContext} context
 * @param {{ fetchImpl: typeof fetch, marker: string, timeoutMs: number }} options
 * @returns {Promise<{ id: string | number, body?: string, url?: string } | null>}
 */
async function findStickyComment(context, { fetchImpl, marker, timeoutMs }) {
  const provider = providerFor(context);
  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const response = await apiRequest({
      fetchImpl, provider, url: provider.listUrl(context, page), method: 'GET', token: context.token, timeoutMs,
    });
    const comments = provider.readList(await response.json());
    if (comments.length === 0) return null;
    const match = comments.find((c) => typeof c?.body === 'string' && c.body.includes(marker));
    if (match) return match;
    if (comments.length < provider.perPage) return null;
  }
  return null;
}

/**
 * Create, update, or leave alone the single sticky Flecto comment on a PR.
 * Throws on API failure; callers decide how to degrade.
 * @param {string} body Markdown containing the sticky marker
 * @param {PrCommentContext} context
 * @param {{ fetchImpl?: typeof fetch, marker?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ action: 'created' | 'updated' | 'unchanged', url?: string }>}
 */
export async function upsertPrComment(body, context, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const marker = options.marker ?? PR_COMMENT_MARKER;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const provider = providerFor(context);
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch unavailable. Use Node.js >= 20.19.0.');
  }

  const existing = await findStickyComment(context, { fetchImpl, marker, timeoutMs });

  if (!existing) {
    const response = await apiRequest({
      fetchImpl,
      provider,
      url: provider.createUrl(context),
      method: 'POST',
      token: context.token,
      body: provider.payload(body),
      timeoutMs,
    });
    const created = await response.json().catch(() => ({}));
    return { action: 'created', url: provider.readOne(created, context).url };
  }

  // Rendering is deterministic, so an identical body means nothing moved since
  // the last run — skip the write and the "edited" noise it creates.
  if (existing.body === body) {
    return { action: 'unchanged', url: existing.url };
  }

  const response = await apiRequest({
    fetchImpl,
    provider,
    url: provider.updateUrl(context, existing.id),
    method: provider.updateMethod,
    token: context.token,
    body: provider.payload(body),
    timeoutMs,
  });
  const updated = await response.json().catch(() => ({}));
  return { action: 'updated', url: provider.readOne(updated, context).url ?? existing.url };
}

/**
 * Post the sticky comment when — and only when — posting was explicitly enabled
 * and a complete merge request context is present.
 *
 * Never throws and never reports the token: a delivery problem must not change
 * the CI exit code, which belongs to the diff and policy result alone.
 * @param {string} body
 * @param {{
 *   enabled?: boolean,
 *   env?: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 *   marker?: string,
 *   timeoutMs?: number,
 *   readEventFile?: (path: string) => string,
 *   provider?: string
 * }} [options]
 * @returns {Promise<{ posted: boolean, action?: 'created' | 'updated' | 'unchanged', url?: string, reason?: string }>}
 */
export async function deliverPrComment(body, options = {}) {
  if (!options.enabled) {
    return { posted: false, reason: 'posting is disabled (pass --pr-comment-post to enable)' };
  }

  const resolved = resolvePrCommentContext(options.env ?? process.env, options);
  if (!resolved.ok) {
    return { posted: false, reason: resolved.reason };
  }

  try {
    const result = await upsertPrComment(body, resolved.context, options);
    return { posted: true, ...result };
  } catch (err) {
    return {
      posted: false,
      reason: redact(err?.message ?? String(err), resolved.context.token),
    };
  }
}
