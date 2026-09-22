import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { resolve } from 'path';
import { compilePattern, checkPattern } from '../src/regex-engine.js';
import { loadPack } from '../src/policy.js';

const rootIndex = resolve(process.cwd(), 'index.js');

describe('pack-supplied regexes run on a linear-time engine (#121)', () => {
  // A committed policies/*.json plus a .flectorc selecting it is attacker
  // input on an untrusted pull request, and JavaScript's engine backtracks:
  // `^(a+)+$` against 45 characters took 97 SECONDS here, which is a denial of
  // service against the merge gate itself. No in-process timeout helps -- the
  // backtracking happens inside one uninterruptible call into the engine.

  test('a catastrophic pattern is answered in milliseconds, not minutes', () => {
    const compiled = compilePattern('^(a+)+$');
    const payload = `${'a'.repeat(44)}!`;
    const start = Date.now();
    assert.equal(compiled.test(payload), false);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `took ${elapsed}ms; the native engine takes ~97s on this input`);
  });

  test('the same pattern in a committed pack does not hang flecto ci', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-redos-'));
    try {
      mkdirSync(join(dir, 'policies'), { recursive: true });
      writeFileSync(join(dir, 'policies', 'evil.json'), JSON.stringify({
        id: 'evil',
        rules: [{ id: 'evil', severity: 'error', afterMatches: '^(a+)+$', message: 'x' }],
      }), 'utf8');
      writeFileSync(join(dir, '.flectorc'), JSON.stringify({ defaults: { policies: ['evil'] } }), 'utf8');
      writeFileSync(join(dir, 'app.yaml'), `x: ${'a'.repeat(44)}!\n`, 'utf8');
      writeFileSync(join(dir, 'snap.json'), JSON.stringify({ state: { x: 'before' } }), 'utf8');

      const start = Date.now();
      const run = spawnSync(process.execPath, [rootIndex, 'ci', 'app.yaml', '--snapshot-file', 'snap.json'], {
        cwd: dir, encoding: 'utf8', timeout: 20_000,
      });
      const elapsed = Date.now() - start;
      assert.notEqual(run.signal, 'SIGTERM', 'the run must not have to be killed');
      assert.ok(elapsed < 15_000, `flecto ci took ${elapsed}ms on a pathological pack regex`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the packs Flecto ships keep the native engine, so their lookahead still works', () => {
    // github-actions.json uses `^.+@(?![0-9a-fA-F]{40}$).+$` to mean "not
    // pinned to a full SHA". RE2 has no lookahead, and these packs are not
    // attacker-reachable, so they are compiled natively and unchanged.
    const pack = loadPack('github-actions');
    const rule = pack.rules.find((r) => typeof r.afterMatches === 'string' && r.afterMatches.includes('(?!'));
    assert.ok(rule, 'the lookahead rule is still in the shipped pack');
    assert.ok(checkPattern(rule.afterMatches, '', { trusted: true }).ok);
    assert.equal(checkPattern(rule.afterMatches, '', { trusted: false }).ok, false);
  });

  test('an untrusted pack using lookahead fails to load, and the message says why', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-lookahead-'));
    try {
      mkdirSync(join(dir, 'policies'), { recursive: true });
      writeFileSync(join(dir, 'policies', 'look.json'), JSON.stringify({
        id: 'look',
        rules: [{ id: 'look', severity: 'warn', afterMatches: '^(?=secret).+$', message: 'x' }],
      }), 'utf8');
      assert.throws(
        () => loadPack('look', dir),
        /does not\s+support lookahead, lookbehind, or backreferences/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the ordinary patterns a pack actually uses are unaffected', () => {
    for (const [pattern, flags, value, expected] of [
      ['^db\\..*password$', '', 'db.main.password', true],
      ['^v[0-9]+\\.[0-9]+$', '', 'v1.24', true],
      ['prod', 'i', 'PRODUCTION', true],
      ['\\p{L}+', 'u', 'abc', true],
      ['^never$', '', 'nope', false],
    ]) {
      assert.equal(compilePattern(pattern, flags).test(value), expected, `${pattern} vs ${value}`);
    }
  });

  test('a flag RE2 cannot honour is refused rather than silently dropped', () => {
    assert.equal(checkPattern('x', 'q').ok, false);
    // g/y/u/v are meaningless or native here, and are accepted.
    for (const flags of ['g', 'y', 'u', 'v', 'gi']) {
      assert.equal(checkPattern('x', flags).ok, true, `flags ${flags}`);
    }
  });
});
