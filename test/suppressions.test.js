import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import {
  suppressionFormat,
  parseSuppressions,
  applySuppressions,
} from '../src/suppressions.js';

const rootIndex = resolve(process.cwd(), 'index.js');

describe('suppressionFormat', () => {
  test('maps every comment-bearing format Flecto parses', () => {
    assert.equal(suppressionFormat('a.yaml'), 'yaml');
    assert.equal(suppressionFormat('a.yml'), 'yaml');
    assert.equal(suppressionFormat('a.toml'), 'toml');
    assert.equal(suppressionFormat('a.ini'), 'ini');
    assert.equal(suppressionFormat('.env'), 'dotenv');
    assert.equal(suppressionFormat('prod.env'), 'dotenv');
    // .json is parsed as JSONC (#152), so it does carry comments.
    assert.equal(suppressionFormat('tsconfig.json'), 'json');
    assert.equal(suppressionFormat('devcontainer.jsonc'), 'json');
    assert.equal(suppressionFormat('secrets.age'), null, 'an encrypted file carries no directive');
  });
});

describe('parseSuppressions — reason is mandatory', () => {
  test('accepts an em dash, double hyphen, colon, or bare reason', () => {
    for (const sep of ['—', '--', ':', '']) {
      const raw = `# flecto-ignore-next-line r ${sep} why it is fine\nkey: 1\n`;
      const { suppressions, errors } = parseSuppressions(raw, 'yaml');
      assert.equal(errors.length, 0, `sep ${JSON.stringify(sep)}`);
      assert.equal(suppressions[0].reason, 'why it is fine');
    }
  });

  test('a directive with no reason is an error, not a silent suppression', () => {
    const { suppressions, errors } = parseSuppressions('# flecto-ignore-next-line pool-size-jump\nkey: 1\n', 'yaml');
    assert.equal(suppressions.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /needs a reason/);
    assert.equal(errors[0].line, 1);
  });

  test('a directive with no rule id is an error', () => {
    const { errors } = parseSuppressions('# flecto-ignore-next-line\nkey: 1\n', 'yaml');
    assert.equal(errors.length, 1);
  });
});

describe('parseSuppressions — path reconstruction', () => {
  test('YAML nesting yields the full dotted path', () => {
    const raw = 'database:\n  # flecto-ignore-next-line pool-size-jump — ok\n  pool_size: 200\n';
    const { suppressions } = parseSuppressions(raw, 'yaml');
    assert.equal(suppressions[0].path, 'database.pool_size');
  });

  test('a deeper YAML path is reconstructed in full', () => {
    const raw = 'a:\n  b:\n    # flecto-ignore-next-line r — ok\n    c: 1\n';
    assert.equal(parseSuppressions(raw, 'yaml').suppressions[0].path, 'a.b.c');
  });

  test('dotenv is flat', () => {
    const raw = '# flecto-ignore-next-line secret-key-changed — rotating\nAPI_KEY=x\n';
    assert.equal(parseSuppressions(raw, 'dotenv').suppressions[0].path, 'API_KEY');
  });

  test('INI keys carry their section', () => {
    const raw = '[database]\n; flecto-ignore-next-line r — ok\npool_size=200\n';
    assert.equal(parseSuppressions(raw, 'ini').suppressions[0].path, 'database.pool_size');
  });

  test('TOML keys carry their table', () => {
    const raw = '[database]\n# flecto-ignore-next-line r — ok\npool_size = 200\n';
    assert.equal(parseSuppressions(raw, 'toml').suppressions[0].path, 'database.pool_size');
  });

  test('an array item cannot be resolved and is left to the baseline', () => {
    const raw = 'items:\n  # flecto-ignore-next-line r — ok\n  - name: x\n';
    assert.equal(parseSuppressions(raw, 'yaml').suppressions[0].path, null);
  });

  test('a multi-document file is left to the baseline', () => {
    const raw = 'kind: A\n---\n# flecto-ignore-next-line r — ok\nkind: B\n';
    assert.equal(parseSuppressions(raw, 'yaml').suppressions[0].path, null);
  });

  test('the directive skips blank and comment lines to find the config line', () => {
    const raw = 'database:\n  # flecto-ignore-next-line r — ok\n\n  # another comment\n  pool_size: 1\n';
    assert.equal(parseSuppressions(raw, 'yaml').suppressions[0].path, 'database.pool_size');
  });
});

describe('parseSuppressions — JSON', () => {
  test('a nested JSON key yields the full dotted path', () => {
    const raw = '{\n  "database": {\n    // flecto-ignore-next-line pool-size-jump — ok\n    "pool_size": 200\n  }\n}\n';
    assert.equal(parseSuppressions(raw, 'json').suppressions[0].path, 'database.pool_size');
  });

  test('a root-level JSON key has no prefix', () => {
    const raw = '{\n  // flecto-ignore-next-line r — ok\n  "debug": true\n}\n';
    assert.equal(parseSuppressions(raw, 'json').suppressions[0].path, 'debug');
  });

  test('a block comment is a comment, and the directive may sit inside one', () => {
    const raw = '{\n  "a": {\n    /* flecto-ignore-next-line r — ok */\n    "b": 1\n  }\n}\n';
    assert.equal(parseSuppressions(raw, 'json').suppressions[0].path, 'a.b');
  });

  test('the directive skips blank lines and further comments to reach the key', () => {
    const raw = '{\n  "a": {\n    // flecto-ignore-next-line r — ok\n\n    /* still\n       going */\n    "b": 1\n  }\n}\n';
    assert.equal(parseSuppressions(raw, 'json').suppressions[0].path, 'a.b');
  });

  test('a // inside a string value is data, not a comment', () => {
    // The naive strip is wrong on exactly the values config files are full of.
    const raw = '{\n  "a": {\n    "url": "https://example.com",\n    // flecto-ignore-next-line r — ok\n    "b": 1\n  }\n}\n';
    assert.equal(parseSuppressions(raw, 'json').suppressions[0].path, 'a.b');
  });

  test('a directive-shaped string value is data, not a suppression', () => {
    // The scanner reads raw lines, so a value that merely *says* the
    // directive would otherwise suppress the next key — over-suppression.
    const raw = '{\n  "note": "flecto-ignore-next-line r — ok",\n  "b": 1\n}\n';
    assert.equal(parseSuppressions(raw, 'json').suppressions.length, 0);
  });

  test('a brace inside a string value does not open a container', () => {
    const raw = '{\n  "a": "{ not an object",\n  // flecto-ignore-next-line r — ok\n  "b": 1\n}\n';
    assert.equal(parseSuppressions(raw, 'json').suppressions[0].path, 'b');
  });

  test('an escaped key is decoded to the name the differ reports', () => {
    const raw = '{\n  "a\\u002eb": {\n    // flecto-ignore-next-line r — ok\n    "c": 1\n  }\n}\n';
    assert.equal(parseSuppressions(raw, 'json').suppressions[0].path, 'a.b.c');
  });

  test('a key whose value opens on the same line resolves to that key', () => {
    const raw = '{\n  // flecto-ignore-next-line r — ok\n  "a": { "b": 1 }\n}\n';
    assert.equal(parseSuppressions(raw, 'json').suppressions[0].path, 'a');
  });

  test('anything inside an array is refused, and refused loudly', () => {
    // An array element's diff path is its index or its arrayIdKey identity
    // depending on the run, so resolving one would suppress the wrong finding
    // under the other configuration.
    const raw = '{\n  "items": [\n    // flecto-ignore-next-line r — ok\n    { "name": "x" }\n  ]\n}\n';
    const { suppressions, warnings } = parseSuppressions(raw, 'json');
    assert.equal(suppressions[0].path, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /does not resolve to a config key/);
    assert.equal(warnings[0].line, 3);
  });

  test('a key nested below an array is refused too', () => {
    const raw = '{\n  "items": [\n    {\n      // flecto-ignore-next-line r — ok\n      "name": "x"\n    }\n  ]\n}\n';
    assert.equal(parseSuppressions(raw, 'json').suppressions[0].path, null);
  });

  test('a JSON array root is refused', () => {
    const raw = '[\n  // flecto-ignore-next-line r — ok\n  { "a": 1 }\n]\n';
    assert.equal(parseSuppressions(raw, 'json').suppressions[0].path, null);
  });

  test('a reason is still mandatory in JSON', () => {
    const { suppressions, errors } = parseSuppressions('{\n  // flecto-ignore-next-line r\n  "a": 1\n}\n', 'json');
    assert.equal(suppressions.length, 0);
    assert.match(errors[0].message, /needs a reason/);
  });
});

describe('parseSuppressions — a directive that does nothing says so', () => {
  test('a file type with no inline support warns instead of failing silently', () => {
    const { suppressions, errors, warnings } = parseSuppressions(
      '# flecto-ignore-next-line r — ok\nkey: 1\n',
      null,
    );
    assert.deepEqual(suppressions, []);
    assert.deepEqual(errors, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /do not apply to this file type/);
    assert.match(warnings[0].message, /--baseline/);
  });

  test('an unresolvable YAML sequence item warns rather than vanishing', () => {
    const raw = 'items:\n  # flecto-ignore-next-line r — ok\n  - name: x\n';
    const { warnings } = parseSuppressions(raw, 'yaml');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].line, 2);
  });

  test('a resolvable directive warns about nothing', () => {
    const raw = 'database:\n  # flecto-ignore-next-line r — ok\n  pool_size: 1\n';
    assert.deepEqual(parseSuppressions(raw, 'yaml').warnings, []);
  });
});

describe('applySuppressions — no over-suppression', () => {
  const findings = [
    { id: 'pool-size-jump', path: 'database.pool_size', severity: 'warn' },
    { id: 'pool-size-jump', path: 'services.api.pool_size', severity: 'warn' },
    { id: 'secret-key-changed', path: 'database.pool_size', severity: 'error' },
  ];

  test('suppresses only the exact (rule, full path), leaving siblings and other rules', () => {
    const suppressions = [{ rule: 'pool-size-jump', reason: 'ok', line: 1, path: 'database.pool_size' }];
    const { active, suppressed } = applySuppressions(findings, suppressions);
    assert.deepEqual(suppressed.map((s) => s.finding.path), ['database.pool_size']);
    assert.deepEqual(
      active.map((f) => `${f.id}@${f.path}`),
      ['pool-size-jump@services.api.pool_size', 'secret-key-changed@database.pool_size'],
    );
  });

  test('tolerates a document-identity prefix via suffix match', () => {
    const prefixed = [{ id: 'pool-size-jump', path: 'Deployment/api.database.pool_size', severity: 'warn' }];
    const suppressions = [{ rule: 'pool-size-jump', reason: 'ok', line: 1, path: 'database.pool_size' }];
    const { active, suppressed } = applySuppressions(prefixed, suppressions);
    assert.equal(suppressed.length, 1);
    assert.equal(active.length, 0);
  });

  test('a null-path suppression (unresolvable line) matches nothing', () => {
    const suppressions = [{ rule: 'pool-size-jump', reason: 'ok', line: 1, path: null }];
    const { active, suppressed } = applySuppressions(findings, suppressions);
    assert.equal(suppressed.length, 0);
    assert.equal(active.length, 3);
  });
});

describe('flecto ci inline suppressions (end to end)', () => {
  function ci(dir, file, args) {
    return spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', 'snap.json', ...args],
      { cwd: dir, encoding: 'utf8' },
    );
  }

  test('suppresses the named finding but not an uncommented sibling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-suppress-'));
    try {
      writeFileSync(
        join(dir, 'config.yaml'),
        'database:\n  # flecto-ignore-next-line pool-size-jump — Black Friday, reverting Dec\n  pool_size: 200\n'
        + 'services:\n  api:\n    pool_size: 300\n',
        'utf8',
      );
      writeFileSync(
        join(dir, 'snap.json'),
        JSON.stringify({ state: { database: { pool_size: 5 }, services: { api: { pool_size: 5 } } } }),
        'utf8',
      );
      const run = ci(dir, 'config.yaml', ['--fail-on', 'policy', '--format', 'json']);
      // The sibling still fails; the suppressed one is gone from output.
      assert.equal(run.status, 1);
      const paths = JSON.parse(run.stdout).flatMap((r) => r.policies.map((p) => p.path));
      assert.deepEqual(paths, ['services.api.pool_size']);
      assert.match(run.stderr, /1 finding suppressed inline/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing reason fails the run with a pointer to the line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-suppress-bad-'));
    try {
      writeFileSync(
        join(dir, 'config.yaml'),
        'database:\n  # flecto-ignore-next-line pool-size-jump\n  pool_size: 200\n',
        'utf8',
      );
      writeFileSync(join(dir, 'snap.json'), JSON.stringify({ state: { database: { pool_size: 5 } } }), 'utf8');
      const run = ci(dir, 'config.yaml', ['--fail-on', 'policy']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /missing a required reason/);
      assert.match(run.stderr, /config\.yaml:2/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--show-suppressed lists the rule, path, and reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-suppress-show-'));
    try {
      writeFileSync(
        join(dir, 'config.yaml'),
        'database:\n  # flecto-ignore-next-line pool-size-jump — intended\n  pool_size: 200\n',
        'utf8',
      );
      writeFileSync(join(dir, 'snap.json'), JSON.stringify({ state: { database: { pool_size: 5 } } }), 'utf8');
      const run = ci(dir, 'config.yaml', ['--fail-on', 'policy', '--show-suppressed']);
      assert.equal(run.status, 0, 'the only finding is suppressed, so the gate passes');
      assert.match(run.stderr, /database\.pool_size: pool-size-jump — intended/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a JSONC file suppresses the named finding but not an uncommented sibling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-suppress-json-'));
    try {
      writeFileSync(
        join(dir, 'app.json'),
        '{\n'
        + '  "database": {\n'
        + '    /* reviewed with the DBA */\n'
        + '    // flecto-ignore-next-line pool-size-jump — Black Friday, reverting Dec\n'
        + '    "pool_size": 200\n'
        + '  },\n'
        + '  "services": { "api": { "pool_size": 300 } }\n'
        + '}\n',
        'utf8',
      );
      writeFileSync(
        join(dir, 'snap.json'),
        JSON.stringify({ state: { database: { pool_size: 5 }, services: { api: { pool_size: 5 } } } }),
        'utf8',
      );
      const run = ci(dir, 'app.json', ['--fail-on', 'policy', '--format', 'json']);
      assert.equal(run.status, 1, 'the uncommented sibling still fails the gate');
      const paths = JSON.parse(run.stdout).flatMap((r) => r.policies.map((p) => p.path));
      assert.deepEqual(paths, ['services.api.pool_size']);
      assert.match(run.stderr, /1 finding suppressed inline/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The suppression path has to agree with the *diff* path for the same line,
  // and an array element's diff path depends on how the run diffs arrays. The
  // resolver refuses arrays rather than picking one, so the contract to pin is
  // that it refuses -- and says so -- under every array mode, not just the
  // default one.
  for (const [mode, extra] of [['by index', []], ['by identity key', ['--array-id-key', 'name']]]) {
    test(`a directive on an array element is refused loudly when arrays are diffed ${mode}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'flecto-suppress-array-'));
      try {
        writeFileSync(
          join(dir, 'app.json'),
          '{\n'
          + '  "pools": [\n'
          + '    // flecto-ignore-next-line pool-size-jump — not addressable inline\n'
          + '    { "name": "primary", "pool_size": 200 }\n'
          + '  ]\n'
          + '}\n',
          'utf8',
        );
        writeFileSync(
          join(dir, 'snap.json'),
          JSON.stringify({ state: { pools: [{ name: 'primary', pool_size: 5 }] } }),
          'utf8',
        );
        const run = ci(dir, 'app.json', ['--fail-on', 'policy', '--format', 'json', ...extra]);

        assert.equal(run.status, 1, 'the finding is not suppressed, so the gate still fails');
        const paths = JSON.parse(run.stdout).flatMap((r) => r.policies.map((p) => p.path));
        assert.equal(paths.length, 1);
        assert.match(paths[0], /pool_size$/);
        assert.match(run.stderr, /does not resolve to a config key/);
        assert.match(run.stderr, /app\.json:3/);
        assert.doesNotMatch(run.stderr, /suppressed inline/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('machine output on stdout stays clean — the summary is on stderr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-suppress-clean-'));
    try {
      writeFileSync(
        join(dir, 'config.yaml'),
        'database:\n  # flecto-ignore-next-line pool-size-jump — intended\n  pool_size: 200\n',
        'utf8',
      );
      writeFileSync(join(dir, 'snap.json'), JSON.stringify({ state: { database: { pool_size: 5 } } }), 'utf8');
      const run = ci(dir, 'config.yaml', ['--fail-on', '', '--format', 'json']);
      assert.doesNotThrow(() => JSON.parse(run.stdout), 'stdout is valid JSON');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
