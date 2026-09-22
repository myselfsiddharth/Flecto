import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { renderWarn } from './renderer.js';
import { formatWebhookPayload } from './notifiers.js';

const ALERT_TMP_DIR = '.flecto-tmp';
const ALERT_QUEUE_DIR = '.flecto-queue';
const MAX_ENV_CHANGES_CHARS = 16_000;

/**
 * A webhook URL reduced to the part that identifies it without carrying its
 * credential.
 *
 * Webhook URLs routinely *are* credentials: a Slack incoming webhook puts its
 * secret in the path (`/services/T.../B.../XXXX`), and userinfo and query
 * strings carry tokens just as often. Warnings about a failed delivery are
 * printed to a terminal and, in CI, into a log that is frequently world
 * readable and retained — so a transient 500 was enough to copy the credential
 * somewhere it outlives the run.
 *
 * Only the origin survives, plus a marker showing a path was elided. That is
 * enough for an operator to tell *which* endpoint failed (they configured it)
 * and not enough for a reader of the log to call it.
 * @param {string} raw
 * @returns {string}
 */
export function redactWebhookUrl(raw) {
  try {
    const url = new URL(raw);
    const path = url.pathname && url.pathname !== '/' ? '/...' : '';
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    // Not parseable as a URL, so nothing can be said about which part is the
    // secret. Say nothing.
    return '<webhook>';
  }
}

/**
 * An error's message with every URL in it redacted.
 *
 * Redacting the URL Flecto interpolates is not enough on its own, because
 * `fetch` puts the URL into the error it throws. Two cases reach this
 * deterministically, and both are precisely where redaction matters most:
 * a URL carrying userinfo (`https://user:TOKEN@host/x`) fails with *"Request
 * cannot be constructed from a URL that includes credentials: <the whole
 * thing>"*, and an unparseable URL fails with *"Failed to parse URL from
 * <the whole thing>"* -- the very case `redactWebhookUrl` answers `<webhook>`
 * to, because nothing can be said about which part is the secret.
 *
 * So the configured URL is substituted out by value, and any other URL-shaped
 * run is redacted on sight in case the engine spelled it differently.
 * @param {unknown} err
 * @param {string} [url] the URL this delivery was configured with
 * @returns {string}
 */
function redactedFailureDetail(err, url) {
  let message = String(/** @type {{ message?: unknown }} */ (err)?.message ?? err);
  if (url) message = message.split(url).join(redactWebhookUrl(url));
  return message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, (found) => redactWebhookUrl(found));
}

/**
 * A stable fingerprint of everything that decides *where* a delivery goes and
 * what it looks like on arrival.
 *
 * The persistent queue used to store the envelope alone, so a flush delivered
 * it with whatever options the *current* `fireAlerts` call happened to carry.
 * An event queued while `watch` pointed at one endpoint would be posted to
 * whichever endpoint the next run named -- a different team's channel, a
 * different vendor, a URL from a different profile -- carrying configuration
 * data the operator had directed elsewhere.
 *
 * Hashing rather than storing keeps the URL and any auth header out of the
 * queue file. It is a fingerprint, not a secret: anyone who can read
 * `.flecto-queue/` could confirm a *guessed* URL against it, but they can read
 * the directory only if they can already read the config that names it.
 *
 * Header *values* are included, so rotating a token strands the old backlog
 * rather than replaying it under new credentials. That is the safe direction,
 * and `warnAboutStrandedQueue` is what stops it being silent.
 * @param {{ webhook?: string, webhookHeaders?: Record<string, string>, webhookFormat?: string }} options
 * @returns {string}
 */
function destinationId(options) {
  // Normalize first, so one destination does not split into several
  // directories over spellings that address the same endpoint. `new URL().href`
  // settles host case and a redundant default port; HTTP header names are
  // case-insensitive by spec, so they are lowercased before sorting. A trailing
  // slash is left alone -- it is a different path, and a receiver may treat it
  // as one.
  let url = options.webhook ?? '';
  try {
    url = new URL(url).href;
  } catch {
    // Not parseable: hash it as written rather than guessing at it.
  }
  const headers = Object.entries(options.webhookHeaders ?? {})
    .map(([key, value]) => [key.toLowerCase(), value])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const material = JSON.stringify([url, headers, options.webhookFormat ?? 'flecto']);
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/** @type {Promise<void>} */
let alertQueue = Promise.resolve();

function enqueue(fn) {
  const result = alertQueue
    .then(() => fn());
  alertQueue = result
    .catch((err) => {
      renderWarn(`Alert pipeline error: ${err?.message ?? String(err)}`);
    });
  return result;
}

/**
 * Build the environment a `--command` subprocess runs with, spilling an
 * oversized change set to a file.
 *
 * The spill file holds the complete, unmasked change set -- every value the
 * diff touched, including ones `--mask-secrets` would have hidden on screen.
 * It is created `0600` inside a `0700` directory and deleted once the command
 * exits, so it is readable only by the user running Flecto and only while
 * there is a process that needs it. Previously it inherited the process umask
 * (`0644` on a typical runner) and was never removed, which left the full
 * change set of every oversized event sitting in the workspace for whatever
 * ran next -- a later build step, an artifact upload, a cache action.
 * @param {import('./envelope.js').FlectoEnvelope} envelope
 * @returns {{ env: Record<string, string>, cleanup: () => void }}
 */
function buildCommandEnv(envelope) {
  const json = JSON.stringify(envelope.changes);
  const env = {
    ...process.env,
    FLECTO_FILE: envelope.file,
    FLECTO_EVENT_ID: envelope.event_id,
    FLECTO_BATCH_ID: envelope.batch_id,
    FLECTO_SCHEMA_VERSION: envelope.schema_version,
  };
  const noop = () => {};

  if (json.length <= MAX_ENV_CHANGES_CHARS) {
    env.FLECTO_CHANGES = json;
    return { env, cleanup: noop };
  }

  try {
    mkdirSync(ALERT_TMP_DIR, { recursive: true, mode: 0o700 });
    const outPath = resolve(`${ALERT_TMP_DIR}/changes-${Date.now()}-${envelope.event_id}.json`);
    writeFileSync(outPath, json, { encoding: 'utf8', mode: 0o600 });
    env.FLECTO_CHANGES_FILE = outPath;
    env.FLECTO_CHANGES = '[]';
    return {
      env,
      cleanup: () => {
        try {
          rmSync(outPath, { force: true });
        } catch {
          // The command may have moved or removed it; either way there is
          // nothing left to clean and nothing useful to say.
        }
      },
    };
  } catch (err) {
    env.FLECTO_CHANGES = '[]';
    env.FLECTO_CHANGES_TRUNCATED = '1';
    renderWarn(`Could not write changes payload to temp file: ${err.message}`);
    return { env, cleanup: noop };
  }
}

/**
 * @param {string} command
 * @param {import('./envelope.js').FlectoEnvelope} envelope
 * @returns {Promise<boolean>}
 */
export function runCommand(command, envelope) {
  return new Promise((resolveDone) => {
    const { env, cleanup } = buildCommandEnv(envelope);
    // The spill file exists for exactly as long as the subprocess that reads
    // it. `settle` runs on every exit path, including the throw below, so no
    // path leaves the change set on disk.
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveDone(ok);
    };
    try {
      const child = spawn(command, {
        shell: true,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout?.on('data', (d) => process.stdout.write(d));
      child.stderr?.on('data', (d) => process.stderr.write(d));
      child.on('error', (err) => {
        renderWarn(`Command failed to start: ${err.message}`);
        settle(false);
      });
      child.on('close', (code) => {
        if (code && code !== 0) {
          renderWarn(`Command failed (exit ${code}): ${command}`);
          settle(false);
          return;
        }
        settle(true);
      });
    } catch (err) {
      renderWarn(`Command execution error: ${err.message}`);
      settle(false);
    }
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The queue directory holding undelivered events for one destination.
 *
 * Each destination gets its own subdirectory, keyed by the fingerprint of the
 * URL, headers, and format. That is what binds a queued event to the endpoint
 * it was addressed to: a flush reads only its own directory, so it can no
 * longer pick up an event queued for somewhere else. Keying the directory,
 * rather than filtering files after reading them, also means a destination
 * never even opens another's backlog.
 * @param {{ webhook?: string, webhookHeaders?: Record<string, string>, webhookFormat?: string }} options
 * @returns {string}
 */
function queueDirFor(options) {
  return resolve(join(ALERT_QUEUE_DIR, destinationId(options)));
}

/**
 * `queueDirFor`, exposed so tests can assert which destinations share a queue.
 * @type {typeof queueDirFor}
 */
export const queueDirForTest = queueDirFor;

/**
 * @param {{ webhook?: string, webhookHeaders?: Record<string, string>, webhookFormat?: string }} options
 * @param {import('./envelope.js').FlectoEnvelope} envelope
 */
function enqueuePersistent(options, envelope) {
  const dir = queueDirFor(options);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${Date.now()}-${envelope.event_id}.json`);
  // The envelope carries the change set, so it gets the same 0600 the spill
  // file gets -- an undelivered alert is the same data, just waiting.
  writeFileSync(path, JSON.stringify(envelope, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/**
 * Deliver everything queued *for this destination*, oldest first.
 *
 * Stops at the first failure and leaves the rest queued, so ordering is
 * preserved and at-least-once still means at least once.
 * @param {{ webhook?: string, webhookHeaders?: Record<string, string>, webhookFormat?: string }} options
 * @param {(envelope: import('./envelope.js').FlectoEnvelope) => Promise<boolean>} deliver
 */
async function flushPersistentQueue(options, deliver) {
  const dir = queueDirFor(options);
  try {
    // Deliberately no mkdir: a flush that created its own directory left an
    // empty one behind on every successful run, one per destination ever
    // configured, never cleaned. Nothing queued means nothing to do.
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return true;
    }
    for (const file of files) {
      const fullPath = join(dir, file);
      let envelope;
      try {
        envelope = JSON.parse(readFileSync(fullPath, 'utf8'));
      } catch {
        unlinkSync(fullPath);
        continue;
      }
      const ok = await deliver(envelope);
      if (ok) {
        unlinkSync(fullPath);
      } else {
        return false;
      }
    }
    // Drained: take the directory with it, so the queue root does not
    // accumulate one entry per destination that ever had a backlog.
    try {
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: false, force: true });
    } catch {
      // A concurrent writer may have just queued into it. Leaving it is fine.
    }
    return true;
  } catch (err) {
    renderWarn(`Could not flush persistent queue: ${err.message}`);
    return false;
  }
}

/**
 * Queue roots already warned about, so a watch on a churning file says this
 * once rather than on every event. Keyed by path rather than a single flag:
 * one process can legitimately serve more than one workspace, and each
 * deserves to be told about its own backlog.
 * @type {Set<string>}
 */
const strandedQueuesWarned = new Set();

/**
 * Warn about queued events that this run will not deliver.
 *
 * Two kinds, and neither may be delivered silently to the endpoint currently
 * configured -- doing that is the bug this change fixes:
 *
 * - Events queued by Flecto 3.x sit at the top level of `.flecto-queue/` with
 *   no destination recorded at all.
 * - Events queued for a destination that is not the one now configured sit in
 *   a sibling directory. Rotating an auth token on the same URL is enough to
 *   produce this, and it is the likelier cause in practice.
 *
 * Deleting either would discard an event the operator was promised
 * at-least-once delivery of, so they are left alone and named. Naming them is
 * the whole point: the earlier version of this warning only looked at
 * top-level files, so a stranded 4.x backlog was invisible -- strictly worse
 * than the 3.x case it did report.
 * @param {string} currentDir the destination directory this run is flushing
 */
function warnAboutStrandedQueue(currentDir) {
  const root = resolve(ALERT_QUEUE_DIR);
  if (strandedQueuesWarned.has(root)) return;
  let entries;
  try {
    entries = readdirSync(ALERT_QUEUE_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  const legacy = entries.filter((e) => e.isFile() && e.name.endsWith('.json')).length;
  let stranded = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(ALERT_QUEUE_DIR, entry.name);
    if (resolve(dir) === resolve(currentDir)) continue;
    try {
      stranded += readdirSync(dir).filter((f) => f.endsWith('.json')).length;
    } catch {
      // Unreadable: not something to report as a queued event.
    }
  }
  if (legacy === 0 && stranded === 0) return;
  strandedQueuesWarned.add(root);

  const parts = [];
  if (legacy > 0) {
    parts.push(
      `${legacy} event(s) queued by Flecto 3.x, which recorded no destination at all`,
    );
  }
  if (stranded > 0) {
    parts.push(
      `${stranded} event(s) queued for a destination that is not the one configured now`
      + ' (rotating a webhook token or editing the URL does this)',
    );
  }
  renderWarn(
    `${ALERT_QUEUE_DIR}/ holds undelivered events this run will not send: ${parts.join('; ')}. `
    + 'They are kept, not dropped. Delivering them to the endpoint configured now is the '
    + 'wrong-endpoint delivery this version exists to prevent, so re-send them deliberately '
    + 'or remove them once you have looked.',
  );
}

/**
 * @param {string} url
 * @param {import('./envelope.js').FlectoEnvelope} envelope
 * @param {{
 *  headers?: Record<string, string>,
 *  timeoutMs?: number,
 *  retries?: number,
 *  format?: import('./notifiers.js').WebhookFormat
 * }} [options]
 * @returns {Promise<boolean>}
 */
export async function postWebhook(url, envelope, options = {}) {
  // `flecto` (the default) returns the envelope untouched, so the body is
  // byte-identical to what has always been posted. Chat formats reshape only
  // the body: headers, retries, and delivery modes are unchanged.
  const body = JSON.stringify(formatWebhookPayload(envelope, options.format ?? 'flecto'));
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retries = options.retries ?? 2;
  const headers = {
    'Content-Type': 'application/json',
    'X-Flecto-Event-Id': envelope.event_id,
    'X-Flecto-Batch-Id': envelope.batch_id,
    'X-Flecto-Schema': envelope.schema_version,
    ...(options.headers ?? {}),
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        renderWarn(`Webhook returned HTTP ${response.status}: ${redactWebhookUrl(url)}`);
        if (response.status >= 500 && attempt < retries) {
          const backoff = Math.min(2_000, 200 * Math.pow(2, attempt));
          await sleep(backoff + Math.floor(Math.random() * 150));
          continue;
        }
        return false;
      }
      return true;
    } catch (err) {
      const msg = err?.name === 'AbortError' ? `Webhook timed out after ${timeoutMs}ms` : 'Webhook failed';
      if (attempt >= retries) {
        renderWarn(`${msg}: ${redactWebhookUrl(url)} (${redactedFailureDetail(err, url)})`);
        return false;
      }
      const backoff = Math.min(2_000, 200 * Math.pow(2, attempt));
      await sleep(backoff + Math.floor(Math.random() * 150));
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

/**
 * @param {{
 *  webhook?: string,
 *  webhookHeaders?: Record<string, string>,
 *  webhookTimeoutMs?: number,
 *  webhookRetries?: number,
 *  webhookFormat?: import('./notifiers.js').WebhookFormat
 * }} options
 * @param {import('./envelope.js').FlectoEnvelope} envelope
 */
async function deliverWebhook(options, envelope) {
  if (!options.webhook) return true;
  return postWebhook(options.webhook, envelope, {
    headers: options.webhookHeaders,
    timeoutMs: options.webhookTimeoutMs,
    retries: options.webhookRetries,
    format: options.webhookFormat,
  });
}

/**
 * @param {{ onAlertFailure?: 'warn' | 'exit' | 'retry' }} options
 * @param {boolean} ok
 */
function applyFailurePolicy(options, ok) {
  if (ok) return;
  const policy = options.onAlertFailure ?? 'warn';
  if (policy === 'exit') {
    process.exitCode = 1;
  }
}

/**
 * @param {{
 *  command?: string,
 *  webhook?: string,
 *  webhookHeaders?: Record<string, string>,
 *  webhookTimeoutMs?: number,
 *  webhookRetries?: number,
 *  webhookFormat?: import('./notifiers.js').WebhookFormat,
 *  deliveryMode?: 'best-effort' | 'at-least-once',
 *  onAlertFailure?: 'warn' | 'exit' | 'retry'
 * }} options
 * @param {import('./envelope.js').FlectoEnvelope} envelope
 * @returns {Promise<{ ok: boolean }>}
 */
export async function fireAlerts(options, envelope) {
  return enqueue(async () => {
    let ok = true;

    if (options.command) {
      const cmdOk = await runCommand(options.command, envelope);
      ok = ok && cmdOk;
    }

    if (options.webhook) {
      if (options.deliveryMode === 'at-least-once') {
        warnAboutStrandedQueue(queueDirFor(options));
        await flushPersistentQueue(options, (queued) => deliverWebhook(options, queued));
      }

      let webhookOk = await deliverWebhook(options, envelope);
      if (!webhookOk && options.onAlertFailure === 'retry') {
        webhookOk = await deliverWebhook({ ...options, webhookRetries: 5 }, envelope);
      }
      if (!webhookOk && options.deliveryMode === 'at-least-once') {
        enqueuePersistent(options, envelope);
      }
      ok = ok && webhookOk;
    }

    applyFailurePolicy(options, ok);
    return { ok };
  });
}
