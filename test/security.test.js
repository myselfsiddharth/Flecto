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
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const rootIndex = resolve(process.cwd(), 'index.js');

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
