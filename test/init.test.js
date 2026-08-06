import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { detectStack, initRcFile, loadRcConfig } from '../src/config.js';

const GENERIC_FILE_PATTERNS = [
  'config/**/*.{yaml,yml,json,toml,ini}',
  '.env',
  '.env.*',
  '*.env',
];

function makeDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readRc(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('stack detection', () => {
  test('compose file enables the compose pack and is watched', () => {
    const dir = makeDir('flecto-init-compose-');
    try {
      writeFileSync(join(dir, 'docker-compose.yml'), 'services:\n  api:\n    image: node\n', 'utf8');

      const detection = detectStack(dir);
      assert.deepEqual(detection.packs, ['default', 'compose']);
      assert.deepEqual(detection.files, ['docker-compose.yml']);
      assert.equal(detection.signals.length, 1);
      assert.equal(detection.signals[0].id, 'compose');
      assert.equal(detection.signals[0].pack, 'compose');
      assert.match(detection.signals[0].summary, /docker-compose\.yml → enabled the `compose` policy pack/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('every compose filename variant is recognized', () => {
    for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
      const dir = makeDir('flecto-init-compose-variant-');
      try {
        writeFileSync(join(dir, name), 'services: {}\n', 'utf8');
        const detection = detectStack(dir);
        assert.ok(detection.packs.includes('compose'), `${name} should enable the compose pack`);
        assert.ok(detection.files.includes(name), `${name} should be watched`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('package.json enables the node-runtime pack', () => {
    const dir = makeDir('flecto-init-node-');
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }), 'utf8');

      const detection = detectStack(dir);
      assert.deepEqual(detection.packs, ['default', 'node-runtime']);
      assert.deepEqual(detection.files, ['package.json']);
      assert.deepEqual(detection.signals.map((signal) => signal.id), ['node']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('compose and node signals combine with config/ and dotenv patterns', () => {
    const dir = makeDir('flecto-init-both-');
    try {
      writeFileSync(join(dir, 'compose.yaml'), 'services: {}\n', 'utf8');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }), 'utf8');
      writeFileSync(join(dir, '.env.production'), 'PORT=3000\n', 'utf8');
      mkdirSync(join(dir, 'config'));

      const detection = detectStack(dir);
      assert.deepEqual(detection.packs, ['default', 'compose', 'node-runtime']);
      assert.deepEqual(detection.files, [
        'compose.yaml',
        'package.json',
        'config/**/*.{yaml,yml,json,toml,ini}',
        '.env',
        '.env.*',
        '*.env',
      ]);
      assert.deepEqual(
        detection.signals.map((signal) => signal.id),
        ['compose', 'node', 'config-dir', 'dotenv'],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('terraform files are reported as context but never enable a pack or file pattern', () => {
    const dir = makeDir('flecto-init-tf-');
    try {
      writeFileSync(join(dir, 'main.tf'), 'resource "null_resource" "a" {}\n', 'utf8');
      writeFileSync(join(dir, 'variables.tf'), 'variable "a" {}\n', 'utf8');

      const detection = detectStack(dir);
      assert.deepEqual(detection.packs, ['default']);
      assert.deepEqual(detection.files, []);
      assert.deepEqual(detection.signals.map((signal) => signal.id), ['terraform']);
      assert.equal(detection.signals[0].pack, null);
      assert.deepEqual(detection.signals[0].evidence, ['main.tf', 'variables.tf']);
      assert.match(detection.signals[0].summary, /no terraform pack ships yet/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an empty project detects nothing', () => {
    const dir = makeDir('flecto-init-empty-');
    try {
      const detection = detectStack(dir);
      assert.deepEqual(detection, { signals: [], packs: ['default'], files: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('initRcFile', () => {
  test('writes detected packs and files for a compose + node project', () => {
    const dir = makeDir('flecto-init-write-');
    try {
      writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n', 'utf8');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }), 'utf8');

      const result = initRcFile(dir);
      assert.equal(result.created, true);
      assert.equal(result.path, resolve(dir, '.flectorc.json'));

      const rc = readRc(result.path);
      assert.deepEqual(rc.defaults.policies, ['default', 'compose', 'node-runtime']);
      assert.deepEqual(rc.profiles.prod.policies, ['default', 'compose', 'node-runtime', 'strict-prod']);
      assert.deepEqual(rc.files, ['docker-compose.yml', 'package.json']);
      assert.deepEqual(rc.exclude, ['**/node_modules/**']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('falls back to the generic starter config when nothing is detected', () => {
    const dir = makeDir('flecto-init-generic-');
    try {
      const result = initRcFile(dir);
      assert.equal(result.created, true);

      const rc = readRc(result.path);
      assert.deepEqual(rc.defaults.policies, ['default']);
      assert.deepEqual(rc.profiles.prod.policies, ['default', 'strict-prod']);
      assert.deepEqual(rc.files, GENERIC_FILE_PATTERNS);
      assert.equal(rc.defaults.mode, 'compact');
      assert.equal(rc.defaults.interval, 100);
      assert.deepEqual(rc.defaults.ignore, ['**.updated_at']);
      assert.equal(rc.defaults.arrayId, true);
      assert.deepEqual(rc.profiles.dev, { mode: 'verbose' });
      assert.deepEqual(rc.profiles.ci, { failOn: 'policy,error' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a .tf-only project still gets a usable generic file list', () => {
    const dir = makeDir('flecto-init-tf-only-');
    try {
      writeFileSync(join(dir, 'main.tf'), 'resource "null_resource" "a" {}\n', 'utf8');

      const rc = readRc(initRcFile(dir).path);
      assert.deepEqual(rc.defaults.policies, ['default']);
      assert.deepEqual(rc.files, GENERIC_FILE_PATTERNS);
      assert.ok(!JSON.stringify(rc).includes('terraform'));
      assert.ok(!rc.files.some((pattern) => pattern.includes('.tf')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('never overwrites an existing rc file, in any candidate name', () => {
    for (const candidate of ['.flectorc', '.flectorc.json', '.flectorc.yaml', '.flectorc.yml']) {
      const dir = makeDir('flecto-init-existing-');
      try {
        const existing = join(dir, candidate);
        const contents = '{ "defaults": { "mode": "verbose" } }';
        writeFileSync(existing, contents, 'utf8');
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }), 'utf8');

        const result = initRcFile(dir);
        assert.equal(result.created, false, `${candidate} should not be replaced`);
        assert.equal(result.path, resolve(dir, candidate));
        assert.equal(readFileSync(existing, 'utf8'), contents);
        if (candidate !== '.flectorc.json') {
          assert.equal(loadRcConfig(dir).path, resolve(dir, candidate));
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('the generated config loads back through loadRcConfig', () => {
    const dir = makeDir('flecto-init-load-');
    try {
      writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n', 'utf8');
      const { path } = initRcFile(dir);
      const loaded = loadRcConfig(dir);

      assert.equal(loaded.path, path);
      assert.deepEqual(loaded.config.defaults.policies, ['default', 'compose']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('flecto init command', () => {
  const rootIndex = resolve(process.cwd(), 'index.js');

  test('prints what was detected and generates a config that passes doctor and ci', () => {
    const dir = makeDir('flecto-init-cli-');
    try {
      writeFileSync(join(dir, 'docker-compose.yml'), 'services:\n  api:\n    image: node:20\n', 'utf8');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', engines: { node: '>=20' } }), 'utf8');

      const init = spawnSync(process.execPath, [rootIndex, 'init'], { cwd: dir, encoding: 'utf8' });
      assert.equal(init.status, 0);
      assert.match(init.stdout, /Initialized config: .*\.flectorc\.json/);
      assert.match(init.stdout, /Detected docker-compose\.yml → enabled the `compose` policy pack/);
      assert.match(init.stdout, /Detected package\.json → enabled the `node-runtime` policy pack/);
      assert.match(init.stdout, /Policy packs: default, compose, node-runtime/);

      const doctor = spawnSync(process.execPath, [rootIndex, 'doctor'], { cwd: dir, encoding: 'utf8' });
      assert.equal(doctor.status, 0, doctor.stderr);
      assert.match(doctor.stdout, /resolved files: 2/);
      assert.match(doctor.stdout, /doctor: OK/);

      // Packs referenced by the generated config must actually resolve, so a
      // baseline CI run against unchanged snapshots has to exit clean.
      const snapshot = spawnSync(process.execPath, [rootIndex, 'watch', '--snapshot'], { cwd: dir, encoding: 'utf8' });
      assert.equal(snapshot.status, 0, snapshot.stderr);

      const ci = spawnSync(process.execPath, [rootIndex, 'ci'], { cwd: dir, encoding: 'utf8' });
      assert.equal(ci.status, 0, ci.stderr);
      assert.equal(JSON.parse(ci.stdout).length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reports the generic fallback when nothing is detected', () => {
    const dir = makeDir('flecto-init-cli-generic-');
    try {
      const init = spawnSync(process.execPath, [rootIndex, 'init'], { cwd: dir, encoding: 'utf8' });

      assert.equal(init.status, 0);
      assert.match(init.stdout, /No stack signals detected — wrote the generic starter config\./);
      assert.doesNotMatch(init.stdout, /Detected/);

      const doctor = spawnSync(process.execPath, [rootIndex, 'doctor'], { cwd: dir, encoding: 'utf8' });
      assert.equal(doctor.status, 0, doctor.stderr);
      assert.match(doctor.stdout, /doctor: OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('leaves an existing config untouched and says so', () => {
    const dir = makeDir('flecto-init-cli-existing-');
    try {
      const existing = join(dir, '.flectorc');
      writeFileSync(existing, '{ "defaults": { "mode": "verbose" } }', 'utf8');
      writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n', 'utf8');

      const init = spawnSync(process.execPath, [rootIndex, 'init'], { cwd: dir, encoding: 'utf8' });

      assert.equal(init.status, 0);
      assert.match(init.stderr, /Config already exists: .*\.flectorc \(left unchanged\)/);
      assert.equal(readFileSync(existing, 'utf8'), '{ "defaults": { "mode": "verbose" } }');
      assert.equal(loadRcConfig(dir).path, resolve(dir, '.flectorc'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('terraform-only projects get a config with no unresolvable pack', () => {
    const dir = makeDir('flecto-init-cli-tf-');
    try {
      writeFileSync(join(dir, 'main.tf'), 'resource "null_resource" "a" {}\n', 'utf8');

      const init = spawnSync(process.execPath, [rootIndex, 'init'], { cwd: dir, encoding: 'utf8' });
      assert.equal(init.status, 0);
      assert.match(init.stdout, /Detected Terraform files \(main\.tf\)/);
      assert.match(init.stdout, /Policy packs: default$/m);

      const doctor = spawnSync(process.execPath, [rootIndex, 'doctor'], { cwd: dir, encoding: 'utf8' });
      assert.equal(doctor.status, 0, doctor.stderr);
      assert.match(doctor.stdout, /doctor: OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
