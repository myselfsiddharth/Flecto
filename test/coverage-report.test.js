import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve(process.cwd(), 'scripts/coverage-report.js');

/**
 * One lcov record. Only the summary counters are read, so the per-line records
 * a real report carries are omitted.
 * @param {string} file
 * @param {{ lines: number[], branches: number[], functions: number[] }} counts
 * @returns {string}
 */
function record(file, { lines, branches, functions }) {
  return [
    'TN:',
    `SF:${file}`,
    `FNF:${functions[0]}`,
    `FNH:${functions[1]}`,
    `BRF:${branches[0]}`,
    `BRH:${branches[1]}`,
    `LF:${lines[0]}`,
    `LH:${lines[1]}`,
    'end_of_record',
  ].join('\n');
}

const FULL = [
  record('src/config.js', { lines: [100, 50], branches: [10, 2], functions: [10, 5] }),
  record('src/policy.js', { lines: [100, 90], branches: [10, 9], functions: [10, 9] }),
  record('src/secrets.js', { lines: [100, 100], branches: [10, 10], functions: [10, 10] }),
  record('src/encrypted.js', { lines: [100, 80], branches: [10, 8], functions: [10, 8] }),
  record('src/pr-comment.js', { lines: [100, 70], branches: [10, 7], functions: [10, 7] }),
  record('src/renderer.js', { lines: [100, 10], branches: [10, 1], functions: [10, 1] }),
].join('\n');

/**
 * @param {string} lcov
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function report(lcov) {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-coverage-'));
  try {
    const path = join(dir, 'coverage.lcov');
    writeFileSync(path, lcov, 'utf8');
    return spawnSync(process.execPath, [script, path], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('coverage report', () => {
  test('separates the security-relevant modules from everything else', () => {
    const run = report(FULL);
    assert.equal(run.status, 0);

    const focus = run.stdout.slice(
      run.stdout.indexOf('Security-relevant modules'),
      run.stdout.indexOf('Everything else'),
    );
    for (const file of ['config.js', 'policy.js', 'secrets.js', 'encrypted.js', 'pr-comment.js']) {
      assert.match(focus, new RegExp(file.replace('.', '\\.')), `${file} is on the focused list`);
    }
    // src/renderer.js has the worst coverage in the fixture, and is deliberately
    // not on the focused list -- one repo-wide worst-first table would put it on
    // top and bury the modules the review is actually about.
    assert.doesNotMatch(focus, /renderer\.js/);
  });

  test('orders each table worst branch coverage first', () => {
    const run = report(FULL);
    const focus = run.stdout.slice(
      run.stdout.indexOf('Security-relevant modules'),
      run.stdout.indexOf('subtotal'),
    );
    const order = [...focus.matchAll(/src\/([a-z-]+)\.js/g)].map((match) => match[1]);
    assert.deepEqual(order, ['config', 'pr-comment', 'encrypted', 'policy', 'secrets']);
  });

  test('reports missed branches, which is the number the report exists for', () => {
    const run = report(FULL);
    // src/config.js: 10 branches found, 2 hit.
    assert.match(run.stdout, /src\/config\.js\s+50\.0%\s+20\.0%\s+50\.0%\s+8/);
  });

  test('never fails on a coverage number, however low', () => {
    const run = report(FULL.replace('BRH:2', 'BRH:0'));
    assert.equal(run.status, 0, 'no threshold gates the job');
    assert.match(run.stdout, /No threshold gates this job/);
  });

  test('a metric with nothing to count reads n/a, not 100%', () => {
    const run = report(FULL.replace('BRF:10\nBRH:2', 'BRF:0\nBRH:0'));
    assert.match(run.stdout, /src\/config\.js\s+50\.0%\s+n\/a/);
  });

  test('fails loudly when a focused module is missing from the report', () => {
    // A renamed or moved module would otherwise drop out of the focused table
    // silently, leaving a report that describes fewer modules than it claims to.
    const run = report(FULL.replace('SF:src/secrets.js', 'SF:src/secret-detection.js'));
    assert.equal(run.status, 1);
    assert.match(run.stderr, /does not cover: src\/secrets\.js/);
    assert.match(run.stderr, /SECURITY_RELEVANT/);
  });

  test('missing coverage data points at the command that produces it', () => {
    const run = spawnSync(process.execPath, [script, join(tmpdir(), 'flecto-no-such.lcov')], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /npm run test:coverage/);
  });
});
