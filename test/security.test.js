import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, realpathSync } from 'fs';
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

  test('watch --diff refuses rc-declared plugins too', () => {
    // 2.x has no `compare`; `watch --diff` is the other command that both reads
    // a file and evaluates policies, so it exercises the same load path.
    const { dir, marker } = hostileProject('./p.js');
    try {
      // Seed a snapshot so --diff reaches policy evaluation rather than warning
      // that none exists. The opt-in lets that seeding run without tripping the
      // guard; clear the marker afterwards so the assertion below is clean.
      runFlecto(dir, ['watch', 'c.json', '--snapshot'], { FLECTO_ALLOW_RC_PLUGINS: '1' });
      rmSync(marker, { force: true });
      const run = runFlecto(dir, ['watch', 'c.json', '--diff']);
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
