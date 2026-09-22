import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fireAlerts, postWebhook, runCommand, redactWebhookUrl } from '../src/alerter.js';
import { createEnvelope } from '../src/envelope.js';
import { maskChangeEvent } from '../src/renderer.js';

/**
 * Start a webhook receiver that records the raw request body and headers.
 * @param {{ status?: number }} [opts]
 */
async function startRecordingServer(opts = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ body, headers: req.headers });
      res.statusCode = opts.status ?? 200;
      res.end('ok');
    });
  });
  await new Promise((ready) => server.listen(0, ready));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/hook`,
    close: () => new Promise((done) => server.close(done)),
  };
}

test('postWebhook sends envelope and succeeds on 200', async () => {
  let received = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received = JSON.parse(body);
      res.statusCode = 200;
      res.end('ok');
    });
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}/hook`;
  const envelope = createEnvelope({
    source: 'watch',
    file: '/tmp/config.yaml',
    changes: [{ type: 'changed', path: 'a', before: 1, after: 2 }],
  });

  const ok = await postWebhook(url, envelope, { timeoutMs: 2000, retries: 0 });
  await new Promise((resolve) => server.close(resolve));

  assert.equal(ok, true);
  assert.equal(received.event_id, envelope.event_id);
  assert.equal(received.file, '/tmp/config.yaml');
});

test('fireAlerts returns its delivery result', async () => {
  const envelope = createEnvelope({
    source: 'watch',
    file: '/tmp/config.yaml',
    changes: [],
  });

  const result = await fireAlerts({}, envelope);

  assert.deepEqual(result, { ok: true });
});

test('fireAlerts reports failed webhook delivery', async () => {
  const server = createServer((_req, res) => {
    res.statusCode = 400;
    res.end('bad request');
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const envelope = createEnvelope({
    source: 'watch',
    file: '/tmp/config.yaml',
    changes: [],
  });

  const result = await fireAlerts({
    webhook: `http://127.0.0.1:${addr.port}/hook`,
    webhookRetries: 0,
  }, envelope);
  await new Promise((resolve) => server.close(resolve));

  assert.deepEqual(result, { ok: false });
});

test('default delivery posts the envelope byte-for-byte', async () => {
  const server = await startRecordingServer();
  const envelope = createEnvelope({
    source: 'watch',
    file: '/tmp/config.yaml',
    changes: [{ type: 'changed', path: 'database.pool_size', before: 5, after: 20 }],
    policies: [{
      id: 'pool-size-jump',
      severity: 'warn',
      path: 'database.pool_size',
      message: 'Pool size increased from 5 to 20 (>=2x).',
      pack: 'default',
    }],
  });

  // No format anywhere: neither postWebhook nor fireAlerts may reshape the body.
  const posted = await postWebhook(server.url, envelope, { timeoutMs: 2_000, retries: 0 });
  const fired = await fireAlerts({ webhook: server.url, webhookRetries: 0 }, envelope);
  await server.close();

  assert.equal(posted, true);
  assert.deepEqual(fired, { ok: true });
  assert.equal(server.requests.length, 2);
  for (const request of server.requests) {
    assert.equal(request.body, JSON.stringify(envelope));
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.headers['x-flecto-event-id'], envelope.event_id);
    assert.equal(request.headers['x-flecto-schema'], envelope.schema_version);
  }
});

test('webhookFormat reshapes only the body, keeping headers and retries', async () => {
  const server = await startRecordingServer();
  const envelope = createEnvelope({
    source: 'watch',
    file: '/tmp/config.yaml',
    changes: [{ type: 'changed', path: 'database.pool_size', before: 5, after: 20 }],
    policies: [{
      id: 'pool-size-jump',
      severity: 'error',
      path: 'database.pool_size',
      message: 'Pool size increased from 5 to 20 (>=2x).',
      pack: 'default',
    }],
  });

  for (const format of ['slack', 'discord', 'teams']) {
    const result = await fireAlerts({
      webhook: server.url,
      webhookRetries: 0,
      webhookFormat: format,
    }, envelope);
    assert.deepEqual(result, { ok: true });
  }
  await server.close();

  const [slack, discord, teams] = server.requests.map((r) => JSON.parse(r.body));
  assert.ok(Array.isArray(slack.blocks));
  assert.equal(discord.embeds[0].color, 0xd92d20);
  assert.equal(teams['@type'], 'MessageCard');
  for (const request of server.requests) {
    assert.equal(request.headers['x-flecto-event-id'], envelope.event_id);
    assert.equal(request.headers['x-flecto-batch-id'], envelope.batch_id);
    assert.doesNotMatch(request.body, /schema_version/);
  }
});

test('masked change values reach the chat payload that is posted', async () => {
  const server = await startRecordingServer();
  // Same shape index.js builds when --mask-secrets-webhooks is set.
  const envelope = createEnvelope({
    source: 'watch',
    file: '/tmp/.env',
    changes: [
      { type: 'changed', path: 'database', before: { password: 'old' }, after: { password: 's3cr3t-pw' } },
    ].map(maskChangeEvent),
  });

  const result = await fireAlerts({
    webhook: server.url,
    webhookRetries: 0,
    webhookFormat: 'slack',
  }, envelope);
  await server.close();

  assert.deepEqual(result, { ok: true });
  assert.equal(server.requests.length, 1);
  assert.doesNotMatch(server.requests[0].body, /s3cr3t-pw/);
  assert.match(server.requests[0].body, /\*\*\*/);
});

test('fireAlerts surfaces queue errors and recovers the queue', async () => {
  const circular = {};
  circular.self = circular;
  const malformedEnvelope = createEnvelope({
    source: 'watch',
    file: '/tmp/config.yaml',
    changes: circular,
  });

  await assert.rejects(
    fireAlerts({ webhook: 'http://127.0.0.1:1/hook' }, malformedEnvelope),
    /circular structure/i,
  );

  const result = await fireAlerts({}, createEnvelope({
    source: 'watch',
    file: '/tmp/config.yaml',
    changes: [],
  }));
  assert.deepEqual(result, { ok: true });
});


// --- Hardening of the three alerter findings (#121) -------------------------
// Each of these fails on the code as it stood before: the URL appeared whole in
// the warning, the queue delivered to whatever endpoint ran next, and the spill
// file was left behind world-readable.

test('a failed delivery does not print the webhook URL, which is itself a credential', async () => {
  // A Slack incoming webhook keeps its secret in the path, so a transient 500
  // used to copy that secret into the CI log.
  const server = await startRecordingServer({ status: 500 });
  const secretUrl = `${server.url.replace('/hook', '')}/services/T00000000/B00000000/SUPERSECRETTOKEN`;
  const warnings = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    warnings.push(String(chunk));
    return originalWrite(chunk, ...rest);
  };
  try {
    await postWebhook(secretUrl, createEnvelope({ file: 'a.yaml', changes: [], source: 'watch' }), { retries: 0 });
  } finally {
    process.stderr.write = originalWrite;
    await server.close();
  }
  const printed = warnings.join('');
  assert.ok(!printed.includes('SUPERSECRETTOKEN'), `secret leaked into: ${printed}`);
  assert.ok(printed.includes('127.0.0.1'), 'but the operator can still tell which endpoint failed');
});

test('redactWebhookUrl keeps the origin and drops userinfo, path, and query', () => {
  assert.equal(redactWebhookUrl('https://hooks.slack.com/services/T0/B0/XYZ'), 'https://hooks.slack.com/...');
  assert.equal(redactWebhookUrl('https://user:pass@example.com/x?token=abc'), 'https://example.com/...');
  assert.equal(redactWebhookUrl('https://example.com'), 'https://example.com');
  assert.equal(redactWebhookUrl('not a url'), '<webhook>');
});

test('a queued event is never delivered to a different endpoint', async () => {
  // The exploit shape: queue while pointed at A, then run pointed at B.
  const dir = mkdtempSync(join(tmpdir(), 'flecto-queue-'));
  const cwd = process.cwd();
  process.chdir(dir);
  const down = await startRecordingServer();
  const downUrl = down.url;
  await down.close(); // nothing is listening, so delivery fails and queues

  const other = await startRecordingServer();
  try {
    const opts = { deliveryMode: 'at-least-once', webhookRetries: 0, webhookTimeoutMs: 300 };
    await fireAlerts(
      { ...opts, webhook: downUrl },
      createEnvelope({ file: 'secret.yaml', changes: [{ type: 'changed', path: 'db.password' }], source: 'watch' }),
    );
    // Now a run configured for a completely different destination.
    await fireAlerts(
      { ...opts, webhook: other.url },
      createEnvelope({ file: 'b.yaml', changes: [], source: 'watch' }),
    );
    const bodies = other.requests.map((r) => r.body).join('');
    assert.ok(!bodies.includes('secret.yaml'), 'the event queued for the first endpoint reached the second');
    assert.equal(other.requests.length, 1, 'only its own event was delivered');
  } finally {
    await other.close();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a queued event is still delivered to the endpoint it was addressed to', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-queue-same-'));
  const cwd = process.cwd();
  process.chdir(dir);
  const first = await startRecordingServer();
  const url = first.url;
  await first.close();

  try {
    const opts = { webhook: url, deliveryMode: 'at-least-once', webhookRetries: 0, webhookTimeoutMs: 300 };
    await fireAlerts(opts, createEnvelope({ file: 'queued.yaml', changes: [], source: 'watch' }));

    // Same port, so the same destination fingerprint: the backlog must flush.
    const revived = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { revived.seen.push(body); res.statusCode = 200; res.end('ok'); });
    });
    revived.seen = [];
    await new Promise((ready) => revived.listen(new URL(url).port, ready));
    try {
      await fireAlerts(opts, createEnvelope({ file: 'live.yaml', changes: [], source: 'watch' }));
      const seen = revived.seen.join('');
      assert.ok(seen.includes('queued.yaml'), 'the backlog was flushed');
      assert.ok(seen.includes('live.yaml'), 'and the new event went too');
    } finally {
      await new Promise((done) => revived.close(done));
    }
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an oversized change set is spilled 0600 and removed once the command exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-spill-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const changes = Array.from({ length: 2000 }, (_, i) => ({
      type: 'changed', path: `svc.key${i}`, before: 'x'.repeat(20), after: 'AKIAIOSFODNN7EXAMPLE',
    }));
    const envelope = createEnvelope({ file: 'big.yaml', changes, source: 'watch' });
    const probe = join(dir, 'mode.txt');
    // The command records the spill file's mode while it still exists.
    const ok = await runCommand(
      process.platform === 'win32'
        ? `node -e "require('fs').writeFileSync(process.argv[1], 'skipped')" ${JSON.stringify(probe)}`
        : `stat -f '%Lp' "$FLECTO_CHANGES_FILE" > ${JSON.stringify(probe)} 2>/dev/null || stat -c '%a' "$FLECTO_CHANGES_FILE" > ${JSON.stringify(probe)}`,
      envelope,
    );
    assert.equal(ok, true);
    if (process.platform !== 'win32') {
      assert.equal(readFileSync(probe, 'utf8').trim(), '600', 'the spill file is owner-only');
    }
    const leftovers = existsSync('.flecto-tmp') ? readdirSync('.flecto-tmp') : [];
    assert.deepEqual(leftovers, [], 'and nothing is left on disk afterwards');
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
