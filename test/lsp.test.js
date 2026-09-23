import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { PassThrough } from 'stream';
import { pathToFileURL } from 'url';

import { createWorkerExecutor, startLanguageServer } from '../src/lsp.js';
import { analyzeDocument } from '../src/lsp-analysis.js';

const rootIndex = resolve(process.cwd(), 'index.js');

// ---------------------------------------------------------------------------
// A minimal LSP client over any pair of streams

function frame(message) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

/** Reads framed messages from a stream and lets a test wait for one. */
function reader(stream) {
  const messages = [];
  const waiters = [];
  let buffer = Buffer.alloc(0);
  stream.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const length = Number(/Content-Length: (\d+)/u.exec(buffer.subarray(0, headerEnd).toString())?.[1]);
      assert.ok(Number.isInteger(length), `unframed output: ${buffer.toString().slice(0, 80)}`);
      if (buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8'));
      buffer = buffer.subarray(headerEnd + 4 + length);
      messages.push(message);
      for (const waiter of waiters.splice(0)) waiter();
    }
  });
  return {
    messages,
    /** Resolve with the first message (seen or future) matching `predicate`. */
    async next(predicate, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = messages.find(predicate);
        if (found) return found;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`timed out; saw ${JSON.stringify(messages).slice(0, 400)}`);
        await new Promise((wake) => {
          const timer = setTimeout(wake, remaining);
          waiters.push(() => { clearTimeout(timer); wake(); });
        });
      }
    },
  };
}

const diagnosticsFor = (uri, version) => (m) => m.method === 'textDocument/publishDiagnostics'
  && m.params.uri === uri && (version === undefined || m.params.version === version);

// ---------------------------------------------------------------------------
// Protocol behavior, with a scripted executor standing in for the worker

/** An executor whose jobs finish only when the test says so. */
function scriptedExecutor() {
  const jobs = [];
  let cancels = 0;
  return {
    jobs,
    get cancels() { return cancels; },
    run(job) {
      return new Promise((resolveJob) => { jobs.push({ job, finish: resolveJob }); });
    },
    cancel() {
      cancels += 1;
      const running = jobs.find((entry) => !entry.done);
      if (running) { running.done = true; running.finish({ cancelled: true }); }
    },
    dispose() {},
  };
}

function inProcessServer(executor, options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = reader(output);
  const server = startLanguageServer({
    input, output, version: 'test', cwd: '/workspace', settings: {}, debounceMs: 5, executor, log: () => {}, ...options,
  });
  return { input, client, server, send: (message) => input.write(frame(message)) };
}

const uri = pathToFileURL('/workspace/prod.yaml').href;
const open = (text, version = 1) => ({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'yaml', version, text } } });
const change = (text, version) => ({ method: 'textDocument/didChange', params: { textDocument: { uri, version }, contentChanges: [{ text }] } });
const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));

describe('protocol', () => {
  test('requests before initialize are refused; initialize advertises full sync', async () => {
    const { client, send } = inProcessServer(scriptedExecutor());
    send({ id: 1, method: 'textDocument/hover', params: {} });
    assert.equal((await client.next((m) => m.id === 1)).error.code, -32002);
    send({ id: 2, method: 'initialize', params: { rootUri: pathToFileURL('/workspace').href } });
    const init = await client.next((m) => m.id === 2);
    assert.equal(init.result.capabilities.textDocumentSync.change, 1);
    assert.equal(init.result.serverInfo.name, 'flecto');
    send({ id: 3, method: 'textDocument/hover', params: {} });
    assert.equal((await client.next((m) => m.id === 3)).error.code, -32601);
  });

  test('framing survives split chunks, several messages per chunk, and multi-byte text', async () => {
    const executor = scriptedExecutor();
    const { input, client } = inProcessServer(executor);
    const bytes = Buffer.from(frame({ id: 1, method: 'initialize', params: {} }) + frame(open('name: "café ☕"\n')), 'utf8');
    for (let i = 0; i < bytes.length; i += 7) input.write(bytes.subarray(i, i + 7));
    await client.next((m) => m.id === 1);
    for (let i = 0; i < 50 && executor.jobs.length === 0; i++) await sleep(5);
    assert.equal(executor.jobs[0].job.text, 'name: "café ☕"\n');
  });

  test('a burst of edits is analyzed once, at the latest version', async () => {
    const executor = scriptedExecutor();
    const { client, send } = inProcessServer(executor, { debounceMs: 40 });
    send({ id: 1, method: 'initialize', params: {} });
    await client.next((m) => m.id === 1);
    send(open('a: 1\n'));
    for (let version = 2; version <= 6; version++) send(change(`a: ${version}\n`, version));
    await sleep(150);
    assert.equal(executor.jobs.length, 1);
    assert.equal(executor.jobs[0].job.text, 'a: 6\n');
    executor.jobs[0].finish({ diagnostics: [] });
    assert.equal((await client.next(diagnosticsFor(uri))).params.version, 6);
  });

  test('a newer version cancels the running analysis, and a stale result is never published', async () => {
    const executor = scriptedExecutor();
    const { client, send } = inProcessServer(executor);
    send({ id: 1, method: 'initialize', params: {} });
    await client.next((m) => m.id === 1);
    send(open('a: 1\n'));
    for (let i = 0; i < 50 && executor.jobs.length === 0; i++) await sleep(5);
    send(change('a: 2\n', 2));
    for (let i = 0; i < 50 && executor.jobs.length < 2; i++) await sleep(5);
    assert.equal(executor.cancels, 1, 'the version-1 analysis was abandoned');
    assert.equal(executor.jobs[1].job.text, 'a: 2\n');
    executor.jobs[1].finish({ diagnostics: [{ message: 'v2' }] });
    const published = await client.next(diagnosticsFor(uri));
    assert.equal(published.params.version, 2);
    assert.equal(client.messages.filter(diagnosticsFor(uri)).length, 1);
  });

  test('a result for a version that is no longer current is dropped', async () => {
    // An executor that ignores cancel(): the old job finishes normally, late.
    const jobs = [];
    const executor = { run: (job) => new Promise((finish) => jobs.push({ job, finish })), cancel() {}, dispose() {} };
    const { client, send } = inProcessServer(executor);
    send({ id: 1, method: 'initialize', params: {} });
    await client.next((m) => m.id === 1);
    send(open('a: 1\n'));
    for (let i = 0; i < 50 && jobs.length === 0; i++) await sleep(5);
    send(change('a: 2\n', 2));
    await sleep(30);
    jobs[0].finish({ diagnostics: [{ message: 'stale' }] });
    for (let i = 0; i < 50 && jobs.length < 2; i++) await sleep(5);
    jobs[1].finish({ diagnostics: [{ message: 'fresh' }] });
    const published = await client.next(diagnosticsFor(uri));
    assert.equal(published.params.version, 2);
    assert.equal(published.params.diagnostics[0].message, 'fresh');
    assert.ok(!client.messages.some((m) => JSON.stringify(m).includes('stale')));
  });

  test('a timed-out analysis becomes one warning, not a hang', async () => {
    const executor = scriptedExecutor();
    const { client, send } = inProcessServer(executor);
    send({ id: 1, method: 'initialize', params: {} });
    await client.next((m) => m.id === 1);
    send(open('a: 1\n'));
    for (let i = 0; i < 50 && executor.jobs.length === 0; i++) await sleep(5);
    executor.jobs[0].finish({ timedOut: true });
    const published = await client.next(diagnosticsFor(uri));
    assert.equal(published.params.diagnostics[0].code, 'timeout');
    assert.equal(published.params.diagnostics[0].severity, 2);
  });

  test('closing a document clears its diagnostics', async () => {
    const executor = scriptedExecutor();
    const { client, send } = inProcessServer(executor);
    send({ id: 1, method: 'initialize', params: {} });
    await client.next((m) => m.id === 1);
    send(open('a: 1\n'));
    send({ method: 'textDocument/didClose', params: { textDocument: { uri } } });
    const cleared = await client.next(diagnosticsFor(uri));
    assert.deepEqual(cleared.params.diagnostics, []);
    assert.equal('version' in cleared.params, false);
  });

  test('exit after shutdown is 0; exit without it is 1', async () => {
    const first = inProcessServer(scriptedExecutor());
    first.send({ id: 1, method: 'initialize', params: {} });
    first.send({ id: 2, method: 'shutdown' });
    await first.client.next((m) => m.id === 2);
    first.send({ method: 'exit' });
    assert.equal(await first.server.done, 0);

    const second = inProcessServer(scriptedExecutor());
    second.send({ id: 1, method: 'initialize', params: {} });
    second.send({ method: 'exit' });
    assert.equal(await second.server.done, 1);
  });
});

// ---------------------------------------------------------------------------
// Analysis: the same answers `flecto ci` gives, anchored in the text

/** A git repository with `prod.yaml` committed at HEAD. */
function repo(files = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flecto-lsp-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(dir, 'prod.yaml'), 'db:\n  pool_size: 5\n  password: hunter2hunter2\ndebug: false\n');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  git('add', '.');
  git('commit', '-qm', 'init');
  return dir;
}

const EDITED = 'db:\n  pool_size: 20\n  password: rotatedRotated99\ndebug: true\n';
const byCode = (diagnostics, code) => diagnostics.filter((d) => d.code === code);

describe('analysis', () => {
  test('findings and changes land on the lines they are about, and values in hints are masked', async () => {
    const dir = repo();
    try {
      const diagnostics = await analyzeDocument({ root: dir, path: join(dir, 'prod.yaml'), text: EDITED, settings: {} });
      const [pool] = byCode(diagnostics, 'pool-size-jump');
      assert.deepEqual(pool.range, { start: { line: 1, character: 2 }, end: { line: 1, character: 15 } });
      assert.equal(pool.severity, 2);
      const [debug] = byCode(diagnostics, 'dangerous-toggle-enabled');
      assert.equal(debug.range.start.line, 3);
      assert.equal(debug.severity, 1);
      const hints = byCode(diagnostics, 'changed');
      assert.ok(hints.every((d) => d.severity === 4));
      const password = hints.find((d) => d.data.path === 'db.password');
      assert.equal(password.range.start.line, 2);
      assert.ok(!password.message.includes('hunter2') && !password.message.includes('rotated'), password.message);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a file HEAD does not have still gets its findings, and says why there are no change hints', async () => {
    const dir = repo();
    try {
      const diagnostics = await analyzeDocument({ root: dir, path: join(dir, 'new.yaml'), text: 'name: web\npassword: x\n', settings: {} });
      const [secret] = byCode(diagnostics, 'secret-key-changed');
      assert.equal(secret.range.start.line, 1);
      assert.match(byCode(diagnostics, 'baseline')[0].message, /not in HEAD/u);
      assert.equal(byCode(diagnostics, 'added').length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('inline suppressions apply as in CI, and one missing its reason is the error CI fails on', async () => {
    const dir = repo();
    try {
      const text = '# flecto-ignore-next-line dangerous-toggle-enabled — staging mirror\ndebug: true\n# flecto-ignore-next-line pool-size-jump\ndb:\n  pool_size: 20\n  password: hunter2hunter2\n';
      const diagnostics = await analyzeDocument({ root: dir, path: join(dir, 'prod.yaml'), text, settings: {} });
      assert.equal(byCode(diagnostics, 'dangerous-toggle-enabled').length, 0, 'the reasoned suppression applies');
      const [refused] = byCode(diagnostics, 'suppression');
      assert.equal(refused.severity, 1);
      assert.equal(refused.range.start.line, 2);
      assert.match(refused.message, /fails on this/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('plugins declared in .flectorc are never loaded, whatever FLECTO_ALLOW_RC_PLUGINS says', async () => {
    const marker = join(tmpdir(), `flecto-lsp-plugin-ran-${process.pid}`);
    rmSync(marker, { force: true });
    const dir = repo({
      'evil.mjs': `import { writeFileSync } from 'fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport function evaluate() { return []; }\n`,
      '.flectorc': JSON.stringify({ defaults: { plugins: ['./evil.mjs'] } }),
    });
    const previous = process.env.FLECTO_ALLOW_RC_PLUGINS;
    process.env.FLECTO_ALLOW_RC_PLUGINS = '1';
    try {
      const diagnostics = await analyzeDocument({ root: dir, path: join(dir, 'prod.yaml'), text: EDITED, settings: {} });
      assert.equal(existsSync(marker), false, 'the plugin never ran');
      assert.equal(byCode(diagnostics, 'plugins-not-loaded')[0].severity, 2);
      assert.ok(byCode(diagnostics, 'pool-size-jump').length > 0, 'packs still run');
    } finally {
      if (previous === undefined) delete process.env.FLECTO_ALLOW_RC_PLUGINS;
      else process.env.FLECTO_ALLOW_RC_PLUGINS = previous;
      rmSync(marker, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a file .flectorc does not select gets nothing, as CI would not check it', async () => {
    const dir = repo({ '.flectorc': JSON.stringify({ files: ['config/**/*.yaml'] }), 'config/app.yaml': 'debug: false\n' });
    try {
      assert.deepEqual(await analyzeDocument({ root: dir, path: join(dir, 'prod.yaml'), text: EDITED, settings: {} }), []);
      const inside = await analyzeDocument({ root: dir, path: join(dir, 'config', 'app.yaml'), text: 'debug: true\n', settings: {} });
      assert.equal(byCode(inside, 'dangerous-toggle-enabled').length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a finding the --baseline file accepts does not show, exactly as it does not gate', async () => {
    const dir = repo({
      '.flectorc': JSON.stringify({ defaults: { baseline: 'flecto-baseline.json' } }),
      'flecto-baseline.json': JSON.stringify({ version: 1, findings: [{ rule: 'dangerous-toggle-enabled', file: 'prod.yaml', path: 'debug' }] }),
    });
    try {
      const diagnostics = await analyzeDocument({ root: dir, path: join(dir, 'prod.yaml'), text: EDITED, settings: {} });
      assert.equal(byCode(diagnostics, 'dangerous-toggle-enabled').length, 0);
      assert.equal(byCode(diagnostics, 'pool-size-jump').length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a document that does not parse gets one note on the failing line, not stale findings', async () => {
    const dir = repo();
    try {
      const diagnostics = await analyzeDocument({ root: dir, path: join(dir, 'prod.yaml'), text: 'db:\n  pool_size: 5\n bad: [\n', settings: {} });
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].code, 'parse');
      assert.equal(diagnostics[0].severity, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--mask-secrets in .flectorc masks values interpolated into finding messages', async () => {
    const dir = repo({
      '.flectorc': JSON.stringify({ defaults: { maskSecrets: true, policies: ['leak'] } }),
      'policies/leak.json': JSON.stringify({ id: 'leak', rules: [{ id: 'echo', severity: 'warn', match: { path: '^note$' }, messageTemplate: 'note is {after}' }] }),
    });
    try {
      const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
      const diagnostics = await analyzeDocument({ root: dir, path: join(dir, 'prod.yaml'), text: `note: ${token}\n`, settings: {} });
      const [echo] = byCode(diagnostics, 'echo');
      assert.ok(echo, JSON.stringify(diagnostics));
      assert.ok(!echo.message.includes(token), echo.message);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--snapshot-store diffs against the saved snapshot instead of git', async () => {
    const dir = repo();
    try {
      spawnSync(process.execPath, [rootIndex, 'watch', 'prod.yaml', '--snapshot'], { cwd: dir, encoding: 'utf8' });
      const diagnostics = await analyzeDocument({ root: dir, path: join(dir, 'prod.yaml'), text: EDITED, settings: { snapshotStore: 'local' } });
      const hint = byCode(diagnostics, 'changed').find((d) => d.data.path === 'db.pool_size');
      assert.match(hint.message, /from 5 \(the snapshot\) to 20/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// End to end: `flecto lsp` with its real worker

function startCli(dir, args = []) {
  const child = spawn(process.execPath, [rootIndex, 'lsp', '--stdio', '--debounce', '20', ...args], { cwd: dir });
  const client = reader(child.stdout);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((done) => child.on('exit', (code) => done(code)));
  // Windows will not remove a directory a process still holds a handle in, so
  // teardown waits for the server to be gone, not just signalled.
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.race([exited, sleep(5000)]);
  };
  return { child, client, send: (message) => child.stdin.write(frame(message)), exited, stop, stderr: () => stderr };
}

describe('flecto lsp', () => {
  test('publishes diagnostics for an open document and exits cleanly', async () => {
    const dir = repo();
    const server = startCli(dir);
    try {
      const docUri = pathToFileURL(join(dir, 'prod.yaml')).href;
      server.send({ id: 1, method: 'initialize', params: { rootUri: pathToFileURL(dir).href, capabilities: {} } });
      await server.client.next((m) => m.id === 1);
      server.send({ method: 'initialized', params: {} });
      server.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: docUri, languageId: 'yaml', version: 1, text: EDITED } } });
      const published = await server.client.next(diagnosticsFor(docUri, 1), 15000);
      const pool = published.params.diagnostics.find((d) => d.code === 'pool-size-jump');
      assert.equal(pool.range.start.line, 1);
      server.send({ id: 2, method: 'shutdown' });
      await server.client.next((m) => m.id === 2);
      server.send({ method: 'exit' });
      assert.equal(await server.exited, 0);
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a pack regex that used to backtrack forever is now answered, not timed out', async () => {
    // This pattern pinned the worker until the timeout fired, which is what the
    // timeout existed to survive. Pack-supplied regexes compile with RE2 now,
    // so it is answered in microseconds and real diagnostics come back instead.
    const dir = repo({
      '.flectorc': JSON.stringify({ defaults: { policies: ['default', 'slow'] } }),
      'policies/slow.json': JSON.stringify({ id: 'slow', rules: [{ id: 'slow', severity: 'warn', afterMatches: '^(a+)+$', message: 'slow' }] }),
    });
    const server = startCli(dir, ['--timeout', '2000']);
    try {
      const docUri = pathToFileURL(join(dir, 'prod.yaml')).href;
      server.send({ id: 1, method: 'initialize', params: { rootUri: pathToFileURL(dir).href } });
      await server.client.next((m) => m.id === 1);
      server.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: docUri, languageId: 'yaml', version: 1, text: `db:\n  pool_size: 5\nx: ${'a'.repeat(40)}!\n` } } });
      const answered = await server.client.next(diagnosticsFor(docUri, 1), 15000);
      assert.ok(
        !answered.params.diagnostics.some((d) => d.code === 'timeout'),
        `expected no timeout, got ${JSON.stringify(answered.params.diagnostics)}`,
      );
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a worker that hangs costs one warning, and the server keeps working', async () => {
    // The timeout still has to work -- a plugin can loop, and a huge document
    // can be slow -- so it is exercised through a plugin now that a pack regex
    // can no longer hang.
    const dir = repo({
      'hang.mjs': 'export function evaluate(changes) {\n'
      + '  // Hangs only for a document carrying the marker, so the recovery run\n'
      + '  // is fast. Keyed on content rather than a disk latch: the latch file\n'
      + '  // did not hold on Windows, and content needs no filesystem at all.\n'
      + '  if (JSON.stringify(changes).includes("HANGME")) {\n'
      + '    const end = Date.now() + 60000; while (Date.now() < end) {}\n'
      + '  }\n'
      + '  return [];\n'
      + '}\n',
    });
    const server = startCli(dir, ['--timeout', '400', '--plugins', join(dir, 'hang.mjs')]);
    try {
      const docUri = pathToFileURL(join(dir, 'prod.yaml')).href;
      server.send({ id: 1, method: 'initialize', params: { rootUri: pathToFileURL(dir).href } });
      await server.client.next((m) => m.id === 1);
      server.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: docUri, languageId: 'yaml', version: 1, text: 'db:\n  pool_size: 5\nx: HANGME\n' } } });
      const hung = await server.client.next(diagnosticsFor(docUri, 1), 15000);
      assert.equal(hung.params.diagnostics[0].code, 'timeout');

      server.send({ method: 'textDocument/didChange', params: { textDocument: { uri: docUri, version: 2 }, contentChanges: [{ text: EDITED }] } });
      const recovered = await server.client.next(diagnosticsFor(docUri, 2), 15000);
      assert.ok(recovered.params.diagnostics.some((d) => d.code === 'pool-size-jump'));
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stdout carries only JSON-RPC, even when a plugin logs', async () => {
    const dir = repo({ 'noisy.mjs': 'export function evaluate() { console.log("plugin says hi"); return []; }\n' });
    const server = startCli(dir, ['--plugins', join(dir, 'noisy.mjs')]);
    try {
      const docUri = pathToFileURL(join(dir, 'prod.yaml')).href;
      server.send({ id: 1, method: 'initialize', params: { rootUri: pathToFileURL(dir).href } });
      await server.client.next((m) => m.id === 1);
      server.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: docUri, languageId: 'yaml', version: 1, text: EDITED } } });
      await server.client.next(diagnosticsFor(docUri, 1), 15000);
      // reader() asserts every byte on stdout is framed; the log went to stderr.
      for (let i = 0; i < 50 && !server.stderr().includes('plugin says hi'); i++) await sleep(20);
      assert.match(server.stderr(), /plugin says hi/u);
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the job after a timed-out one runs on a fresh worker and is not blamed for the old one exiting', async () => {
    const dir = repo({
      'hang.mjs': 'export function evaluate(changes) {\n'
      + '  // Hangs only for a document carrying the marker, so the recovery run\n'
      + '  // is fast. Keyed on content rather than a disk latch: the latch file\n'
      + '  // did not hold on Windows, and content needs no filesystem at all.\n'
      + '  if (JSON.stringify(changes).includes("HANGME")) {\n'
      + '    const end = Date.now() + 60000; while (Date.now() < end) {}\n'
      + '  }\n'
      + '  return [];\n'
      + '}\n',
    });
    const executor = createWorkerExecutor({ timeoutMs: 300, log: () => {} });
    try {
      const path = join(dir, 'prod.yaml');
      const settings = { plugins: [join(dir, 'hang.mjs')] };
      const hung = await executor.run({ root: dir, path, text: 'x: HANGME\n', settings });
      assert.equal(hung.timedOut, true);
      // Started at once, before the terminated worker has finished exiting.
      const next = await executor.run({ root: dir, path, text: 'x: fine\n', settings });
      assert.ok(Array.isArray(next.diagnostics), JSON.stringify(next));
    } finally {
      executor.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a relative --plugins path is refused: it would resolve inside whatever repository is open', () => {
    const run = spawnSync(process.execPath, [rootIndex, 'lsp', '--plugins', './p.mjs'], { encoding: 'utf8', input: '' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /must be absolute paths/u);
  });
});
