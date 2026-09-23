import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { parseSourceUri, shapeOf } from '../src/drift-sources.js';

const driftBin = resolve(process.cwd(), 'drift.js');

/**
 * A project with a stub `kubectl` on PATH that records the argv it was given.
 *
 * Stubbing the tool rather than the module is deliberate: the property under
 * test is *what argv reaches the binary*, and a mock in front of `spawnSync`
 * would test the mock.
 * @param {{ configmap?: object, secret?: object }} [answers]
 */
function projectWithStubs(answers = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-drift-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const configmap = JSON.stringify(answers.configmap ?? { data: { pool_size: '50', tls: 'false' } });
  const secret = JSON.stringify(answers.secret ?? { data: { db_password: 'bGl2ZQ==' } });
  writeFileSync(join(dir, 'bin', 'kubectl'),
    '#!/bin/sh\n'
    + 'echo "$@" >> "$KUBECTL_ARGV_LOG"\n'
    + 'case "$*" in\n'
    + `  *configmap*) echo '${configmap}' ;;\n`
    + `  *secret*) echo '${secret}' ;;\n`
    + 'esac\n', 'utf8');
  chmodSync(join(dir, 'bin', 'kubectl'), 0o755);
  writeFileSync(join(dir, 'app.yaml'), 'data:\n  pool_size: "5"\n  tls: "true"\n', 'utf8');
  return dir;
}

/**
 * @param {string} dir
 * @param {string[]} args
 */
function runDrift(dir, args) {
  return spawnSync(process.execPath, [driftBin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, KUBECTL_ARGV_LOG: join(dir, 'argv.log') },
  });
}

describe('flecto drift reads live state without holding a credential (#144)', () => {
  test('it reports what the running system did to what we declared', () => {
    const dir = projectWithStubs();
    try {
      const run = runDrift(dir, ['app.yaml', '--against', 'k8s://prod/configmap/api']);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /pool_size/);
      assert.match(run.stdout, /"5" . "50"/u);
      assert.match(run.stdout, /"true" . "false"/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--fail-on-drift is what a CI job gates on', () => {
    const dir = projectWithStubs();
    try {
      assert.equal(runDrift(dir, ['app.yaml', '--against', 'k8s://prod/configmap/api', '--fail-on-drift']).status, 1);
      // Same declared values as the live ones: no drift, exit 0.
      writeFileSync(join(dir, 'same.yaml'), 'data:\n  pool_size: "50"\n  tls: "false"\n', 'utf8');
      const clean = runDrift(dir, ['same.yaml', '--against', 'k8s://prod/configmap/api', '--fail-on-drift']);
      assert.equal(clean.status, 0, clean.stderr);
      assert.match(clean.stdout, /No drift/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('only a read-only verb ever reaches the tool', () => {
    const dir = projectWithStubs();
    try {
      runDrift(dir, ['app.yaml', '--against', 'k8s://prod/configmap/api']);
      const argv = readFileSync(join(dir, 'argv.log'), 'utf8').trim();
      assert.equal(argv, 'get configmap api --namespace prod --output json');
      assert.doesNotMatch(argv, /delete|apply|patch|edit|replace|create|scale/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('nothing from the URI can reach argv as a flag or a second command', () => {
    const dir = projectWithStubs();
    try {
      const hostile = [
        ['k8s://prod/configmap/--output=pwned', /starts with "-"/],
        ['k8s://--namespace=evil/configmap/api', /starts with "-"/],
        ['k8s://prod/configmap/a;whoami', /is not a valid name/],
        ['k8s://prod/configmap/a b', /is not a valid name/],
        ['k8s://prod/delete/api', /not a readable kind/],
        ['ssm://../../etc/passwd', /is not a valid parameter path/],
        ['file:///etc/passwd', /is not a supported source/],
        ['not-a-uri', /is not a source URI/],
      ];
      for (const [uri, expected] of hostile) {
        const run = runDrift(dir, ['app.yaml', '--against', uri]);
        assert.equal(run.status, 1, uri);
        assert.match(run.stderr, expected, uri);
      }
      // And none of them reached kubectl at all.
      const argv = spawnSync('cat', [join(dir, 'argv.log')], { encoding: 'utf8' }).stdout ?? '';
      assert.equal(argv.trim(), '', 'a refused URI must not spawn anything');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a value from a secret store is never printed', () => {
  test('a Secret is compared by shape, and the plaintext never appears', () => {
    const dir = projectWithStubs({ secret: { data: { db_password: 'cm90YXRlZA==' } } });
    try {
      writeFileSync(join(dir, 'sec.yaml'), 'data:\n  db_password: "declared-value"\n', 'utf8');
      const run = runDrift(dir, ['sec.yaml', '--against', 'k8s://prod/secret/creds', '--format', 'json']);
      assert.equal(run.status, 0, run.stderr);
      const report = JSON.parse(run.stdout);
      assert.equal(report.comparison, 'shape-only');
      assert.ok(!run.stdout.includes('cm90YXRlZA'), 'the live value leaked');
      assert.ok(!run.stdout.includes('declared-value'), 'the declared value leaked');
      assert.match(run.stdout, /sha256:/, 'but a rotation is still visible as a change');
      assert.equal(report.drifted, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unchanged secret reports no drift, so the shape comparison is real', () => {
    // Both sides hash the same plaintext, so a stable credential is quiet --
    // otherwise the tool would cry drift on every run and be ignored.
    const live = Buffer.from('steady').toString('base64');
    const dir = projectWithStubs({ secret: { data: { db_password: live } } });
    try {
      writeFileSync(join(dir, 'sec.yaml'), `data:\n  db_password: "${live}"\n`, 'utf8');
      const run = runDrift(dir, ['sec.yaml', '--against', 'k8s://prod/secret/creds', '--format', 'json']);
      assert.equal(JSON.parse(run.stdout).drifted, false, run.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('there is no flag that turns secret values back on', () => {
    const help = spawnSync(process.execPath, [driftBin, '--help'], { encoding: 'utf8' }).stdout;
    assert.doesNotMatch(help, /--values|--show-secrets|--with-decryption|--reveal/);
  });

  test('a shape carries length and digest, and nothing of the value', () => {
    const shape = shapeOf('hunter2');
    assert.match(shape, /^<7 bytes, sha256:[0-9a-f]{12}>$/);
    assert.ok(!shape.includes('hunter'));
    assert.notEqual(shapeOf('a'), shapeOf('b'));
    assert.equal(shapeOf('same'), shapeOf('same'), 'and is stable, or every run reports drift');
  });
});

describe('terraform state is read narrowly', () => {
  /** @param {object} state */
  function repoWithState(state) {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-drift-tf-'));
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state), 'utf8');
    writeFileSync(join(dir, 'app.yaml'), 'endpoint: "https://old.example.com"\n', 'utf8');
    return dir;
  }

  test('only outputs are read, never resource attributes', () => {
    // Terraform state routinely carries provider credentials in resource
    // attributes; walking all of it would make a drift check an exfiltration
    // primitive.
    const dir = repoWithState({
      outputs: { endpoint: { value: 'https://new.example.com' } },
      resources: [{ instances: [{ attributes: { secret_key: 'AKIALEAKMENOW00000AB' } }] }],
    });
    try {
      const run = runDrift(dir, ['app.yaml', '--against', `tfstate://${join(dir, 'state.json')}`, '--format', 'json']);
      assert.equal(run.status, 0, run.stderr);
      assert.ok(!run.stdout.includes('AKIALEAKMENOW'), 'a resource attribute reached the output');
      assert.match(run.stdout, /new\.example\.com/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a sensitive output is shaped like any other secret', () => {
    const dir = repoWithState({ outputs: { token: { value: 'supersecret', sensitive: true } } });
    try {
      const run = runDrift(dir, ['app.yaml', '--against', `tfstate://${join(dir, 'state.json')}`, '--format', 'json']);
      assert.ok(!run.stdout.includes('supersecret'));
      assert.match(run.stdout, /sha256:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a __proto__ output does not reach Object.prototype', () => {
    const dir = repoWithState({ outputs: { __proto__: { value: { polluted: true } }, ok: { value: 1 } } });
    try {
      const run = runDrift(dir, ['app.yaml', '--against', `tfstate://${join(dir, 'state.json')}`, '--format', 'json']);
      assert.equal(run.status, 0, run.stderr);
      assert.equal({}.polluted, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a file that is not state JSON fails without quoting its bytes', () => {
    const dir = repoWithState({ outputs: {} });
    try {
      writeFileSync(join(dir, 'notstate.txt'), '## secret-looking header\nroot:x:0:0\n', 'utf8');
      const run = runDrift(dir, ['app.yaml', '--against', `tfstate://${join(dir, 'notstate.txt')}`]);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /is not valid terraform state JSON/);
      assert.ok(!run.stderr.includes('root:x:0:0'), 'the error echoed file contents');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('drift is separate from core', () => {
  test('no core module imports the drift entry point', () => {
    const grep = spawnSync('grep', ['-rn', 'drift.js', 'index.js', 'src/'], { encoding: 'utf8' });
    const offenders = (grep.stdout ?? '').split('\n')
      .filter((line) => line && !line.startsWith('src/drift-sources.js'));
    assert.deepEqual(offenders, [], 'core must not reach the drift binary');
  });

  test('nothing in core imports drift-sources either', () => {
    // Only drift.js may reach it, and drift.js is not part of core, so no file
    // under index.js or src/ should so much as name it.
    const grep = spawnSync('grep', ['-rln', 'drift-sources', 'index.js', 'src/'], { encoding: 'utf8' });
    const files = (grep.stdout ?? '').split('\n').filter(Boolean);
    assert.deepEqual(files, [], `core reached drift-sources: ${files}`);

    const fromDrift = spawnSync('grep', ['-c', "drift-sources.js", 'drift.js'], { encoding: 'utf8' });
    assert.ok(Number(fromDrift.stdout) > 0, 'and the drift binary is the one that does');
  });

  test('the URI parser accepts only the documented schemes', () => {
    assert.deepEqual(parseSourceUri('k8s://a/configmap/b'), { scheme: 'k8s', rest: 'a/configmap/b' });
    assert.deepEqual(parseSourceUri('SSM:///app/prod'), { scheme: 'ssm', rest: '/app/prod' });
    assert.throws(() => parseSourceUri('/etc/passwd'), /not a source URI/);
    assert.throws(() => parseSourceUri(''), /not a source URI/);
  });
});
