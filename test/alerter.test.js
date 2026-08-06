import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { fireAlerts, postWebhook } from '../src/alerter.js';
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

