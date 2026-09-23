import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { delimiter, join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { parseSourceUri, shapeOf } from '../src/drift-sources.js';

const driftBin = resolve(process.cwd(), 'drift.js');


/**
 * Write an executable stub named `tool` that runs `body` under Node.
 *
 * On POSIX that is a `#!/bin/sh` wrapper; on Windows a `.cmd`, which is what
 * PATHEXT resolves when something spawns `kubectl` by name.
 * @param {string} dir the project directory (the stub lands in `dir/bin`)
 * @param {string} tool
 * @param {string} body JavaScript run by Node
 */
function writeStub(dir, tool, body) {
  const impl = join(dir, 'bin', `${tool}-impl.js`);
  writeFileSync(impl, body, 'utf8');
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'bin', `${tool}.cmd`), `@echo off\r\nnode "%~dp0${tool}-impl.js" %*\r\n`, 'utf8');
    return;
  }
  const shim = join(dir, 'bin', tool);
  writeFileSync(shim, `#!/bin/sh\nexec node "$(dirname "$0")/${tool}-impl.js" "$@"\n`, 'utf8');
  chmodSync(shim, 0o755);
}

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
  const aws = JSON.stringify(answers.aws ?? { Parameters: [] });
  const secret = JSON.stringify(answers.secret ?? { data: { db_password: 'bGl2ZQ==' } });
  // Stubs are Node scripts behind a per-platform shim: Windows cannot execute a
  // `#!/bin/sh` file, and `kubectl.cmd` is what PATHEXT resolves there.
  writeStub(dir, 'kubectl',
    'const fs = require("fs");\n'
    + 'const args = process.argv.slice(2);\n'
    + 'fs.appendFileSync(process.env.KUBECTL_ARGV_LOG, args.join(" ") + "\\n");\n'
    + 'const joined = args.join(" ");\n'
    + `const configmap = ${JSON.stringify(configmap)};\n`
    + `const secret = ${JSON.stringify(secret)};\n`
    + 'if (joined.includes("configmap")) process.stdout.write(configmap);\n'
    + 'else if (joined.includes("secret")) process.stdout.write(secret);\n');
  writeStub(dir, 'aws', `process.stdout.write(${JSON.stringify(aws)});\n`);
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
    env: { ...process.env, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}`, KUBECTL_ARGV_LOG: join(dir, 'argv.log') },
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
        ['ssm://../../etc/passwd', /must not contain "\.\."/],
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
      assert.match(run.stdout, /digest:/, 'but a rotation is still visible as a change');
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
    assert.match(shape, /^<7 bytes, digest:[0-9a-f]{12}>$/);
    assert.ok(!shape.includes('hunter'));
    assert.notEqual(shapeOf('a'), shapeOf('b'));
    assert.equal(shapeOf('same'), shapeOf('same'), 'and is stable, or every run reports drift');
  });
});

describe('what the review found, kept as tests', () => {
  test('a manifest compared against an identical live ConfigMap reports no drift', () => {
    // The documented headline case. The parser wraps a manifest carrying
    // apiVersion + kind + metadata.name under a synthetic document key, so the
    // `data` block sits a level below where the comparison looked -- and every
    // such run reported the whole manifest as drift and exited 1 forever.
    const live = { pool_size: '5', tls: 'true' };
    const dir = projectWithStubs({
      configmap: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'api', namespace: 'prod' }, data: live },
    });
    try {
      writeFileSync(join(dir, 'cm.yaml'),
        'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: api\n  namespace: prod\n'
        + 'data:\n  pool_size: "5"\n  tls: "true"\n', 'utf8');
      const run = runDrift(dir, ['cm.yaml', '--against', 'k8s://prod/configmap/api', '--fail-on-drift']);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /No drift/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a live value under a secret-shaped key is masked, like every other output path', () => {
    // drift was the only render path in Flecto with no masking -- and it is the
    // one printing values read out of a live system into a CI log.
    const dir = projectWithStubs({ configmap: { data: { db_password: 'live-plaintext-pw' } } });
    try {
      writeFileSync(join(dir, 'cm.yaml'), 'data:\n  db_password: "old-pw"\n', 'utf8');
      // Both output paths. A JSON report is the likelier one to be archived as
      // a CI artifact, so leaving it raw would outlive the run.
      for (const args of [[], ['--format', 'json']]) {
        const run = runDrift(dir, ['cm.yaml', '--against', 'k8s://prod/configmap/api', ...args]);
        assert.ok(!run.stdout.includes('live-plaintext-pw'), `leaked in ${args.join(' ') || 'human'}: ${run.stdout}`);
        assert.match(run.stdout, /\*\*\*/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ssm:// without a path is refused rather than reading the whole account', () => {
    const dir = projectWithStubs();
    try {
      const run = runDrift(dir, ['app.yaml', '--against', 'ssm://']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /needs a parameter path/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('one SecureString does not make every plain parameter look changed', () => {
    // Shaping was decided per *source*, so a single sensitive value shaped the
    // whole declared side and every non-secret key drifted on every run.
    const dir = projectWithStubs({
      aws: {
        Parameters: [
          { Name: '/app/region', Value: 'us-east-1', Type: 'String' },
          { Name: '/app/db_pw', Value: 'enc', Type: 'SecureString' },
        ],
      },
    });
    try {
      writeFileSync(join(dir, 'ssm.yaml'), 'region: us-east-1\ndb_pw: enc\n', 'utf8');
      const run = runDrift(dir, ['ssm.yaml', '--against', 'ssm:///app', '--format', 'json']);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(JSON.parse(run.stdout).drifted, false, run.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('two different secret values do not collapse to one shape', () => {
    // String(value) turned every object into "[object Object]", so a rotation
    // between two structured secrets was invisible.
    assert.notEqual(shapeOf(JSON.stringify({ a: 1 })), shapeOf(JSON.stringify({ b: 2 })));
  });

  test('the printed digest is keyed, so a log does not carry an offline oracle', () => {
    // An unsalted truncated SHA-256 of a low-entropy secret is brute-forceable
    // from the log alone, and is a stable cross-run identifier. Both sides are
    // hashed in one process, so keying costs nothing.
    const run = spawnSync(process.execPath, ['-e',
      "import('./src/drift-sources.js').then(m => process.stdout.write(m.shapeOf('hunter2')))"],
    { encoding: 'utf8' });
    assert.match(run.stdout, /^<7 bytes, digest:[0-9a-f]{12}>$/);
    assert.notEqual(run.stdout, shapeOf('hunter2'), 'a different process must produce a different digest');
  });

  test('a tool answering with non-JSON does not have its bytes echoed', () => {
    const dir = projectWithStubs();
    try {
      writeFileSync(join(dir, 'bin', 'kubectl'), '#!/bin/sh\necho "## leaked-looking header"\n', 'utf8');
      chmodSync(join(dir, 'bin', 'kubectl'), 0o755);
      const run = runDrift(dir, ['app.yaml', '--against', 'k8s://prod/configmap/api']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /did not return the JSON document expected/);
      assert.ok(!run.stderr.includes('leaked-looking'), run.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the second review round, kept as tests', () => {
  test('masking is decided on the value, not on the key it sits under', () => {
    // The leak: the exemption trusted `shapedKeys`, which is metadata that can
    // fall out of step with the value beside it. A declared key with no live
    // counterpart is a raw value under a secret-shaped name and must be masked,
    // while the shapes beside it must survive.
    const dir = projectWithStubs({ secret: { data: { db_password: 'bGl2ZQ==' } } });
    try {
      writeFileSync(join(dir, 'sec.yaml'), 'db_password: declared\napi_token: MUST_NOT_PRINT_THIS\n', 'utf8');
      for (const args of [[], ['--format', 'json']]) {
        const run = runDrift(dir, ['sec.yaml', '--against', 'k8s://prod/secret/creds', ...args]);
        assert.ok(!run.stdout.includes('MUST_NOT_PRINT_THIS'), `leaked: ${run.stdout}`);
        assert.match(run.stdout, /\*\*\*/, 'the unshaped value is masked');
        assert.match(run.stdout, /digest:/, 'and the shapes beside it survive');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('two parameters resolving to one key are refused at the source', () => {
    // How state and shapedKeys came to disagree in the first place.
    const dir = projectWithStubs({
      aws: {
        Parameters: [
          { Name: '/app/prod/db_password', Value: 'shaped', Type: 'SecureString' },
          { Name: '/app/prod/db_password', Value: 'LIVE_PLAINTEXT', Type: 'String' },
        ],
      },
    });
    try {
      writeFileSync(join(dir, 'a.yaml'), 'db_password: declared\n', 'utf8');
      const run = runDrift(dir, ['a.yaml', '--against', 'ssm:///app/prod']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /resolve to the same key/);
      assert.ok(!run.stdout.includes('LIVE_PLAINTEXT'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('every root-equivalent ssm path is refused, not just the bare one', () => {
    // A single `=== "/"` check left //, /., /./ and /.// reaching the CLI, and
    // leaning on AWS to normalize them is the wrong place to draw the line.
    const dir = projectWithStubs();
    try {
      for (const uri of ['ssm://', 'ssm:///', 'ssm:////', 'ssm://.', 'ssm://./', 'ssm://.//', 'ssm:///./']) {
        const run = runDrift(dir, ['app.yaml', '--against', uri]);
        assert.equal(run.status, 1, uri);
        assert.match(run.stderr, /needs a parameter path/, uri);
      }
      assert.ok(!existsSync(join(dir, 'argv.log')), 'and none of them spawned aws');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a document keyed literally "data" does not swallow the rest of the file', () => {
    // Document identity falls back to a top-level `id`/`name`, so a document
    // can be keyed `data`. Checking record.data before the multi-document
    // refusal matched that wrapper and dropped every other document.
    const dir = projectWithStubs();
    try {
      writeFileSync(join(dir, 'multi.yaml'),
        'name: data\nlog_level: info\n---\nname: second\nlog_level: DROPPED\n', 'utf8');
      const run = runDrift(dir, ['multi.yaml', '--against', 'k8s://prod/configmap/api']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /2 documents in this file/);
      assert.ok(!run.stdout.includes('DROPPED'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a stringData Secret manifest compares as a manifest, not as drift', () => {
    // readKubernetes merges data and stringData; looking only at `data` made a
    // plaintext Secret manifest report its whole self as drift.
    const dir = projectWithStubs({ secret: { data: { db_password: 'bGl2ZQ==' } } });
    try {
      writeFileSync(join(dir, 'sd.yaml'),
        'apiVersion: v1\nkind: Secret\nmetadata:\n  name: creds\n  namespace: prod\n'
        + 'stringData:\n  db_password: live\n', 'utf8');
      const run = runDrift(dir, ['sd.yaml', '--against', 'k8s://prod/secret/creds']);
      assert.doesNotMatch(run.stdout, /apiVersion|kind:|metadata/, run.stdout);
      assert.match(run.stdout, /db_password/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('descending into a data block says what it did not compare', () => {
    const dir = projectWithStubs({ configmap: { data: { log_level: 'info', retries: '3' } } });
    try {
      writeFileSync(join(dir, 'plain.yaml'),
        'log_level: SIBLING\nretries: "999"\ndata:\n  log_level: info\n  retries: "3"\n', 'utf8');
      const run = runDrift(dir, ['plain.yaml', '--against', 'k8s://prod/configmap/api']);
      assert.match(run.stderr, /other top-level key\(s\) in this file were not compared/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a JSON array from a tool is not accepted as a document', () => {
    const dir = projectWithStubs();
    try {
      writeStub(dir, 'kubectl', 'process.stdout.write("[\\"nope\\"]");\n');
      const run = runDrift(dir, ['app.yaml', '--against', 'k8s://prod/configmap/api']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /did not return the JSON document expected/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      assert.match(run.stdout, /digest:/);
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
