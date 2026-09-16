import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  existsSync,
} from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync, execFileSync } from 'child_process';

import {
  TOOLS,
  assertSafeTargetArg,
  bound,
  createServer,
  DEFAULT_PROTOCOL_VERSION,
} from '../src/mcp.js';

const ROOT_INDEX = resolve(process.cwd(), 'index.js');

/**
 * A fake `runFlecto` that records the argv it was handed and replies with a
 * canned `ci --format json` payload. It lets the protocol and validation layers
 * be tested without spawning anything — and lets a test assert exactly which CLI
 * arguments a tool call produced, which is where the read-only guarantee lives.
 * @param {Array<{ file: string, envelope: any, policies?: any[] }>} results
 */
function fakeRunner(results = []) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    return { status: 0, stdout: JSON.stringify(results), stderr: '' };
  };
  run.calls = calls;
  return run;
}

function server(runFlecto, cwd = '/repo') {
  return createServer({ version: '9.9.9', cwd, runFlecto });
}

describe('MCP protocol handshake (#140)', () => {
  test('initialize echoes the client protocol version and names the server', async () => {
    const res = await server(fakeRunner()).handle({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    });
    assert.equal(res.result.protocolVersion, '2025-06-18');
    assert.equal(res.result.serverInfo.name, 'flecto');
    assert.deepEqual(res.result.capabilities, { tools: {} });
  });

  test('initialize falls back to a default protocol version', async () => {
    const res = await server(fakeRunner()).handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(res.result.protocolVersion, DEFAULT_PROTOCOL_VERSION);
  });

  test('tools/list advertises exactly the three read-only tools', async () => {
    const res = await server(fakeRunner()).handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(res.result.tools.map((t) => t.name), ['flecto_diff', 'flecto_check', 'flecto_explain']);
    for (const tool of res.result.tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
  });

  test('a notification (no id) gets no response', async () => {
    const res = await server(fakeRunner()).handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(res, null);
  });

  test('an unknown method is a method-not-found error', async () => {
    const res = await server(fakeRunner()).handle({ jsonrpc: '2.0', id: 3, method: 'no/such' });
    assert.equal(res.error.code, -32601);
  });

  test('a malformed message is an invalid-request error', async () => {
    const res = await server(fakeRunner()).handle({ id: 4, method: 'ping' });
    assert.equal(res.error.code, -32600);
  });
});

describe('MCP tools are read-only and mask by default (#140)', () => {
  const sample = [{
    file: '/repo/config/prod.yaml',
    envelope: { changes: [{ type: 'changed', path: 'database.pool_size', before: 5, after: 20 }] },
    policies: [{ id: 'pool-size-jump', severity: 'warn', path: 'database.pool_size', message: 'up' }],
  }];

  async function call(runFlecto, name, args) {
    const res = await server(runFlecto).handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
    });
    return res.result;
  }

  test('flecto_diff runs read-only ci against HEAD and masks by default', async () => {
    const runner = fakeRunner(sample);
    const result = await call(runner, 'flecto_diff', { file: 'config/prod.yaml' });
    const args = runner.calls[0];

    // The one place tool input becomes argv: assert what it may and may not contain.
    assert.equal(args[0], 'ci');
    assert.deepEqual(args.slice(args.indexOf('--') + 1), ['config/prod.yaml'], 'files only ever follow "--"');
    const options = args.slice(1, args.indexOf('--'));
    assert.ok(options.includes('--snapshot-ref=HEAD'));
    assert.ok(options.includes('--mask-secrets'), 'masking is on by default');
    assert.ok(options.includes('--format') && options[options.indexOf('--format') + 1] === 'json');
    for (const forbidden of ['--command', '--plugins', '--baseline', '--update-baseline', '--output', '--pr-comment-post']) {
      assert.ok(!options.some((o) => o === forbidden || o.startsWith(`${forbidden}=`)), `argv must never contain ${forbidden}`);
    }

    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.masked, true);
    assert.equal(payload.changeCount, 1);
    assert.equal(payload.changes[0].path, 'database.pool_size');
  });

  test('flecto_diff omits masking only on an explicit opt-out', async () => {
    const runner = fakeRunner(sample);
    await call(runner, 'flecto_diff', { file: 'config/prod.yaml', mask: false });
    assert.ok(!runner.calls[0].includes('--mask-secrets'), 'mask:false is honored');
  });

  test('flecto_diff passes a custom ref through without letting it be a flag', async () => {
    const runner = fakeRunner(sample);
    await call(runner, 'flecto_diff', { file: 'config/prod.yaml', ref: 'origin/main' });
    assert.ok(runner.calls[0].includes('--snapshot-ref=origin/main'), runner.calls[0].join(' '));

    const result = await call(fakeRunner(sample), 'flecto_diff', { file: 'x.yaml', ref: '--format' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /must not start with "-"/);
  });

  test('flecto_check evaluates named packs and flattens findings with their file', async () => {
    const runner = fakeRunner(sample);
    const result = await call(runner, 'flecto_check', { files: ['config/prod.yaml'], packs: ['default', 'strict-prod'] });
    assert.ok(runner.calls[0].includes('--policies=default,strict-prod'), runner.calls[0].join(' '));
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.findingCount, 1);
    assert.equal(payload.findings[0].file, '/repo/config/prod.yaml');
    assert.equal(payload.findings[0].id, 'pool-size-jump');
  });

  test('flecto_explain returns only the requested path and its findings', async () => {
    const results = [{
      file: '/repo/config/prod.yaml',
      envelope: {
        changes: [
          { type: 'changed', path: 'database.pool_size', before: 5, after: 20 },
          { type: 'changed', path: 'replicas', before: 2, after: 5 },
        ],
      },
      policies: [
        { id: 'pool-size-jump', severity: 'warn', path: 'database.pool_size', message: 'up' },
        { id: 'other', severity: 'warn', path: 'replicas', message: 'x' },
      ],
    }];
    const result = await call(fakeRunner(results), 'flecto_explain', { file: 'config/prod.yaml', path: 'database.pool_size' });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.changed, true);
    assert.equal(payload.changes.length, 1);
    assert.equal(payload.changes[0].path, 'database.pool_size');
    assert.equal(payload.findings.length, 1);
    assert.equal(payload.findings[0].id, 'pool-size-jump');
  });

  test('flecto_explain reports "no change" for an untouched path', async () => {
    const result = await call(fakeRunner(sample), 'flecto_explain', { file: 'config/prod.yaml', path: 'replicas' });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.changed, false);
    assert.match(payload.note, /No change at "replicas"/);
  });

  test('an unknown tool is an error result, not a crash', async () => {
    const result = await call(fakeRunner(), 'flecto_wipe', { file: 'x' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown tool/);
  });

  test('a CLI failure (empty stdout) surfaces its stderr as a tool error', async () => {
    const runner = async () => ({ status: 1, stdout: '', stderr: '[error] no snapshot has been saved' });
    const result = await call(runner, 'flecto_diff', { file: 'config/prod.yaml' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no snapshot has been saved/);
  });
});

describe('MCP argument containment (#140)', () => {
  test('a traversal or absolute-outside path is refused before spawning', () => {
    assert.throws(() => assertSafeTargetArg('../../etc/passwd', '/repo'), /escapes the working directory/);
    assert.throws(() => assertSafeTargetArg('a/../../b', '/repo'), /escapes the working directory/);
    assert.throws(() => assertSafeTargetArg('/etc/passwd', '/repo'), /outside the working directory/);
    assert.throws(() => assertSafeTargetArg('', '/repo'), /non-empty/);
  });

  test('a file argument shaped like a CLI option is refused before spawning', async () => {
    // Before this, `files: ["--plugins=./p.mjs", ...]` reached the `ci` command
    // line as an option: one tool call ran a plugin, another wrote a baseline.
    for (const arg of ['--plugins=./p.mjs', '--update-baseline', '-p', '--pr-comment-post']) {
      assert.throws(() => assertSafeTargetArg(arg, '/repo'), /starts with "-"/, arg);
    }
    const runner = fakeRunner();
    const res = await server(runner).handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'flecto_check', arguments: { files: ['--plugins=./p.mjs', 'config/prod.yaml'] } },
    });
    assert.equal(res.result.isError, true);
    assert.equal(runner.calls.length, 0, 'nothing must have been spawned');
  });

  test('agent-supplied values can never be parsed as options', async () => {
    // Defense in depth behind the refusal above: pack ids ride inside
    // `--policies=`, and every file follows `--`, so no value is ever a flag.
    const runner = fakeRunner();
    await server(runner).handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'flecto_check', arguments: { files: ['a.yaml', 'b/*.yaml'], packs: ['--plugins=./p.mjs'] } },
    });
    const args = runner.calls[0];
    const end = args.indexOf('--');
    assert.deepEqual(args.slice(end + 1), ['a.yaml', 'b/*.yaml']);
    assert.ok(args.slice(1, end).includes('--policies=--plugins=./p.mjs'), args.join(' '));
    assert.ok(!args.includes('--plugins=./p.mjs'), 'a pack id must not become its own argument');
  });

  test('in-repo paths and globs are allowed', () => {
    assert.equal(assertSafeTargetArg('config/prod.yaml', '/repo'), 'config/prod.yaml');
    assert.equal(assertSafeTargetArg('config/**/*.yaml', '/repo'), 'config/**/*.yaml');
    assert.equal(assertSafeTargetArg('./app.yaml', '/repo'), './app.yaml');
  });

  test('a refused traversal comes back as a tool error, never a spawn', async () => {
    const runner = fakeRunner();
    const res = await server(runner).handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'flecto_diff', arguments: { file: '../../secret' } },
    });
    assert.equal(res.result.isError, true);
    assert.equal(runner.calls.length, 0, 'nothing must have been spawned');
  });
});

describe('MCP results are bounded (#140)', () => {
  test('bound caps a list and reports what it withheld', () => {
    const big = Array.from({ length: 1000 }, (_, i) => i);
    const { items, total, omitted, truncated } = bound(big, 500);
    assert.equal(items.length, 500);
    assert.equal(total, 1000);
    assert.equal(omitted, 500);
    assert.equal(truncated, true);
  });

  test('a huge diff truncates with a stated count rather than flooding the context', async () => {
    const changes = Array.from({ length: 900 }, (_, i) => ({ type: 'changed', path: `k${i}`, before: 0, after: 1 }));
    const runner = fakeRunner([{ file: '/repo/c.yaml', envelope: { changes }, policies: [] }]);
    const res = await server(runner).handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'flecto_diff', arguments: { file: 'c.yaml' } },
    });
    const payload = JSON.parse(res.result.content[0].text);
    assert.equal(payload.changeCount, 900);
    assert.equal(payload.changes.length, 500);
    assert.equal(payload.truncated.changes, 400);
  });
});

describe('flecto mcp over real stdio (#140)', () => {
  /** Drive the actual `flecto mcp` process with newline-delimited JSON-RPC. */
  function driveServer(cwd, messages, env = {}) {
    const input = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
    const run = spawnSync(process.execPath, [ROOT_INDEX, 'mcp'], {
      cwd, input, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30000,
    });
    assert.equal(run.signal, null, `must not hang: ${run.stderr}`);
    const responses = run.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { responses, stderr: run.stderr };
  }

  function gitRepo(prefix, headContent, workingContent) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'prod.yaml'), headContent, 'utf8');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir });
    writeFileSync(join(dir, 'config', 'prod.yaml'), workingContent, 'utf8');
    return dir;
  }

  test('a real handshake and diff returns masked changes and keeps stdout protocol-only', () => {
    const dir = gitRepo('flecto-mcp-e2e-', 'pool_size: 5\npassword: hunter2\n', 'pool_size: 20\npassword: swordfish\n');
    try {
      const { responses } = driveServer(dir, [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'flecto_diff', arguments: { file: 'config/prod.yaml' } } },
      ]);
      // Two responses: initialize and the tool call. The notification produced none.
      assert.equal(responses.length, 2);
      assert.equal(responses[0].id, 1);
      const payload = JSON.parse(responses[1].result.content[0].text);
      const pool = payload.changes.find((c) => c.path === 'pool_size');
      assert.deepEqual([pool.before, pool.after], [5, 20]);
      const secret = payload.changes.find((c) => c.path === 'password');
      assert.equal(secret.after, '***', 'the secret must be masked by default');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an rc-declared plugin stays off even with FLECTO_ALLOW_RC_PLUGINS=1', () => {
    const dir = gitRepo('flecto-mcp-plug-', 'a: 1\n', 'a: 2\n');
    const marker = join(dir, 'PLUGIN_RAN');
    writeFileSync(join(dir, 'p.js'),
      `import { writeFileSync } from 'fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\nexport function evaluate() { return []; }\n`,
      'utf8');
    writeFileSync(join(dir, '.flectorc'), JSON.stringify({ defaults: { plugins: ['./p.js'] } }), 'utf8');
    try {
      driveServer(dir, [
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'flecto_diff', arguments: { file: 'config/prod.yaml' } } },
      ], { FLECTO_ALLOW_RC_PLUGINS: '1' });
      assert.equal(existsSync(marker), false, 'the plugin must not have run');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a tool argument spelled as a CLI option neither runs a plugin nor writes a file', () => {
    const dir = gitRepo('flecto-mcp-inj-', 'a: 1\n', 'a: 2\n');
    const marker = join(dir, 'PLUGIN_RAN');
    writeFileSync(join(dir, 'p.mjs'),
      `import { writeFileSync } from 'fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\nexport function evaluate() { return []; }\n`,
      'utf8');
    try {
      const { responses } = driveServer(dir, [
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'flecto_check', arguments: { files: ['--plugins=./p.mjs', 'config/prod.yaml'] } } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'flecto_check', arguments: { files: ['--baseline=OWNED.json', '--update-baseline', 'config/prod.yaml'] } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'flecto_check', arguments: { files: ['config/prod.yaml'], packs: ['--plugins=./p.mjs'] } } },
      ]);
      assert.equal(responses.length, 3);
      for (const res of responses) assert.equal(res.result.isError, true, JSON.stringify(res));
      assert.equal(existsSync(marker), false, 'the plugin must not have run');
      assert.equal(existsSync(join(dir, 'OWNED.json')), false, 'no baseline may have been written');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
