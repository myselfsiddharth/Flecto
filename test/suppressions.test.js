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
  test('maps comment-bearing formats and excludes JSON', () => {
    assert.equal(suppressionFormat('a.yaml'), 'yaml');
    assert.equal(suppressionFormat('a.yml'), 'yaml');
    assert.equal(suppressionFormat('a.toml'), 'toml');
    assert.equal(suppressionFormat('a.ini'), 'ini');
    assert.equal(suppressionFormat('.env'), 'dotenv');
    assert.equal(suppressionFormat('prod.env'), 'dotenv');
    assert.equal(suppressionFormat('a.json'), null, 'JSON has no comments — unsupported');
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
