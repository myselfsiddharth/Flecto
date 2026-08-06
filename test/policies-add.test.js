import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizePackPackageName } from '../src/policy.js';

// realpath: the CLI reports canonical pack paths, and macOS resolves
// /var/folders temp dirs to /private/var/folders.
const ROOT_INDEX = resolve(process.cwd(), 'index.js');

const SAMPLE_PACK = {
  rules: [
    {
      id: 'public-service-enabled',
      severity: 'error',
      when: ['added', 'changed'],
      match: { path: 'service\\.public$' },
      afterEquals: true,
      message: 'A service was made public.',
    },
  ],
};

function makeWorkspace(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Write a fake installed pack package into <dir>/node_modules.
 * @param {string} dir Workspace root
 * @param {string} packageName npm package name, possibly scoped
 * @param {{ packageJson?: object, files?: Record<string, string | object> }} [opts]
 */
function installPackPackage(dir, packageName, opts = {}) {
  const packageDir = join(dir, 'node_modules', ...packageName.split('/'));
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: packageName, version: '1.0.0', ...opts.packageJson }, null, 2),
    'utf8',
  );
  for (const [relPath, content] of Object.entries(opts.files ?? {})) {
    const target = join(packageDir, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
      'utf8',
    );
  }
  return packageDir;
}

function runFlecto(cwd, args) {
  return spawnSync(process.execPath, [ROOT_INDEX, ...args], { cwd, encoding: 'utf8' });
}

describe('policy pack package names', () => {
  test('normalizes short and full forms onto each other', () => {
    assert.deepEqual(normalizePackPackageName('deployment-safety'), {
      id: 'deployment-safety',
      packageName: 'flecto-pack-deployment-safety',
    });
    assert.deepEqual(normalizePackPackageName('flecto-pack-deployment-safety'), {
      id: 'deployment-safety',
      packageName: 'flecto-pack-deployment-safety',
    });
    assert.deepEqual(normalizePackPackageName('@acme/flecto-pack-edge'), {
      id: 'edge',
      packageName: '@acme/flecto-pack-edge',
    });
    assert.deepEqual(normalizePackPackageName('@acme/edge'), {
      id: 'edge',
      packageName: '@acme/flecto-pack-edge',
    });
  });

  test('rejects names that would escape the policies directory', () => {
    for (const name of ['../evil', 'a/b', '', '  ', 'flecto-pack-']) {
      assert.throws(() => normalizePackPackageName(name), /Invalid policy pack name|required/);
    }
  });
});

describe('flecto policies add', () => {
  test('installs a pack from the short name', () => {
    const dir = makeWorkspace('flecto-add-short-');
    try {
      installPackPackage(dir, 'flecto-pack-deployment-safety', {
        packageJson: { version: '1.2.0' },
        files: { 'flecto-pack.json': SAMPLE_PACK },
      });

      const run = runFlecto(dir, ['policies', 'add', 'deployment-safety']);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /flecto-pack-deployment-safety@1\.2\.0/);
      assert.match(run.stdout, /policies\/deployment-safety\.json \(1 rule\)/);

      const written = JSON.parse(
        readFileSync(join(dir, 'policies', 'deployment-safety.json'), 'utf8'),
      );
      assert.equal(written.id, 'deployment-safety');
      assert.deepEqual(written.rules, SAMPLE_PACK.rules);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('installs a pack from the full npm package name', () => {
    const dir = makeWorkspace('flecto-add-full-');
    try {
      installPackPackage(dir, 'flecto-pack-deployment-safety', {
        files: { 'flecto-pack.json': SAMPLE_PACK },
      });

      const run = runFlecto(dir, ['policies', 'add', 'flecto-pack-deployment-safety']);
      assert.equal(run.status, 0, run.stderr);
      assert.ok(existsSync(join(dir, 'policies', 'deployment-safety.json')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('installs a scoped pack package and a YAML pack file', () => {
    const dir = makeWorkspace('flecto-add-scoped-');
    try {
      installPackPackage(dir, '@acme/flecto-pack-edge', {
        files: {
          'flecto-pack.yaml': 'rules:\n  - id: edge-rule\n    severity: warn\n',
        },
      });

      const run = runFlecto(dir, ['policies', 'add', '@acme/flecto-pack-edge']);
      assert.equal(run.status, 0, run.stderr);
      const written = JSON.parse(readFileSync(join(dir, 'policies', 'edge.json'), 'utf8'));
      assert.deepEqual(written, { id: 'edge', rules: [{ id: 'edge-rule', severity: 'warn' }] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('honours a package.json "flecto" field pointing at the pack file', () => {
    const dir = makeWorkspace('flecto-add-field-');
    try {
      installPackPackage(dir, 'flecto-pack-built', {
        packageJson: { flecto: { pack: 'dist/pack.json' } },
        files: { 'dist/pack.json': { rules: [{ id: 'built-rule', severity: 'info' }] } },
      });
      installPackPackage(dir, 'flecto-pack-strung', {
        packageJson: { flecto: 'dist/pack.yml' },
        files: { 'dist/pack.yml': 'rules:\n  - id: strung-rule\n    severity: info\n' },
      });

      assert.equal(runFlecto(dir, ['policies', 'add', 'built']).status, 0);
      assert.equal(runFlecto(dir, ['policies', 'add', 'strung']).status, 0);
      assert.equal(
        JSON.parse(readFileSync(join(dir, 'policies', 'built.json'), 'utf8')).rules[0].id,
        'built-rule',
      );
      assert.equal(
        JSON.parse(readFileSync(join(dir, 'policies', 'strung.json'), 'utf8')).rules[0].id,
        'strung-rule',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('explains how to install a pack package that is not installed', () => {
    const dir = makeWorkspace('flecto-add-missing-');
    try {
      const run = runFlecto(dir, ['policies', 'add', 'deployment-safety']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /"flecto-pack-deployment-safety" is not installed/);
      assert.match(run.stderr, /npm install --save-dev flecto-pack-deployment-safety/);
      assert.ok(!existsSync(join(dir, 'policies')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects a malformed third-party pack at add time', () => {
    const dir = makeWorkspace('flecto-add-malformed-');
    try {
      installPackPackage(dir, 'flecto-pack-broken', {
        files: {
          'flecto-pack.json': {
            rules: [{ id: 'typo-rule', severity: 'error', afterEqauls: true }],
          },
        },
      });

      const run = runFlecto(dir, ['policies', 'add', 'broken']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /Invalid policy pack/);
      assert.match(run.stderr, /afterEqauls is not allowed/);
      assert.ok(!existsSync(join(dir, 'policies')), 'nothing is written when validation fails');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects a bad severity in a third-party pack', () => {
    const dir = makeWorkspace('flecto-add-severity-');
    try {
      installPackPackage(dir, 'flecto-pack-loud', {
        files: { 'flecto-pack.json': { rules: [{ id: 'loud-rule', severity: 'critical' }] } },
      });

      const run = runFlecto(dir, ['policies', 'add', 'loud']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /severity must be one of: info, warn, error/);
      assert.ok(!existsSync(join(dir, 'policies')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects a package with no pack file', () => {
    const dir = makeWorkspace('flecto-add-nopack-');
    try {
      installPackPackage(dir, 'flecto-pack-empty', { files: { 'index.js': 'export default 1;\n' } });

      const run = runFlecto(dir, ['policies', 'add', 'empty']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /is not a Flecto policy pack/);
      assert.match(run.stderr, /flecto-pack\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects a "flecto" field that points at JavaScript or outside the package', () => {
    const dir = makeWorkspace('flecto-add-badfield-');
    try {
      installPackPackage(dir, 'flecto-pack-code', {
        packageJson: { flecto: 'pack.js' },
        files: { 'pack.js': 'export const rules = [];\n' },
      });
      installPackPackage(dir, 'flecto-pack-escape', {
        packageJson: { flecto: '../../../etc/pack.json' },
      });

      const code = runFlecto(dir, ['policies', 'add', 'code']);
      assert.equal(code.status, 1);
      assert.match(code.stderr, /must be a \.json, \.yaml, or \.yml pack file/);

      const escape = runFlecto(dir, ['policies', 'add', 'escape']);
      assert.equal(escape.status, 1);
      assert.match(escape.stderr, /escapes the package directory/);
      assert.ok(!existsSync(join(dir, 'policies')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects a pack whose declared id disagrees with the package name', () => {
    const dir = makeWorkspace('flecto-add-mismatch-');
    try {
      installPackPackage(dir, 'flecto-pack-deployment-safety', {
        files: { 'flecto-pack.json': { id: 'something-else', ...SAMPLE_PACK } },
      });

      const run = runFlecto(dir, ['policies', 'add', 'deployment-safety']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /Policy pack id mismatch/);
      assert.ok(!existsSync(join(dir, 'policies')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses to overwrite a local pack without --force, and overwrites with it', () => {
    const dir = makeWorkspace('flecto-add-force-');
    try {
      installPackPackage(dir, 'flecto-pack-deployment-safety', {
        files: { 'flecto-pack.json': SAMPLE_PACK },
      });
      const localPack = { id: 'deployment-safety', rules: [{ id: 'mine', severity: 'info' }] };
      mkdirSync(join(dir, 'policies'), { recursive: true });
      writeFileSync(
        join(dir, 'policies', 'deployment-safety.json'),
        JSON.stringify(localPack, null, 2),
        'utf8',
      );

      const refused = runFlecto(dir, ['policies', 'add', 'deployment-safety']);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /already exists/);
      assert.match(refused.stderr, /--force/);
      assert.deepEqual(
        JSON.parse(readFileSync(join(dir, 'policies', 'deployment-safety.json'), 'utf8')),
        localPack,
        'the existing pack is left untouched',
      );

      const forced = runFlecto(dir, ['policies', 'add', 'deployment-safety', '--force']);
      assert.equal(forced.status, 0, forced.stderr);
      assert.match(forced.stdout, /Updated policy pack/);
      assert.deepEqual(
        JSON.parse(readFileSync(join(dir, 'policies', 'deployment-safety.json'), 'utf8')).rules,
        SAMPLE_PACK.rules,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('warns when the added pack shadows another local file or a built-in', () => {
    const dir = makeWorkspace('flecto-add-shadow-');
    try {
      installPackPackage(dir, 'flecto-pack-default', {
        files: { 'flecto-pack.json': { id: 'default', rules: [{ id: 'ours', severity: 'warn' }] } },
      });
      mkdirSync(join(dir, 'policies'), { recursive: true });
      writeFileSync(
        join(dir, 'policies', 'default.yaml'),
        'rules:\n  - id: local-default\n    severity: warn\n',
        'utf8',
      );

      const run = runFlecto(dir, ['policies', 'add', 'default', '--force']);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stderr, /overrides the built-in pack/);
      assert.match(run.stderr, /default\.yaml is no longer used/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('never loads JavaScript shipped alongside the pack', () => {
    const dir = makeWorkspace('flecto-add-nocode-');
    const sentinel = join(dir, 'executed.txt');
    try {
      installPackPackage(dir, 'flecto-pack-deployment-safety', {
        packageJson: { main: 'index.js' },
        files: {
          'flecto-pack.json': SAMPLE_PACK,
          'index.js': `import { writeFileSync } from 'node:fs';\n`
            + `writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`,
        },
      });

      const run = runFlecto(dir, ['policies', 'add', 'deployment-safety']);
      assert.equal(run.status, 0, run.stderr);
      assert.ok(!existsSync(sentinel), 'package code must never run');
      assert.match(run.stdout, /also ships JavaScript\. It was ignored/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('policies list reports npm provenance without changing local pack rows', () => {
    const dir = makeWorkspace('flecto-add-list-');
    try {
      installPackPackage(dir, 'flecto-pack-deployment-safety', {
        packageJson: { version: '2.0.1' },
        files: { 'flecto-pack.json': SAMPLE_PACK },
      });
      assert.equal(runFlecto(dir, ['policies', 'add', 'deployment-safety']).status, 0);
      writeFileSync(
        join(dir, 'policies', 'handwritten.json'),
        JSON.stringify({ id: 'handwritten', rules: [{ id: 'mine', severity: 'info' }] }),
        'utf8',
      );

      const listed = runFlecto(dir, ['policies', 'list', '--json']);
      assert.equal(listed.status, 0, listed.stderr);
      const packs = JSON.parse(listed.stdout);

      assert.deepEqual(packs.find((pack) => pack.id === 'deployment-safety'), {
        id: 'deployment-safety',
        sourcePath: join(dir, 'policies', 'deployment-safety.json'),
        source: 'local',
        ruleCount: 1,
        overridesBuiltin: false,
        package: 'flecto-pack-deployment-safety',
      });
      // Hand-written packs keep exactly the fields they always had.
      assert.deepEqual(packs.find((pack) => pack.id === 'handwritten'), {
        id: 'handwritten',
        sourcePath: join(dir, 'policies', 'handwritten.json'),
        source: 'local',
        ruleCount: 1,
        overridesBuiltin: false,
      });
      // The provenance sidecar is not itself a pack.
      assert.ok(!packs.some((pack) => pack.id.startsWith('.')));

      const text = runFlecto(dir, ['policies', 'list']);
      assert.match(text.stdout, /deployment-safety\t.*\tflecto-pack-deployment-safety/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an added pack resolves and evaluates through flecto ci', () => {
    const dir = makeWorkspace('flecto-add-ci-');
    try {
      installPackPackage(dir, 'flecto-pack-deployment-safety', {
        files: { 'flecto-pack.json': SAMPLE_PACK },
      });
      assert.equal(runFlecto(dir, ['policies', 'add', 'deployment-safety']).status, 0);

      writeFileSync(join(dir, 'config.json'), JSON.stringify({ service: { public: true } }), 'utf8');
      writeFileSync(
        join(dir, 'snapshot.json'),
        JSON.stringify({ state: { service: { public: false } } }),
        'utf8',
      );

      const run = runFlecto(dir, [
        'ci', 'config.json',
        '--snapshot-ref', 'snapshot.json',
        '--policies', 'deployment-safety',
        '--fail-on', 'policy',
        '--format', 'json',
      ]);
      assert.equal(run.status, 1);
      const [result] = JSON.parse(run.stdout);
      assert.deepEqual(result.policies, [{
        id: 'public-service-enabled',
        severity: 'error',
        path: 'service.public',
        message: 'A service was made public.',
        pack: 'deployment-safety',
      }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
