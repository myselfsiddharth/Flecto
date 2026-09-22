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
 * Hashing rather than storing means a queue file on disk never contains the
 * URL or an auth header in the clear. Headers are sorted so key order cannot
 * split one destination into two.
 * @param {{ webhook?: string, webhookHeaders?: Record<string, string>, webhookFormat?: string }} options
 * @returns {string}
 */
function destinationId(options) {
  const headers = Object.entries(options.webhookHeaders ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const material = JSON.stringify([options.webhook ?? '', headers, options.webhookFormat ?? 'flecto']);
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
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
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
    return true;
  } catch (err) {
    renderWarn(`Could not flush persistent queue: ${err.message}`);
    return false;
  }
}

/**
 * Warn about events queued by a version that did not record a destination.
 *
 * Those files sit at the top level of `.flecto-queue/` rather than in a
 * destination directory, and nothing records where they were headed. Sending
 * them to the currently configured endpoint is exactly the bug this change
 * fixes, and deleting them would discard an event the operator was promised
 * at-least-once delivery of. So they are left alone and named once, which is
 * the only honest option.
 */
function warnAboutUnboundQueue() {
  let stale = [];
  try {
    stale = readdirSync(ALERT_QUEUE_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  if (stale.length === 0) return;
  renderWarn(
    `${stale.length} queued event(s) in ${ALERT_QUEUE_DIR}/ predate destination binding and were `
    + 'not delivered: nothing records which webhook they were addressed to, and sending them to '
    + 'the currently configured one is the delivery-to-the-wrong-endpoint bug this version fixes. '
    + 'Inspect and remove them, or re-send them deliberately.',
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
        renderWarn(`${msg}: ${redactWebhookUrl(url)} (${err.message})`);
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
        warnAboutUnboundQueue();
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
