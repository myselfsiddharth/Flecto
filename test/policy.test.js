import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluatePolicies, highestSeverity, mergeFindings, loadPack, listBuiltinPackIds,
} from '../src/policy.js';

async function evaluateCustomPack(rules, changes) {
  const cwd = mkdtempSync(join(tmpdir(), 'flecto-policy-'));
  try {
    const policiesDir = join(cwd, 'policies');
    mkdirSync(policiesDir);
    writeFileSync(join(policiesDir, 'test.json'), JSON.stringify({ id: 'test', rules }));
    return await evaluatePolicies(changes, { cwd, policies: ['test'] });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('policy engine', () => {
  test('flags secret-looking key changes', async () => {
    const findings = await evaluatePolicies([
      { type: 'changed', path: 'auth.api_key', before: 'a', after: 'b' },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'error');
    assert.equal(findings[0].pack, 'default');
  });

  test('flags secret-looking keys that are newly added', async () => {
    const findings = await evaluatePolicies([
      { type: 'added', path: 'auth.api_key', after: 'new-secret' },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, 'secret-key-changed');
    assert.equal(findings[0].severity, 'error');
  });

  test('flags a secret-shaped value stored under an innocuous key', async () => {
    const findings = await evaluatePolicies([
      {
        type: 'added',
        path: 'db.connstr',
        after: 'postgres://app:7Kq2vNbXp9TzR4wY@db.internal.example.test:5432/appdb',
      },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, 'secret-value-detected');
    assert.equal(findings[0].severity, 'error');
    assert.equal(findings[0].path, 'db.connstr');
  });

  test('flags a known token format nested under a benign parent path', async () => {
    const findings = await evaluatePolicies([
      {
        type: 'changed',
        path: 'service',
        before: { value: 'unset' },
        after: { value: 'AKIAIOSFODNN7EXAMPLE' },
      },
    ]);
    assert.deepEqual(findings.map((finding) => finding.id), ['secret-value-detected']);
  });

  test('reports both secret rules when a secret value sits under a secret-looking key', async () => {
    const findings = await evaluatePolicies([
      {
        type: 'changed',
        path: 'auth.api_key',
        before: 'unset',
        after: 'ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5',
      },
    ]);
    assert.deepEqual(
      findings.map((finding) => finding.id).sort(),
      ['secret-key-changed', 'secret-value-detected'],
    );
  });

  test('does not flag benign values that merely look opaque', async () => {
    const findings = await evaluatePolicies([
      { type: 'changed', path: 'db.host', before: 'db.old.example.test', after: 'db.internal.example.test' },
      { type: 'changed', path: 'app.version', before: '2.0.0', after: '2.1.0-rc.1' },
      {
        type: 'changed',
        path: 'build.commit',
        before: '9f2b7c1a4d5e6f708192a3b4c5d6e7f8091a2b3c',
        after: 'c3b2a1908f7e6d5c4b3a2019f8e7d6c5b4a30291',
      },
      { type: 'added', path: 'request.trace_id', after: '550e8400-e29b-41d4-a716-446655440000' },
      { type: 'added', path: 'paths.cache', after: '/var/lib/Docker/Volumes/AppData2024/backups' },
      { type: 'added', path: 'image.ref', after: 'ghcr.io/acme/checkout-service:1.14.2' },
    ]);
    assert.deepEqual(findings, []);
  });

  test('silences value-based secret detection with an off remap', async () => {
    const findings = await evaluatePolicies(
      [{ type: 'added', path: 'db.connstr', after: 'AKIAIOSFODNN7EXAMPLE' }],
      { severityRemap: { 'secret-value-detected': 'off' } },
    );
    assert.deepEqual(findings, []);
  });

  test('flags large pool size increase', async () => {
    const findings = await evaluatePolicies([
      { type: 'changed', path: 'database.pool_size', before: 10, after: 40 },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'warn');
  });

  test('flags dangerous toggles set to boolean true', async () => {
    const findings = await evaluatePolicies([
      { type: 'changed', path: 'debug', before: false, after: true },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, 'dangerous-toggle-enabled');
  });

  test('flags dangerous toggles set to truthy strings', async () => {
    for (const value of ['true', '1', 'yes']) {
      const findings = await evaluatePolicies([
        { type: 'changed', path: 'debug', before: 'false', after: value },
      ]);
      assert.equal(findings.length, 1, `expected ${value} to match`);
      assert.equal(findings[0].id, 'dangerous-toggle-enabled');
    }
  });

  test('does not flag dangerous toggles set to false values', async () => {
    for (const value of [false, 'false']) {
      const findings = await evaluatePolicies([
        { type: 'changed', path: 'debug', before: true, after: value },
      ]);
      assert.equal(findings.length, 0, `expected ${String(value)} not to match`);
    }
  });

  test('remaps a built-in pack rule severity', async () => {
    const findings = await evaluatePolicies(
      [{ type: 'changed', path: 'database.pool_size', before: 10, after: 40 }],
      { severityRemap: { 'pool-size-jump': 'error' } },
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'error');
  });

  test('silences a local pack rule with an off remap', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'flecto-remap-local-'));
    mkdirSync(join(cwd, 'policies'));
    writeFileSync(join(cwd, 'policies', 'local.json'), JSON.stringify({
      id: 'local',
      rules: [{ id: 'noisy-rule', severity: 'warn', match: { path: 'noise' } }],
    }), 'utf8');
    try {
      const findings = await evaluatePolicies(
        [{ type: 'changed', path: 'noise', before: 1, after: 2 }],
        { cwd, policies: ['local'], severityRemap: { 'noisy-rule': 'off' } },
      );
      assert.deepEqual(findings, []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('warns when severityRemap references an unknown pack rule', async () => {
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (message) => warnings.push(message);
    try {
      await evaluatePolicies([], { severityRemap: { 'not-a-rule': 'off' } });
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(warnings, ['Unknown policy rule id in severityRemap: "not-a-rule"']);
  });

  test('computes highest severity', () => {
    const sev = highestSeverity([
      { id: 'a', severity: 'info', path: 'x', message: 'i' },
      { id: 'b', severity: 'warn', path: 'y', message: 'w' },
    ]);
    assert.equal(sev, 'warn');
  });

  test('unknown pack id fails closed', () => {
    assert.throws(() => loadPack('does-not-exist'), /Unknown policy pack/);
  });

  test('derives an id for local packs that omit one', () => {
    withLocalPack('missing-id', {
      rules: [{ id: 'valid-rule', severity: 'warn' }],
    }, (cwd) => {
      assert.equal(loadPack('missing-id', cwd).id, 'missing-id');
    });
  });

  test('rejects invalid rule severity with rule id and field', () => {
    withLocalPack('bad-severity', {
      id: 'bad-severity',
      rules: [{ id: 'broken-rule', severity: 'critical' }],
    }, (cwd) => {
      assert.throws(
        () => loadPack('bad-severity', cwd),
        /rule "broken-rule"\.severity must be one of/,
      );
    });
  });

  test('rejects invalid rule when values', () => {
    withLocalPack('bad-when', {
      id: 'bad-when',
      rules: [{ id: 'broken-rule', severity: 'warn', when: ['updated'] }],
    }, (cwd) => {
      assert.throws(
        () => loadPack('bad-when', cwd),
        /rule "broken-rule"\.when\[0\] must be one of/,
      );
    });
  });

  test('rejects unknown rule predicate fields', () => {
    withLocalPack('unknown-field', {
      id: 'unknown-field',
      rules: [{ id: 'broken-rule', severity: 'warn', matches: { path: 'x' } }],
    }, (cwd) => {
      assert.throws(
        () => loadPack('unknown-field', cwd),
        /rule "broken-rule"\.matches is not allowed/,
      );
    });
  });

  test('rejects a non-true afterLooksSecret predicate', () => {
    withLocalPack('bad-secret-predicate', {
      id: 'bad-secret-predicate',
      rules: [{ id: 'broken-rule', severity: 'warn', afterLooksSecret: false }],
    }, (cwd) => {
      assert.throws(
        () => loadPack('bad-secret-predicate', cwd),
        /rule "broken-rule"\.afterLooksSecret must be true/,
      );
    });
  });

  test('rejects invalid match regular expressions on load', () => {
    withLocalPack('invalid-regexp', {
      id: 'invalid-regexp',
      rules: [{ id: 'broken-rule', severity: 'warn', match: { path: '[' } }],
    }, (cwd) => {
      assert.throws(
        () => loadPack('invalid-regexp', cwd),
        /rule "broken-rule"\.match\.path must be a valid regular expression/,
      );
    });
  });

  test('rejects invalid match.pathFlags on load', () => {
    withLocalPack('invalid-flags', {
      id: 'invalid-flags',
      rules: [{ id: 'broken-rule', severity: 'warn', match: { path: 'a', pathFlags: 'z' } }],
    }, (cwd) => {
      assert.throws(
        () => loadPack('invalid-flags', cwd),
        /rule "broken-rule"\.match\.pathFlags must be valid regular expression flags/,
      );
    });
  });

  test('accepts match.path patterns that require pathFlags', () => {
    /** @type {{ id: string, severity: 'warn', match: { path: string, pathFlags: string } }[]} */
    const rules = [
      { id: 'unicode-prop', severity: 'warn', match: { path: String.raw`\p{L}+`, pathFlags: 'u' } },
    ];
    // Unicode sets need the `v` flag and fail path-only RegExp() construction.
    // Skip on engines that do not support `v` yet (Node 18).
    try {
      new RegExp('[a--b]', 'v');
      rules.push({ id: 'unicode-set', severity: 'warn', match: { path: '[a--b]', pathFlags: 'v' } });
    } catch {
      // ignore
    }

    withLocalPack('flagged-regexp', {
      id: 'flagged-regexp',
      rules,
    }, (cwd) => {
      const pack = loadPack('flagged-regexp', cwd);
      assert.equal(pack.rules.length, rules.length);
    });
  });

  test('mergeFindings keeps highest severity for same id+path', () => {
    const merged = mergeFindings([
      { id: 'secret-key-changed', severity: 'warn', path: 'a.token', message: 'w', pack: 'a' },
      { id: 'secret-key-changed', severity: 'error', path: 'a.token', message: 'e', pack: 'b' },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].severity, 'error');
    assert.equal(merged[0].pack, 'b');
  });

  test('strict-prod raises pool jump to error', async () => {
    const findings = await evaluatePolicies(
      [{ type: 'changed', path: 'database.pool_size', before: 10, after: 40 }],
      { policies: ['strict-prod'] },
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'error');
    assert.equal(findings[0].pack, 'strict-prod');
  });

  test('strict-prod flags a secret-shaped value that was removed', async () => {
    const findings = await evaluatePolicies(
      [{ type: 'removed', path: 'db.connstr', before: 'AKIAIOSFODNN7EXAMPLE' }],
      { policies: ['strict-prod'] },
    );
    assert.deepEqual(findings.map((finding) => finding.id), ['secret-value-detected']);
    assert.equal(findings[0].severity, 'error');
  });

  test('lists and loads the compose builtin pack', () => {
    assert.ok(listBuiltinPackIds().includes('compose'));
    assert.equal(loadPack('compose').id, 'compose');
  });

  test('flags Compose privilege, host network, and sensitive binds with custom destinations', async () => {
    const findings = await evaluatePolicies([
      { type: 'added', path: 'services.worker.privileged', after: true },
      { type: 'added', path: 'services.worker.network_mode', after: 'host' },
      { type: 'added', path: 'services.worker.volumes[0]', after: '/var/run/docker.sock:/docker.sock:ro' },
      { type: 'added', path: 'services.worker.volumes[1]', after: '/etc:/host-etc:ro' },
    ], { policies: ['compose'] });
    assert.deepEqual(findings.map((finding) => finding.id), [
      'compose-privileged-service',
      'compose-host-network',
      'compose-docker-socket-bind',
      'compose-sensitive-host-bind',
    ]);
    assert.ok(findings.every((finding) => finding.pack === 'compose'));
  });

  test('flags Node runtime engine removal, TLS bypass, and debug flags', async () => {
    const findings = await evaluatePolicies([
      { type: 'removed', path: 'engines.node', before: '>=18' },
      { type: 'added', path: 'environment.NODE_TLS_REJECT_UNAUTHORIZED', after: '0' },
      { type: 'added', path: 'environment.NODE_DEBUG', after: 'http' },
      { type: 'added', path: 'environment.NODE_OPTIONS', after: '--inspect=0.0.0.0:9229 --trace-warnings' },
    ], { policies: ['node-runtime'] });
    assert.deepEqual(findings.map((finding) => finding.id), [
      'node-runtime-engine-removed',
      'node-runtime-tls-verification-disabled',
      'node-runtime-debug-enabled',
      'node-runtime-inspector-enabled',
    ]);
    assert.ok(findings.every((finding) => finding.pack === 'node-runtime'));
  });

  test('matches beforeEquals and afterIn value predicates', async () => {
    const findings = await evaluateCustomPack([{
      id: 'value-transition',
      severity: 'warn',
      beforeEquals: 'draft',
      afterIn: ['review', 'published'],
    }], [{ type: 'changed', path: 'status', before: 'draft', after: 'review' }]);
    assert.equal(findings.length, 1);
  });

  test('matches beforeIn and absolute numericDelta predicates', async () => {
    const findings = await evaluateCustomPack([{
      id: 'large-rollback',
      severity: 'warn',
      beforeIn: [100, 200],
      numericDelta: { min: 50 },
    }], [{ type: 'changed', path: 'limits.requests', before: 100, after: 40 }]);
    assert.equal(findings.length, 1);
  });

  test('afterAnyMatches applies a regex to the elements of a list value', async () => {
    // The scalar-to-list edit: one `changed` event whose `after` is an array,
    // which every scalar predicate -- afterMatches included -- is blind to.
    const findings = await evaluateCustomPack([{
      id: 'list-label',
      severity: 'warn',
      afterAnyMatches: '(^|[ ,])self-hosted([ ,]|$)',
    }], [
      { type: 'changed', path: 'a.runs-on', before: 'ubuntu-latest', after: ['self-hosted', 'linux'] },
      { type: 'changed', path: 'b.runs-on', before: 'ubuntu-latest', after: ['ubuntu-latest', 'x64'] },
    ]);
    assert.deepEqual(findings.map((finding) => finding.path), ['a.runs-on']);
  });

  test('afterAnyMatches is a flat scan of array values only', async () => {
    // Scoped narrowly on purpose: a non-array value never matches (that is what
    // afterMatches is for), non-string elements are skipped rather than
    // stringified, and the scan does not descend into a nested array or object,
    // so what a rule matches stays readable from the rule text.
    const findings = await evaluateCustomPack([{
      id: 'flat-only',
      severity: 'warn',
      afterAnyMatches: 'self-hosted',
    }], [
      { type: 'changed', path: 'scalar', before: 'x', after: 'self-hosted' },
      { type: 'changed', path: 'nested.array', before: 'x', after: [['self-hosted']] },
      { type: 'changed', path: 'nested.object', before: 'x', after: [{ label: 'self-hosted' }] },
      { type: 'changed', path: 'numeric', before: 'x', after: [1, 2] },
      { type: 'changed', path: 'flat', before: 'x', after: ['self-hosted'] },
    ]);
    assert.deepEqual(findings.map((finding) => finding.path), ['flat']);
  });

  test('afterMatches keeps its exact scalar meaning alongside afterAnyMatches', async () => {
    // Existing packs must not start matching lists because the list predicate
    // was added, so the two are asserted against the same pair of events.
    const findings = await evaluateCustomPack([
      { id: 'scalar-only', severity: 'info', afterMatches: 'self-hosted' },
      { id: 'list-only', severity: 'info', afterAnyMatches: 'self-hosted' },
    ], [
      { type: 'changed', path: 'runs-on', before: 'x', after: 'self-hosted' },
      { type: 'changed', path: 'runs-on', before: 'x', after: ['self-hosted'] },
    ]);
    assert.deepEqual(findings.map((finding) => finding.id), ['scalar-only', 'list-only']);
  });

  test('rejects an afterAnyMatches that is not a valid regular expression', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'flecto-policy-'));
    try {
      const policiesDir = join(cwd, 'policies');
      mkdirSync(policiesDir);
      writeFileSync(join(policiesDir, 'invalid.json'), JSON.stringify({
        id: 'invalid',
        rules: [{ id: 'bad-rule', severity: 'warn', afterAnyMatches: '([' }],
      }));
      assert.throws(() => loadPack('invalid', cwd), /afterAnyMatches is not a valid regular expression/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('matches symmetric truthiness predicates', async () => {
    const findings = await evaluateCustomPack([
      { id: 'was-configured', severity: 'info', beforeTruthy: true },
      { id: 'is-configured', severity: 'info', afterTruthy: true },
    ], [{ type: 'changed', path: 'feature.enabled', before: true, after: 'yes' }]);
    assert.deepEqual(findings.map((finding) => finding.id), ['was-configured', 'is-configured']);
  });

  test('matches symmetric secret-value predicates', async () => {
    const findings = await evaluateCustomPack([
      { id: 'was-secret', severity: 'info', beforeLooksSecret: true },
      { id: 'is-secret', severity: 'info', afterLooksSecret: true },
    ], [{
      type: 'changed',
      path: 'db.connstr',
      before: 'AKIAIOSFODNN7EXAMPLE',
      after: 'gT4kQ9wZ2mB7xL5nR8vC3jH6pY1sD0fA',
    }]);
    assert.deepEqual(findings.map((finding) => finding.id), ['was-secret', 'is-secret']);
  });

  test('does not match secret-value predicates on ordinary values', async () => {
    const findings = await evaluateCustomPack([
      { id: 'was-secret', severity: 'info', beforeLooksSecret: true },
      { id: 'is-secret', severity: 'info', afterLooksSecret: true },
    ], [{ type: 'changed', path: 'db.host', before: 'db.old.example.test', after: 'db.internal.example.test' }]);
    assert.deepEqual(findings, []);
  });

  test('matches exact and prefixed paths without regular expressions', async () => {
    const findings = await evaluateCustomPack([
      { id: 'exact-path', severity: 'warn', match: { pathEquals: 'database.pool_size' } },
      { id: 'path-prefix', severity: 'warn', match: { pathPrefix: 'services.api.' } },
    ], [
      { type: 'changed', path: 'database.pool_size', before: 10, after: 20 },
      { type: 'changed', path: 'services.api.timeout', before: 10, after: 20 },
    ]);
    assert.deepEqual(findings.map((finding) => finding.id), ['exact-path', 'path-prefix']);
  });

  test('requires every allOf clause and one anyOf clause', async () => {
    const findings = await evaluateCustomPack([{
      id: 'production-danger',
      severity: 'error',
      allOf: [
        { match: { pathPrefix: 'features.' } },
        { afterIn: ['unsafe', true] },
      ],
      anyOf: [
        { afterEquals: 'unsafe' },
        { afterEquals: true },
      ],
    }], [
      { type: 'changed', path: 'features.debug', before: false, after: true },
      { type: 'changed', path: 'features.mode', before: 'safe', after: 'unsafe' },
      { type: 'changed', path: 'other.debug', before: false, after: true },
      { type: 'changed', path: 'features.mode', before: 'safe', after: 'safe' },
    ]);
    assert.equal(findings.length, 2);
  });

  test('fails closed when a pack contains unknown predicate fields', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'flecto-policy-'));
    try {
      const policiesDir = join(cwd, 'policies');
      mkdirSync(policiesDir);
      writeFileSync(join(policiesDir, 'invalid.json'), JSON.stringify({
        id: 'invalid',
        rules: [{ id: 'bad-rule', severity: 'warn', afterEqulas: true }],
      }));
      assert.throws(() => loadPack('invalid', cwd), /unknown field "afterEqulas"/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  describe('pack caching across a run', () => {
    // The cache key is (cwd, resolved path, mtime). Editing the file and then
    // forcing its mtime forward — rather than relying on wall-clock time to
    // pass between the two writes — is what makes this deterministic instead
    // of occasionally flaky on filesystems with coarse mtime resolution.
    function writePack(path, pack, { bumpMtimeMs } = {}) {
      writeFileSync(path, JSON.stringify(pack), 'utf8');
      if (bumpMtimeMs !== undefined) {
        const bumped = new Date(statSync(path).mtimeMs + bumpMtimeMs);
        utimesSync(path, bumped, bumped);
      }
    }

    // This is the regression #92 explicitly warns against: a long-running
    // `flecto watch` process must never keep serving a pack that no longer
    // matches what is on disk.
    test('a pack edited mid-watch is picked up on the very next evaluation, not served stale', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'flecto-watch-cache-'));
      try {
        const policiesDir = join(cwd, 'policies');
        mkdirSync(policiesDir);
        const packPath = join(policiesDir, 'live.json');
        const change = { type: 'changed', path: 'x', before: 1, after: 2 };
        const evalOpts = { cwd, policies: ['live'], source: 'watch' };

        writePack(packPath, {
          id: 'live',
          rules: [{ id: 'r', severity: 'warn', message: 'v1', match: { path: 'x' } }],
        });
        const before = await evaluatePolicies([change], evalOpts);
        assert.equal(before.length, 1);
        assert.equal(before[0].severity, 'warn');
        assert.equal(before[0].message, 'v1');

        // Simulate a user editing policies/live.json while `flecto watch` is
        // still running against this same cwd.
        writePack(packPath, {
          id: 'live',
          rules: [{ id: 'r', severity: 'error', message: 'v2', match: { path: 'x' } }],
        }, { bumpMtimeMs: 5000 });

        const after = await evaluatePolicies([change], evalOpts);
        assert.equal(after.length, 1);
        assert.equal(after[0].severity, 'error', 'stale cached pack was served instead of the edit');
        assert.equal(after[0].message, 'v2', 'stale cached pack was served instead of the edit');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('a pack edited mid-watch into invalid JSON fails closed rather than serving the last-good cache', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'flecto-watch-cache-invalid-'));
      try {
        const policiesDir = join(cwd, 'policies');
        mkdirSync(policiesDir);
        const packPath = join(policiesDir, 'live.json');
        const evalOpts = { cwd, policies: ['live'], source: 'watch' };

        writePack(packPath, {
          id: 'live',
          rules: [{ id: 'r', severity: 'warn', match: { path: 'x' } }],
        });
        await evaluatePolicies([{ type: 'changed', path: 'x', before: 1, after: 2 }], evalOpts);

        // An editor mid-save, or a genuine typo, leaves the file briefly
        // invalid. Watch mode's contract is to fail closed here, never to
        // fall back to whatever was last cached.
        const bumped = new Date(statSync(packPath).mtimeMs + 5000);
        writeFileSync(packPath, '{ not valid json', 'utf8');
        utimesSync(packPath, bumped, bumped);

        await assert.rejects(
          () => evaluatePolicies([{ type: 'changed', path: 'x', before: 1, after: 2 }], evalOpts),
          /could not parse file/,
        );
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test('severityRemap never persists onto the cached pack across calls with different remaps', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'flecto-remap-cache-'));
      try {
        const policiesDir = join(cwd, 'policies');
        mkdirSync(policiesDir);
        writePack(join(policiesDir, 'shared.json'), {
          id: 'shared',
          rules: [{ id: 'r', severity: 'warn', match: { path: 'x' } }],
        });
        const change = { type: 'changed', path: 'x', before: 1, after: 2 };

        // Same cwd, same pack id, same file — same cache entry both times.
        const remapped = await evaluatePolicies([change], {
          cwd, policies: ['shared'], severityRemap: { r: 'error' },
        });
        const plain = await evaluatePolicies([change], { cwd, policies: ['shared'] });

        assert.equal(remapped[0].severity, 'error');
        assert.equal(plain[0].severity, 'warn', 'a previous call\'s severityRemap leaked into the cached pack');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});

/**
 * @param {string} id
 * @param {unknown} pack
 * @param {(cwd: string) => void} run
 */
function withLocalPack(id, pack, run) {
  const cwd = mkdtempSync(join(tmpdir(), 'flecto-policy-'));
  try {
    const policies = join(cwd, 'policies');
    mkdirSync(policies);
    writeFileSync(join(policies, `${id}.json`), JSON.stringify(pack));
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
