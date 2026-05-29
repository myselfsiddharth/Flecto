import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { renderWarn } from './renderer.js';

const ALERT_TMP_DIR = '.driff-tmp';
const ALERT_QUEUE_DIR = '.driff-queue';
const MAX_ENV_CHANGES_CHARS = 16_000;

/** @type {Promise<void>} */
let alertQueue = Promise.resolve();

function enqueue(fn) {
  alertQueue = alertQueue
    .then(async () => { await fn(); })
    .catch((err) => {
      renderWarn(`Alert pipeline error: ${err?.message ?? String(err)}`);
    });
  return alertQueue;
}

/**
 * @param {import('./envelope.js').SentinelEnvelope} envelope
 */
function buildCommandEnv(envelope) {
  const json = JSON.stringify(envelope.changes);
  const env = {
    ...process.env,
    DRIFF_FILE: envelope.file,
    DRIFF_EVENT_ID: envelope.event_id,
    DRIFF_BATCH_ID: envelope.batch_id,
    DRIFF_SCHEMA_VERSION: envelope.schema_version,
  };

  if (json.length <= MAX_ENV_CHANGES_CHARS) {
    env.DRIFF_CHANGES = json;
    return env;
  }

  try {
    mkdirSync(ALERT_TMP_DIR, { recursive: true });
    const outPath = resolve(`${ALERT_TMP_DIR}/changes-${Date.now()}-${envelope.event_id}.json`);
    writeFileSync(outPath, json, 'utf8');
    env.DRIFF_CHANGES_FILE = outPath;
    env.DRIFF_CHANGES = '[]';
    return env;
  } catch (err) {
    env.DRIFF_CHANGES = '[]';
    env.DRIFF_CHANGES_TRUNCATED = '1';
    renderWarn(`Could not write changes payload to temp file: ${err.message}`);
    return env;
  }
}

/**
 * @param {string} command
 * @param {import('./envelope.js').SentinelEnvelope} envelope
 * @returns {Promise<boolean>}
 */
export function runCommand(command, envelope) {
  return new Promise((resolveDone) => {
    const env = buildCommandEnv(envelope);
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
        resolveDone(false);
      });
      child.on('close', (code) => {
        if (code && code !== 0) {
          renderWarn(`Command failed (exit ${code}): ${command}`);
          resolveDone(false);
          return;
        }
        resolveDone(true);
      });
    } catch (err) {
      renderWarn(`Command execution error: ${err.message}`);
      resolveDone(false);
    }
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {import('./envelope.js').SentinelEnvelope} envelope
 */
function enqueuePersistent(envelope) {
  mkdirSync(ALERT_QUEUE_DIR, { recursive: true });
  const path = resolve(`${ALERT_QUEUE_DIR}/${Date.now()}-${envelope.event_id}.json`);
  writeFileSync(path, JSON.stringify(envelope, null, 2), 'utf8');
}

/**
 * @param {(envelope: import('./envelope.js').SentinelEnvelope) => Promise<boolean>} deliver
 */
async function flushPersistentQueue(deliver) {
  try {
    mkdirSync(ALERT_QUEUE_DIR, { recursive: true });
    const files = readdirSync(ALERT_QUEUE_DIR).filter((f) => f.endsWith('.json')).sort();
    for (const file of files) {
      const fullPath = resolve(`${ALERT_QUEUE_DIR}/${file}`);
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
 * @param {string} url
 * @param {import('./envelope.js').SentinelEnvelope} envelope
 * @param {{ headers?: Record<string, string>, timeoutMs?: number, retries?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function postWebhook(url, envelope, options = {}) {
  const body = JSON.stringify(envelope);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retries = options.retries ?? 2;
  const headers = {
    'Content-Type': 'application/json',
    'X-Driff-Event-Id': envelope.event_id,
    'X-Driff-Batch-Id': envelope.batch_id,
    'X-Driff-Schema': envelope.schema_version,
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
        renderWarn(`Webhook returned HTTP ${response.status}: ${url}`);
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
        renderWarn(`${msg}: ${url} (${err.message})`);
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
 * @param {{ webhook?: string, webhookHeaders?: Record<string, string>, webhookTimeoutMs?: number, webhookRetries?: number }} options
 * @param {import('./envelope.js').SentinelEnvelope} envelope
 */
async function deliverWebhook(options, envelope) {
  if (!options.webhook) return true;
  return postWebhook(options.webhook, envelope, {
    headers: options.webhookHeaders,
    timeoutMs: options.webhookTimeoutMs,
    retries: options.webhookRetries,
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
 *  deliveryMode?: 'best-effort' | 'at-least-once',
 *  onAlertFailure?: 'warn' | 'exit' | 'retry'
 * }} options
 * @param {import('./envelope.js').SentinelEnvelope} envelope
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
        await flushPersistentQueue((queued) => deliverWebhook(options, queued));
      }

      let webhookOk = await deliverWebhook(options, envelope);
      if (!webhookOk && options.onAlertFailure === 'retry') {
        webhookOk = await deliverWebhook({ ...options, webhookRetries: 5 }, envelope);
      }
      if (!webhookOk && options.deliveryMode === 'at-least-once') {
        enqueuePersistent(envelope);
      }
      ok = ok && webhookOk;
    }

    applyFailurePolicy(options, ok);
    return { ok };
  });
}
