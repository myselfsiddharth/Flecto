import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { fireAlerts, postWebhook } from '../src/alerter.js';
import { createEnvelope } from '../src/envelope.js';

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

