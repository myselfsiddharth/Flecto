import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, realpathSync, symlinkSync } from 'fs';
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
