import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { evaluatePolicies } from '../src/policy.js';
import { diffTrees } from '../src/differ.js';
import { parseContent, isSupported, parseIni } from '../src/parser.js';
import { createEnvelope, EVENT_SCHEMA_VERSION } from '../src/envelope.js';
import { spawnSync } from 'child_process';

describe('policy packs and plugins', () => {
  test('local policies/ pack overrides builtin id when present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-pack-'));
    try {
      mkdirSync(join(dir, 'policies'));
      writeFileSync(join(dir, 'policies', 'default.json'), JSON.stringify({
        id: 'default',
        rules: [{
          id: 'custom-only',
          severity: 'error',
          when: ['changed'],
          match: { path: 'flip' },
          message: 'custom pack hit',
        }],
      }), 'utf8');

      const findings = await evaluatePolicies(
        [{ type: 'changed', path: 'flip', before: false, after: true }],
        { cwd: dir, policies: ['default'] },
      );
      assert.equal(findings.length, 1);
      assert.equal(findings[0].id, 'custom-only');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('plugin evaluate findings merge with packs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-plugin-'));
    try {
      const pluginPath = join(dir, 'plugin.js');
      writeFileSync(pluginPath, `
        export function evaluate(changes) {
          return changes
            .filter((c) => c.path === 'special')
            .map((c) => ({
              id: 'plugin-special',
              severity: 'error',
              path: c.path,
              message: 'from plugin',
            }));
        }
      `, 'utf8');

      const findings = await evaluatePolicies(
        [
          { type: 'changed', path: 'special', before: 1, after: 2 },
          { type: 'changed', path: 'auth.api_key', before: 'a', after: 'b' },
        ],
        {
          cwd: dir,
          policies: ['default'],
          plugins: [pluginPath],
        },
      );
      assert.ok(findings.some((f) => f.id === 'plugin-special'));
      assert.ok(findings.some((f) => f.id === 'secret-key-changed'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('conflicting packs keep highest severity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-conflict-'));
    try {
      mkdirSync(join(dir, 'policies'));
      writeFileSync(join(dir, 'policies', 'soft.json'), JSON.stringify({
        id: 'soft',
        rules: [{
          id: 'pool-size-jump',
          severity: 'info',
          when: ['changed'],
          match: { path: 'pool_size$', pathFlags: 'i' },
          numericJump: { minMultiple: 2 },
          message: 'soft',
        }],
      }), 'utf8');

      const findings = await evaluatePolicies(
        [{ type: 'changed', path: 'db.pool_size', before: 2, after: 8 }],
        { cwd: dir, policies: ['soft', 'strict-prod'] },
      );
      assert.equal(findings.length, 1);
      assert.equal(findings[0].severity, 'error');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('array identity diff', () => {
  test('reorder with arrayIdKey produces no changes', () => {
    const before = { servers: [{ id: 'a', port: 1 }, { id: 'b', port: 2 }] };
    const after = { servers: [{ id: 'b', port: 2 }, { id: 'a', port: 1 }] };
    const events = diffTrees(before, after, { arrayIdKey: 'id' });
    assert.equal(events.length, 0);
  });

  test('without arrayIdKey reorder looks like changes', () => {
    const before = { servers: [{ id: 'a', port: 1 }, { id: 'b', port: 2 }] };
    const after = { servers: [{ id: 'b', port: 2 }, { id: 'a', port: 1 }] };
    const events = diffTrees(before, after);
    assert.ok(events.length > 0);
  });
});

describe('parser expansions', () => {
  test('supports .env.local and app.env', () => {
    assert.equal(isSupported('.env.local'), true);
    assert.equal(isSupported('app.env'), true);
    const parsed = parseContent('.env.local', 'FOO=bar\n');
    assert.equal(parsed.FOO, 'bar');
  });

  test('parses ini sections', () => {
    assert.equal(isSupported('app.ini'), true);
    const parsed = parseIni(`[db]\nhost = localhost\n`);
    assert.equal(parsed.db.host, 'localhost');
  });
});

describe('envelope 2.0', () => {
  test('emits schema 2.0 with policies field', () => {
    const envelope = createEnvelope({
      file: 'x.json',
      source: 'ci',
      changes: [],
      policies: [{ id: 'x', severity: 'error', path: 'a', message: 'm', pack: 'default' }],
    });
    assert.equal(EVENT_SCHEMA_VERSION, '2.0');
    assert.equal(envelope.schema_version, '2.0');
    assert.equal(envelope.policies.length, 1);
  });
});

test('ci fails closed when snapshot-ref cannot be resolved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-ci-fail-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ a: 1 }), 'utf8');
  const rootIndex = resolve(process.cwd(), 'index.js');
  const run = spawnSync(
    process.execPath,
    [rootIndex, 'ci', file, '--snapshot-ref', 'not-a-real-ref-zzz', '--format', 'json'],
    { encoding: 'utf8', cwd: dir },
  );
  rmSync(dir, { recursive: true, force: true });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Failed to resolve snapshot baseline/);
});
