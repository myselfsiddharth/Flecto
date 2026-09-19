import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { createServer } from 'http';

import {
  assertExplainNotFromRc,
  buildExplainPayload,
  buildExplainRequest,
  describeRequest,
  narrate,
  parseProviderResponse,
  resolveExplainConfig,
  sanitizeNarration,
} from '../src/explain.js';
import { renderPrComment } from '../src/pr-comment.js';

const rootIndex = resolve(process.cwd(), 'index.js');
const ESC = String.fromCharCode(27);
const SECRET = 'sup3rS3cretRotatedValue';
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const API_KEY = 'sk-test-KEY-4d1c9e';

/** Payload input with a secret under a secret-looking key and one under a benign key. */
function sampleFiles(cwd) {
  const changes = [
    { type: 'changed', path: 'db.pool_size', before: 5, after: 20 },
    { type: 'changed', path: 'db.password', before: 'hunter2hunter2', after: SECRET },
    { type: 'added', path: 'note', after: TOKEN },
  ];
  return [
    { file: join(cwd, 'config', 'b.yaml'), changes, findings: [
      { id: 'leak', severity: 'error', pack: 'custom', path: 'note', message: `value ${TOKEN} looks like a token` },
    ] },
    { file: join(cwd, 'config', 'a.yaml'), changes: [{ type: 'changed', path: 'debug', before: false, after: true }], findings: [] },
    { file: join(cwd, 'config', 'untouched.yaml'), changes: [], findings: [] },
  ];
}

function anthropicConfig(overrides = {}) {
  return {
    provider: 'anthropic',
    model: 'claude-opus-5',
    apiUrl: 'https://api.anthropic.com',
    apiKey: API_KEY,
    apiKeySource: 'FLECTO_EXPLAIN_API_KEY',
    maxTokens: 16000,
    maxInputTokens: 30000,
    timeoutMs: 5000,
    cacheDir: null,
    ...overrides,
  };
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function okAnthropic(text = '- pool size quadruples') {
  return jsonResponse(200, {
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }],
    usage: { input_tokens: 800, output_tokens: 12 },
  });
}

/** A fetch double that records every call. */
function recordingFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init, calls.length);
  };
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// Payload

test('the payload masks secrets by key name, by value, and inside finding messages', () => {
  const cwd = resolve('/repo');
  const payload = buildExplainPayload(sampleFiles(cwd), { cwd });
  const sent = JSON.stringify(payload);
  assert.ok(!sent.includes(SECRET), 'a value under a secret-looking key is masked');
  assert.ok(!sent.includes('hunter2hunter2'));
  assert.ok(!sent.includes(TOKEN), 'a credential-shaped value is masked under a benign key and in a message');
  assert.match(sent, /"after":20/u, 'ordinary values are kept — they are what narration is about');
});

test('the payload is stable: relative POSIX paths, sorted, unchanged files dropped, no volatile fields', () => {
  const cwd = resolve('/repo');
  const first = buildExplainPayload(sampleFiles(cwd), { cwd });
  const second = buildExplainPayload(sampleFiles(cwd).reverse(), { cwd });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.files.map((f) => f.file), ['config/a.yaml', 'config/b.yaml']);
  assert.doesNotMatch(JSON.stringify(first), /event_id|emitted_at|batch_id/u);
});

test('encrypted values reach the payload as sentinels, never as ciphertext', () => {
  const payload = buildExplainPayload([{
    file: 'secrets.yaml',
    changes: [{ type: 'changed', path: 'db.password', before: '<encrypted:sops:0123456789ab>', after: '<encrypted:sops:ba9876543210>' }],
    findings: [],
  }], { cwd: '/' });
  const change = payload.files[0].changes[0];
  // Masked by key name here; a benign key keeps the sentinel itself.
  assert.equal(change.after, '***');
  const benign = buildExplainPayload([{
    file: 'app.yaml',
    changes: [{ type: 'changed', path: 'blob', before: '<encrypted:age:0123456789ab>', after: '<encrypted:age:ba9876543210>' }],
    findings: [],
  }], { cwd: '/' });
  assert.equal(benign.files[0].changes[0].after, '<encrypted:age:ba9876543210>');
});

// ---------------------------------------------------------------------------
// Configuration

test('narration needs an explicit provider, and anthropic needs a key', () => {
  assert.match(resolveExplainConfig({}, {}).reason, /no provider configured/u);
  assert.match(resolveExplainConfig({}, { FLECTO_EXPLAIN_PROVIDER: 'acme' }).reason, /unknown provider/u);
  assert.match(resolveExplainConfig({ provider: 'anthropic' }, {}).reason, /no API key/u);
  assert.equal(resolveExplainConfig({ provider: 'anthropic' }, {}, { dryRun: true }).ok, true,
    'a dry run can be inspected before a key exists');
});

test('config: CLI beats env, anthropic defaults to claude-opus-5, openai names its model', () => {
  const env = { FLECTO_EXPLAIN_PROVIDER: 'anthropic', FLECTO_EXPLAIN_MODEL: 'claude-sonnet-5', ANTHROPIC_API_KEY: 'k1' };
  const fromEnv = resolveExplainConfig({}, env);
  assert.equal(fromEnv.config.model, 'claude-sonnet-5');
  assert.equal(fromEnv.config.apiKeySource, 'ANTHROPIC_API_KEY');
  assert.equal(resolveExplainConfig({ model: 'claude-haiku-4-5' }, env).config.model, 'claude-haiku-4-5');
  assert.equal(resolveExplainConfig({ provider: 'anthropic' }, { ANTHROPIC_API_KEY: 'k' }).config.model, 'claude-opus-5');

  const flectoKeyWins = resolveExplainConfig({}, { ...env, FLECTO_EXPLAIN_API_KEY: 'k2' });
  assert.equal(flectoKeyWins.config.apiKey, 'k2');

  assert.match(resolveExplainConfig({ provider: 'openai' }, {}).reason, /no default model/u);
  const local = resolveExplainConfig({ provider: 'openai', model: 'llama3' }, { FLECTO_EXPLAIN_API_URL: 'http://127.0.0.1:11434/v1/' });
  assert.equal(local.ok, true, 'a local OpenAI-compatible server may take no key');
  assert.equal(local.config.apiUrl, 'http://127.0.0.1:11434/v1');
});

test('config: FLECTO_EXPLAIN=0 is a runner-wide kill switch', () => {
  for (const value of ['0', 'false', 'off']) {
    const resolved = resolveExplainConfig({ provider: 'anthropic' }, { FLECTO_EXPLAIN: value, ANTHROPIC_API_KEY: 'k' });
    assert.equal(resolved.ok, false);
    assert.match(resolved.reason, /disabled on this runner/u);
  }
});

test('config: malformed numbers and URLs are refused rather than guessed', () => {
  const base = { FLECTO_EXPLAIN_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' };
  assert.match(resolveExplainConfig({ maxTokens: 'lots' }, base).reason, /positive integer/u);
  assert.match(resolveExplainConfig({}, { ...base, FLECTO_EXPLAIN_TIMEOUT_MS: '-1' }).reason, /positive integer/u);
  assert.match(resolveExplainConfig({}, { ...base, FLECTO_EXPLAIN_API_URL: 'file:///etc/passwd' }).reason, /http or https/u);
});

test('explain options declared in .flectorc or a profile are refused; the CLI is allowed', () => {
  assert.throws(() => assertExplainNotFromRc({ explain: true }, {}), /Refusing "explain" declared in \.flectorc/u);
  assert.throws(() => assertExplainNotFromRc({ explainDryRun: true }, {}), /explainDryRun/u);
  assert.doesNotThrow(() => assertExplainNotFromRc({ explain: true }, { explain: true }));
  assert.doesNotThrow(() => assertExplainNotFromRc({ format: 'json', model: 'x' }, {}));
});

// ---------------------------------------------------------------------------
// Request shape

test('anthropic request: Messages API shape, no sampling parameters, fallbacks only first-party', () => {
  const payload = buildExplainPayload(sampleFiles('/repo'), { cwd: '/repo' });
  const request = buildExplainRequest(payload, anthropicConfig());
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], API_KEY);
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(request.body.fallbacks, 'default');
  assert.equal(request.body.max_tokens, 16000);
  for (const param of ['temperature', 'top_p', 'top_k']) assert.equal(param in request.body, false);
  assert.match(request.body.messages[0].content, /<<<FLECTO_DIFF[\s\S]*FLECTO_DIFF>>>/u);

  const proxied = buildExplainRequest(payload, anthropicConfig({ apiUrl: 'https://llm-proxy.internal' }));
  assert.equal(proxied.headers['anthropic-beta'], undefined, 'a proxy may reject the beta header');
  assert.equal(proxied.body.fallbacks, undefined);

  const older = buildExplainRequest(payload, anthropicConfig({ model: 'claude-haiku-4-5' }));
  assert.equal(older.body.fallbacks, undefined);
});

test('openai-compatible request: chat completions with a bearer key only when one exists', () => {
  const payload = buildExplainPayload(sampleFiles('/repo'), { cwd: '/repo' });
  const config = anthropicConfig({ provider: 'openai', model: 'gpt-x', apiUrl: 'https://api.openai.com/v1', apiKeySource: 'OPENAI_API_KEY' });
  const request = buildExplainRequest(payload, config);
  assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
  assert.deepEqual(request.body.messages.map((m) => m.role), ['system', 'user']);
  const keyless = buildExplainRequest(payload, { ...config, apiKey: null, apiKeySource: null });
  assert.equal(keyless.headers.authorization, undefined);
});

test('the printable request names where the key comes from and never carries it', () => {
  const payload = buildExplainPayload(sampleFiles('/repo'), { cwd: '/repo' });
  const config = anthropicConfig();
  const shown = JSON.stringify(describeRequest(buildExplainRequest(payload, config), config));
  assert.ok(!shown.includes(API_KEY));
  assert.match(shown, /<FLECTO_EXPLAIN_API_KEY>/u);
});

// ---------------------------------------------------------------------------
// narrate(): every failure is a result, never a throw

test('narrate returns the text blocks only, and never follows a redirect', async () => {
  const { fetchImpl, calls } = recordingFetch(() => okAnthropic('- pool size quadruples'));
  const payload = buildExplainPayload(sampleFiles('/repo'), { cwd: '/repo' });
  const result = await narrate(payload, anthropicConfig(), { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.text, '- pool size quadruples');
  assert.equal(result.cached, false);
  assert.deepEqual(result.usage, { input: 800, output: 12 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.ok(!calls[0].init.body.includes(SECRET));
});

test('narrate refuses a redirect rather than forwarding x-api-key to it', async () => {
  const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 307, headers: { location: 'https://evil.example/steal' } }));
  const result = await narrate(buildExplainPayload(sampleFiles('/r'), { cwd: '/r' }), anthropicConfig(), { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.reason, /redirect \(HTTP 307\)/u);
  assert.equal(calls.length, 1);
});

test('narrate degrades on refusal, HTTP errors, network errors, timeouts, and empty answers', async () => {
  const payload = buildExplainPayload(sampleFiles('/r'), { cwd: '/r' });
  const cases = [
    [() => jsonResponse(200, { stop_reason: 'refusal', content: [] }), /declined/u],
    [() => jsonResponse(401, { type: 'error', error: { type: 'authentication_error', message: `bad key ${API_KEY}` } }), /HTTP 401: bad key \*\*\*/u],
    [() => { throw new TypeError(`connect failed for ${API_KEY}`); }, /request failed: connect failed for \*\*\*/u],
    [() => jsonResponse(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: '   ' }] }), /no text/u],
    [() => new Response('<html>', { status: 200 }), /not JSON/u],
  ];
  for (const [respond, expected] of cases) {
    const { fetchImpl } = recordingFetch(respond);
    const result = await narrate(payload, anthropicConfig(), { fetchImpl });
    assert.equal(result.ok, false);
    assert.match(result.reason, expected);
    assert.ok(!result.reason.includes(API_KEY));
  }

  const hanging = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const timedOut = await narrate(payload, anthropicConfig({ timeoutMs: 20 }), { fetchImpl: hanging });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.reason, /timed out after 20ms/u);
});

test('narrate enforces the input budget before any request is made', async () => {
  const { fetchImpl, calls } = recordingFetch(() => okAnthropic());
  const result = await narrate(buildExplainPayload(sampleFiles('/r'), { cwd: '/r' }), anthropicConfig({ maxInputTokens: 10 }), { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.reason, /over the budget of 10/u);
  assert.equal(calls.length, 0);
});

test('a response cut off at max_tokens is marked truncated', async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(200, { stop_reason: 'max_tokens', content: [{ type: 'text', text: '- partial' }] }));
  const result = await narrate(buildExplainPayload(sampleFiles('/r'), { cwd: '/r' }), anthropicConfig(), { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
});

test('openai-compatible responses are parsed from choices[0]', () => {
  const parsed = parseProviderResponse('openai', {
    model: 'llama3',
    choices: [{ message: { content: '- check limits' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 10, completion_tokens: 3 },
  });
  assert.deepEqual(parsed, { ok: true, text: '- check limits', truncated: true, model: 'llama3', usage: { input: 10, output: 3 } });
});

// ---------------------------------------------------------------------------
// Cache

test('identical input is served from the cache: same prose, no second request', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'flecto-explain-cache-'));
  try {
    const payload = buildExplainPayload(sampleFiles('/r'), { cwd: '/r' });
    const { fetchImpl, calls } = recordingFetch((url, init, n) => okAnthropic(`- answer ${n}`));
    const first = await narrate(payload, anthropicConfig({ cacheDir }), { fetchImpl });
    const second = await narrate(payload, anthropicConfig({ cacheDir }), { fetchImpl });
    assert.equal(calls.length, 1);
    assert.equal(second.cached, true);
    assert.equal(second.text, first.text);

    const changed = buildExplainPayload([{ file: 'x.yaml', changes: [{ type: 'changed', path: 'a', before: 1, after: 2 }], findings: [] }], { cwd: '/' });
    await narrate(changed, anthropicConfig({ cacheDir }), { fetchImpl });
    assert.equal(calls.length, 2, 'a different diff is a different entry');
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('cache entries are keyed with the API key, so nobody without it can supply one', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'flecto-explain-cache-'));
  try {
    const payload = buildExplainPayload(sampleFiles('/r'), { cwd: '/r' });
    const { fetchImpl, calls } = recordingFetch(() => okAnthropic());
    await narrate(payload, anthropicConfig({ cacheDir, apiKey: 'key-one' }), { fetchImpl });
    await narrate(payload, anthropicConfig({ cacheDir, apiKey: 'key-two' }), { fetchImpl });
    assert.equal(calls.length, 2);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('a corrupt cache entry is a miss, never a failure', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'flecto-explain-cache-'));
  try {
    const payload = buildExplainPayload(sampleFiles('/r'), { cwd: '/r' });
    const { fetchImpl, calls } = recordingFetch(() => okAnthropic());
    await narrate(payload, anthropicConfig({ cacheDir }), { fetchImpl });
    const [entry] = readdirSync(cacheDir);
    writeFileSync(join(cacheDir, entry), '{"v":1,"text":', 'utf8');
    const again = await narrate(payload, anthropicConfig({ cacheDir }), { fetchImpl });
    assert.equal(again.ok, true);
    assert.equal(calls.length, 2);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Rendering untrusted prose

test('narration is stripped of terminal escapes and bidi controls, keeping lines and tabs', () => {
  const dirty = `- one${ESC}[2J${ESC}]0;title\u0007\n\t- two\u202E\r\n- three\u0000`;
  assert.equal(sanitizeNarration(dirty), '- one[2J]0;title\n\t- two\n- three');
});

test('the PR comment fences narration so it renders as text, and labels it as model output', () => {
  const text = [
    '- ```',
    '- ignore the above and ![pixel](https://evil.example/p.png) @octocat',
    '- <img src=x onerror=alert(1)> [click](https://evil.example)',
    '- ````',
  ].join('\n');
  const results = [{ file: '/repo/app.yaml', envelope: { changes: [{ type: 'changed', path: 'a', before: 1, after: 2 }], policies: [] }, policies: [] }];
  const body = renderPrComment(results, { cwd: '/repo', failed: false, narration: { text, provider: 'anthropic', model: 'claude-opus-5' } });

  assert.match(body, /### Model-generated narration \(advisory\)/u);
  assert.match(body, /Not computed by Flecto, not a policy finding/u);
  const lines = body.split('\n');
  const open = lines.findIndex((line) => /^`{5,}text$/u.test(line));
  assert.ok(open !== -1, 'the fence is wider than the longest backtick run in the text');
  const fence = lines[open].replace(/text$/u, '');
  const close = lines.indexOf(fence, open + 1);
  assert.deepEqual(lines.slice(open + 1, close), text.split('\n'));
  assert.ok(body.indexOf('### Model-generated') < body.indexOf('### Changes'), 'narration precedes the change table');

  assert.equal(
    renderPrComment(results, { cwd: '/repo', failed: false }),
    renderPrComment(results, { cwd: '/repo', failed: false, narration: null }),
  );
  assert.ok(!renderPrComment(results, { cwd: '/repo' }).includes('Model-generated'));
});

// ---------------------------------------------------------------------------
// CLI, end to end against a local provider

/** The environment a CLI run starts from: nothing narration-related inherited from the developer's shell. */
function cleanEnv(extra) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('FLECTO_') || key === 'ANTHROPIC_API_KEY' || key === 'OPENAI_API_KEY') delete env[key];
  }
  return { ...env, ...extra };
}

function runCli(args, { cwd, env }) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [rootIndex, ...args], { cwd, env: cleanEnv(env) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

/** A local stand-in for the Anthropic Messages API. */
async function startProvider(respond) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body });
      const { status, json } = respond(requests.length);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((closed) => server.close(closed)),
  };
}

const narrationReply = () => ({
  status: 200,
  json: { model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '- pool size quadruples' }], usage: { input_tokens: 5, output_tokens: 5 } },
});

/** A project whose prod.yaml changed a pool size and rotated a password, against a snapshot file. */
function fixtureProject() {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-explain-cli-'));
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify({ state: { db: { pool_size: 5, password: 'hunter2hunter2' }, debug: false } }), 'utf8');
  writeFileSync(join(dir, 'prod.yaml'), `db:\n  pool_size: 20\n  password: ${SECRET}\ndebug: false\n`, 'utf8');
  return dir;
}

function providerEnv(provider, dir) {
  return {
    FLECTO_EXPLAIN_PROVIDER: 'anthropic',
    FLECTO_EXPLAIN_API_KEY: API_KEY,
    FLECTO_EXPLAIN_API_URL: provider.url,
    FLECTO_EXPLAIN_CACHE_DIR: join(dir, '.cache-outside-test'),
  };
}

test('flecto explain sends only the masked diff and labels the answer as model output', async () => {
  const dir = fixtureProject();
  const provider = await startProvider(narrationReply);
  try {
    const run = await runCli(['explain', 'prod.yaml', '--snapshot-ref', 'snapshot.json'], { cwd: dir, env: providerEnv(provider, dir) });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(provider.requests.length, 1);
    const [request] = provider.requests;
    assert.equal(request.url, '/v1/messages');
    assert.equal(request.headers['x-api-key'], API_KEY);
    assert.ok(!request.body.includes(SECRET), 'the rotated password never leaves the process');
    assert.ok(!request.body.includes('hunter2hunter2'));
    assert.match(request.body, /pool_size/u);
    assert.match(run.stdout, /Model-generated narration \(anthropic claude-opus-5\) — advisory, not computed by Flecto/u);
    assert.match(run.stdout, /- pool size quadruples/u);
    assert.match(run.stderr, /input tokens \(estimated\)/u, 'the cost is stated before the call');
  } finally {
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flecto explain --dry-run prints the request and sends nothing', async () => {
  const dir = fixtureProject();
  const provider = await startProvider(narrationReply);
  try {
    const run = await runCli(['explain', 'prod.yaml', '--snapshot-ref', 'snapshot.json', '--dry-run', '--format', 'json'], { cwd: dir, env: providerEnv(provider, dir) });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(provider.requests.length, 0);
    const shown = JSON.parse(run.stdout);
    assert.equal(shown.method, 'POST');
    assert.equal(shown.headers['x-api-key'], '<FLECTO_EXPLAIN_API_KEY>');
    assert.ok(!run.stdout.includes(API_KEY));
    assert.ok(!run.stdout.includes(SECRET));
  } finally {
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flecto explain with no provider configured is a usage error', async () => {
  const dir = fixtureProject();
  try {
    const run = await runCli(['explain', 'prod.yaml', '--snapshot-ref', 'snapshot.json'], { cwd: dir, env: {} });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no provider configured/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flecto explain ignores format and model declared in .flectorc for other commands', async () => {
  const dir = fixtureProject();
  const provider = await startProvider(narrationReply);
  try {
    writeFileSync(join(dir, '.flectorc'), JSON.stringify({ defaults: { format: 'sarif', model: 'attacker-model', provider: 'openai' } }), 'utf8');
    const run = await runCli(['explain', 'prod.yaml', '--snapshot-ref', 'snapshot.json'], { cwd: dir, env: providerEnv(provider, dir) });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(provider.requests[0].body).model, 'claude-opus-5');
  } finally {
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci --explain never changes the exit code, and stdout stays machine output', async () => {
  const dir = fixtureProject();
  const provider = await startProvider(narrationReply);
  try {
    const failing = await runCli(['ci', 'prod.yaml', '--snapshot-ref', 'snapshot.json', '--explain'], { cwd: dir, env: providerEnv(provider, dir) });
    assert.equal(failing.status, 1, 'the gate still fails on a change');
    const [result] = JSON.parse(failing.stdout);
    assert.equal(result.envelope.schema_version, '2.0');
    assert.match(failing.stderr, /Model-generated narration/u);

    const broken = await startProvider(() => ({ status: 500, json: { type: 'error', error: { type: 'api_error', message: 'boom' } } }));
    try {
      const passing = await runCli(
        ['ci', 'prod.yaml', '--snapshot-ref', 'snapshot.json', '--explain', '--fail-on', ''],
        { cwd: dir, env: { ...providerEnv(broken, dir), FLECTO_EXPLAIN_CACHE_DIR: join(dir, 'other-cache') } },
      );
      assert.equal(passing.status, 0, 'a provider failure never fails the run');
      assert.match(passing.stderr, /No narration: the anthropic API returned HTTP 500: boom/u);
    } finally {
      await broken.close();
    }
  } finally {
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci --explain --format pr-comment puts the narration in the comment body', async () => {
  const dir = fixtureProject();
  const provider = await startProvider(narrationReply);
  try {
    const run = await runCli(['ci', 'prod.yaml', '--snapshot-ref', 'snapshot.json', '--explain', '--format', 'pr-comment'], { cwd: dir, env: providerEnv(provider, dir) });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /### Model-generated narration \(advisory\)\n/u);
    assert.match(run.stdout, /```text\n- pool size quadruples\n```/u);
  } finally {
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('.flectorc cannot switch narration on, from defaults or a profile', async () => {
  const dir = fixtureProject();
  const provider = await startProvider(narrationReply);
  try {
    for (const rc of [{ defaults: { explain: true } }, { profiles: { ci: { explainDryRun: true } } }]) {
      writeFileSync(join(dir, '.flectorc'), JSON.stringify(rc), 'utf8');
      const run = await runCli(['ci', 'prod.yaml', '--snapshot-ref', 'snapshot.json', '--profile', 'ci'], { cwd: dir, env: providerEnv(provider, dir) });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /Refusing "explain(DryRun)?" declared in \.flectorc/u);
    }
    assert.equal(provider.requests.length, 0);
  } finally {
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
