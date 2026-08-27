import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { normalizeGlobPattern, resolveFiles } from '../src/config.js';
import { parseContent } from '../src/parser.js';

/**
 * A small project with a config directory, used to check that a pattern
 * actually matches rather than only that it was rewritten.
 * @returns {string} project root
 */
function projectWithConfigs() {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-platform-'));
  mkdirSync(join(dir, 'config'));
  writeFileSync(join(dir, 'config', 'prod.yaml'), 'port: 8080\n', 'utf8');
  writeFileSync(join(dir, 'config', 'dev.yaml'), 'port: 3000\n', 'utf8');
  writeFileSync(join(dir, 'config', 'secrets.yaml'), 'token: x\n', 'utf8');
  return dir;
}

describe('Windows glob separators', () => {
  // The platform is injected rather than read from process.platform, so the
  // Windows behavior is asserted on every runner instead of only on Windows.

  test('a backslash pattern is rewritten to POSIX separators', () => {
    assert.equal(normalizeGlobPattern('config\\*.yaml', 'win32'), 'config/*.yaml');
    assert.equal(normalizeGlobPattern('config\\**\\*.yml', 'win32'), 'config/**/*.yml');
  });

  test('a drive-letter pattern keeps its drive and loses its backslashes', () => {
    assert.equal(normalizeGlobPattern('C:\\repo\\config\\*.yaml', 'win32'), 'C:/repo/config/*.yaml');
  });

  test('a UNC pattern is rewritten wholesale', () => {
    assert.equal(normalizeGlobPattern('\\\\server\\share\\*.yaml', 'win32'), '//server/share/*.yaml');
  });

  test('a pattern already using POSIX separators is untouched', () => {
    assert.equal(normalizeGlobPattern('config/*.yaml', 'win32'), 'config/*.yaml');
  });

  test('POSIX hosts are left alone, so glob escapes keep working', () => {
    // On POSIX a backslash is both a legal filename character and a glob
    // escape. Rewriting there would break patterns that work today.
    for (const platform of ['linux', 'darwin', 'freebsd']) {
      assert.equal(normalizeGlobPattern('config\\*.yaml', platform), 'config\\*.yaml');
      assert.equal(normalizeGlobPattern('weird\\ name.yaml', platform), 'weird\\ name.yaml');
    }
  });
});

describe('resolveFiles on a Windows-shaped invocation', () => {
  test('a backslash pattern matches the files it names', async () => {
    const dir = projectWithConfigs();
    try {
      // Without the rewrite fast-glob reads `\*` as an escaped literal star and
      // returns nothing -- the bug this reproduces.
      const matched = await resolveFiles({
        cwd: dir,
        files: ['config\\*.yaml'],
        platform: 'win32',
      });
      assert.deepEqual(
        matched.map((p) => p.split(sep).slice(-2).join('/')).sort(),
        ['config/dev.yaml', 'config/prod.yaml', 'config/secrets.yaml'],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the same pattern matches nothing when treated as POSIX', async () => {
    // Pins the failure being fixed: it is the platform branch that makes the
    // difference, not something incidental about the fixture.
    const dir = projectWithConfigs();
    try {
      const matched = await resolveFiles({
        cwd: dir,
        files: ['config\\*.yaml'],
        platform: 'linux',
      });
      assert.deepEqual(matched, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an exclude written with backslashes still excludes', async () => {
    // An exclude that silently stops excluding is the worse failure of the two:
    // it widens what Flecto reports on rather than narrowing it.
    const dir = projectWithConfigs();
    try {
      const matched = await resolveFiles({
        cwd: dir,
        files: ['config\\*.yaml'],
        exclude: ['config\\secrets.yaml'],
        platform: 'win32',
      });
      assert.deepEqual(
        matched.map((p) => p.split(sep).pop()).sort(),
        ['dev.yaml', 'prod.yaml'],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resolved paths come back native, not POSIX-ised', async () => {
    // Only the pattern is rewritten. Every fs call and the snapshot key
    // derivation downstream expect native separators.
    const dir = projectWithConfigs();
    try {
      const matched = await resolveFiles({
        cwd: dir,
        files: ['config\\prod.yaml'],
        platform: 'win32',
      });
      assert.equal(matched.length, 1);
      assert.equal(matched[0], resolve(join(dir, 'config', 'prod.yaml')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CRLF line endings', () => {
  // Handled correctly today, but nothing pinned it, so a future parser change
  // could regress it silently on the platform that produces CRLF by default.
  test('every line-oriented format parses CRLF the same as LF', () => {
    const cases = [
      ['app.yaml', 'port: 8080\r\ndatabase:\r\n  pool_size: 5\r\n', { port: 8080, database: { pool_size: 5 } }],
      ['app.ini', '[db]\r\npool_size = 5\r\n', { db: { pool_size: '5' } }],
      ['.env', 'PORT=8080\r\nDEBUG=false\r\n', { PORT: '8080', DEBUG: 'false' }],
      ['app.toml', 'port = 8080\r\n', { port: 8080 }],
      ['app.json', '{\r\n  "port": 8080\r\n}\r\n', { port: 8080 }],
    ];
    for (const [name, raw, expected] of cases) {
      assert.deepEqual(parseContent(name, raw), expected, name);
      assert.deepEqual(
        parseContent(name, raw),
        parseContent(name, raw.replaceAll('\r\n', '\n')),
        `${name}: CRLF and LF must produce the same tree`,
      );
    }
  });

  test('a CRLF file and its LF twin produce no diff', () => {
    // The case that matters in practice: a Windows checkout of a file a Linux
    // runner wrote must not read as a change to every line.
    const crlf = parseContent('app.yaml', 'a: 1\r\nb: 2\r\n');
    const lf = parseContent('app.yaml', 'a: 1\nb: 2\n');
    assert.deepEqual(crlf, lf);
  });
});
