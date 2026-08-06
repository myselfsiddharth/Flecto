import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { diffTrees } from '../src/differ.js';
import { parseFile } from '../src/parser.js';
import {
  evaluatePack,
  expandChangeSubtrees,
  listBuiltinPackIds,
  loadPack,
} from '../src/policy.js';
import { assertExpectedFindings } from '../src/policy-test.js';

const rootIndex = resolve(process.cwd(), 'index.js');
const FIXTURES = resolve(process.cwd(), 'test', 'fixtures', 'kubernetes');
const pack = loadPack('kubernetes', process.cwd());

/** Unique rule ids fired by the kubernetes pack for a before/after pair. */
function firedIds(before, after) {
  const findings = evaluatePack(pack, diffTrees(before, after));
  return [...new Set(findings.map((finding) => finding.id))].sort();
}

/** Minimal rendered-Deployment shape: one pod spec, one container. */
function deployment({ replicas = 2, podSpec = {}, container = {} } = {}) {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'api', namespace: 'prod' },
    spec: {
      replicas,
      template: {
        spec: {
          ...podSpec,
          containers: [{ name: 'api', image: 'ghcr.io/acme/api:1.4.2', ...container }],
        },
      },
    },
  };
}

/** Deployment whose single container carries the given securityContext. */
function withSecurityContext(securityContext) {
  return deployment({ container: { securityContext } });
}

function service(type) {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'api', namespace: 'prod' },
    spec: { type, ports: [{ name: 'http', port: 80 }] },
  };
}

// ---------------------------------------------------------------------------
// Pack registration
// ---------------------------------------------------------------------------

test('kubernetes ships as a built-in policy pack', () => {
  assert.ok(listBuiltinPackIds().includes('kubernetes'));
  assert.equal(pack.id, 'kubernetes');
  assert.equal(pack.expandSubtrees, true);
  // Every rule id is namespaced and unique, so findings stay attributable.
  const ids = pack.rules.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id.startsWith('k8s-')), ids.join(', '));
});

// ---------------------------------------------------------------------------
// Rendered multi-document manifests, end to end through the differ
// ---------------------------------------------------------------------------

test('kubernetes pack reports every risk in a rendered multi-document diff', () => {
  const changes = diffTrees(
    parseFile(join(FIXTURES, 'baseline.yaml')),
    parseFile(join(FIXTURES, 'risky.yaml')),
  );
  const findings = evaluatePack(pack, changes);

  assertExpectedFindings(findings, [
    { id: 'k8s-allow-privilege-escalation', severity: 'error', path: 'Deployment/prod/api.spec.template.spec.containers["api"].securityContext.allowPrivilegeEscalation' },
    { id: 'k8s-allow-privilege-escalation', severity: 'error', path: 'Deployment/prod/debug-shell.spec.template.spec.containers["shell"].securityContext.allowPrivilegeEscalation' },
    { id: 'k8s-dangerous-capability-added', severity: 'error', path: 'Deployment/prod/api.spec.template.spec.containers["api"].securityContext.capabilities.add[1]' },
    { id: 'k8s-dangerous-capability-added', severity: 'error', path: 'Deployment/prod/debug-shell.spec.template.spec.containers["shell"].securityContext.capabilities.add[0]' },
    { id: 'k8s-host-namespace-shared', severity: 'error', path: 'Deployment/prod/api.spec.template.spec.hostNetwork' },
    { id: 'k8s-host-namespace-shared', severity: 'error', path: 'Deployment/prod/debug-shell.spec.template.spec.hostPID' },
    { id: 'k8s-image-pull-policy-always', severity: 'warn', path: 'Deployment/prod/api.spec.template.spec.containers["api"].imagePullPolicy' },
    { id: 'k8s-image-tag-unpinned', severity: 'error', path: 'Deployment/prod/api.spec.template.spec.containers["api"].image' },
    { id: 'k8s-image-tag-unpinned', severity: 'error', path: 'Deployment/prod/debug-shell.spec.template.spec.containers["shell"].image' },
    { id: 'k8s-privileged-container', severity: 'error', path: 'Deployment/prod/api.spec.template.spec.containers["api"].securityContext.privileged' },
    { id: 'k8s-privileged-container', severity: 'error', path: 'Deployment/prod/debug-shell.spec.template.spec.containers["shell"].securityContext.privileged' },
    { id: 'k8s-replica-count-jump', severity: 'warn', path: 'Deployment/prod/api.spec.replicas' },
    { id: 'k8s-resource-limits-removed', severity: 'warn', path: 'Deployment/prod/api.spec.template.spec.containers["api"].resources.limits.memory' },
    { id: 'k8s-run-as-non-root-weakened', severity: 'error', path: 'Deployment/prod/api.spec.template.spec.securityContext.runAsNonRoot' },
    { id: 'k8s-run-as-non-root-weakened', severity: 'error', path: 'Deployment/prod/debug-shell.spec.template.spec.containers["shell"].securityContext.runAsNonRoot' },
    { id: 'k8s-service-externally-exposed', severity: 'error', path: 'Service/prod/api.spec.type' },
    { id: 'k8s-service-externally-exposed', severity: 'error', path: 'Service/prod/debug-shell.spec.type' },
  ]);

  // Each of the pack's rules is exercised by the fixture, so a rule that stops
  // matching cannot hide behind its neighbours.
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.id))].sort(),
    pack.rules.map((rule) => rule.id).sort(),
  );
});

test('kubernetes pack stays silent on an ordinary release diff', () => {
  const changes = diffTrees(
    parseFile(join(FIXTURES, 'baseline.yaml')),
    parseFile(join(FIXTURES, 'benign.yaml')),
  );

  // The benign render is a real diff, not a no-op: version bump, scale-out,
  // config edits, an added workload, a benign capability, a widened autoscaler.
  assert.ok(changes.length >= 20, `expected a substantial diff, got ${changes.length}`);
  assert.deepEqual(evaluatePack(pack, changes), []);
});

test('a newly added workload is only visible because the pack expands subtrees', () => {
  const changes = diffTrees(
    parseFile(join(FIXTURES, 'baseline.yaml')),
    parseFile(join(FIXTURES, 'risky.yaml')),
  );
  const withExpansion = evaluatePack(pack, changes);
  const withoutExpansion = evaluatePack({ ...pack, expandSubtrees: false }, changes);
  const seen = new Set(withoutExpansion.map((finding) => `${finding.id}::${finding.path}`));
  const onlyExpanded = withExpansion.filter((f) => !seen.has(`${f.id}::${f.path}`));

  // The differ reports a brand-new document as one `added` change carrying the
  // whole manifest, so without expansion the entire debug-shell workload and
  // its NodePort Service go unreported.
  assert.equal(onlyExpanded.length, 7);
  assert.ok(onlyExpanded.every((f) => f.path.includes('debug-shell')), JSON.stringify(onlyExpanded));
  assert.ok(onlyExpanded.some((f) => f.id === 'k8s-service-externally-exposed'));
  assert.ok(onlyExpanded.some((f) => f.id === 'k8s-privileged-container'));
});

// ---------------------------------------------------------------------------
// Per-rule: fires on the risk, silent on the near miss
// ---------------------------------------------------------------------------

test('k8s-privileged-container fires only when privileged turns on', () => {
  const off = withSecurityContext({ privileged: false });
  const on = withSecurityContext({ privileged: true });

  assert.deepEqual(firedIds(off, on), ['k8s-privileged-container']);
  assert.deepEqual(firedIds(on, off), []);
  // Newly added, not merely flipped.
  assert.deepEqual(firedIds(deployment(), on), ['k8s-privileged-container']);
  assert.deepEqual(firedIds(deployment(), off), []);
});

test('k8s-host-namespace-shared fires for each host namespace', () => {
  for (const flag of ['hostNetwork', 'hostPID', 'hostIPC']) {
    assert.deepEqual(
      firedIds(deployment({ podSpec: { [flag]: false } }), deployment({ podSpec: { [flag]: true } })),
      ['k8s-host-namespace-shared'],
      flag,
    );
    assert.deepEqual(
      firedIds(deployment({ podSpec: { [flag]: true } }), deployment({ podSpec: { [flag]: false } })),
      [],
      flag,
    );
  }
  // A pod-level field that merely looks similar is not a host namespace.
  assert.deepEqual(
    firedIds(deployment(), deployment({ podSpec: { hostname: 'api-0', setHostnameAsFQDN: true } })),
    [],
  );
});

test('k8s-run-as-non-root-weakened catches disabling and dropping', () => {
  const enforced = withSecurityContext({ runAsNonRoot: true });
  const disabled = withSecurityContext({ runAsNonRoot: false });
  const dropped = withSecurityContext({ runAsUser: 10001 });

  assert.deepEqual(firedIds(enforced, disabled), ['k8s-run-as-non-root-weakened']);
  assert.deepEqual(firedIds(enforced, dropped), ['k8s-run-as-non-root-weakened']);
  assert.deepEqual(firedIds(deployment(), disabled), ['k8s-run-as-non-root-weakened']);

  // Hardening, and dropping an already-absent guarantee, are not findings.
  assert.deepEqual(firedIds(disabled, enforced), []);
  assert.deepEqual(firedIds(deployment(), enforced), []);
  assert.deepEqual(firedIds(disabled, dropped), []);
});

test('k8s-allow-privilege-escalation catches enabling and dropping the false', () => {
  const pinned = withSecurityContext({ allowPrivilegeEscalation: false });
  const enabled = withSecurityContext({ allowPrivilegeEscalation: true });
  const dropped = withSecurityContext({ readOnlyRootFilesystem: true });

  assert.deepEqual(firedIds(pinned, enabled), ['k8s-allow-privilege-escalation']);
  assert.deepEqual(firedIds(pinned, dropped), ['k8s-allow-privilege-escalation']);
  assert.deepEqual(firedIds(deployment(), enabled), ['k8s-allow-privilege-escalation']);

  assert.deepEqual(firedIds(enabled, pinned), []);
  assert.deepEqual(firedIds(deployment(), pinned), []);
  // Dropping an explicit `true` does not change the effective default.
  assert.deepEqual(firedIds(enabled, dropped), []);
});

test('k8s-dangerous-capability-added targets host-equivalent capabilities only', () => {
  const caps = (add) => withSecurityContext({ capabilities: { drop: ['ALL'], add } });

  for (const capability of ['SYS_ADMIN', 'NET_ADMIN', 'ALL']) {
    assert.deepEqual(
      firedIds(caps(['NET_BIND_SERVICE']), caps(['NET_BIND_SERVICE', capability])),
      ['k8s-dangerous-capability-added'],
      capability,
    );
    // Also when the whole capabilities block arrives at once.
    assert.deepEqual(firedIds(deployment(), caps([capability])), ['k8s-dangerous-capability-added'], capability);
  }

  // Narrow capabilities, and the `drop` list, are not findings — dropping ALL
  // is the hardened baseline.
  assert.deepEqual(firedIds(caps(['NET_BIND_SERVICE']), caps(['NET_BIND_SERVICE', 'CHOWN'])), []);
  assert.deepEqual(
    firedIds(withSecurityContext({ capabilities: { drop: [] } }), withSecurityContext({ capabilities: { drop: ['ALL'] } })),
    [],
  );
});

test('k8s-image-tag-unpinned distinguishes pinned references from mutable ones', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const unpinned = [
    'nginx',
    'nginx:latest',
    'ghcr.io/acme/api:latest',
    'library/nginx',
    'registry.internal:5000/api',
  ];
  const pinned = [
    'nginx:1.25.3',
    'ghcr.io/acme/api:1.4.2',
    'registry.internal:5000/api:1.4.2',
    `ghcr.io/acme/api@${digest}`,
    'ghcr.io/acme/api:latest-alpine',
  ];

  for (const image of unpinned) {
    assert.deepEqual(
      firedIds(deployment({ container: { image: 'ghcr.io/acme/api:1.4.2' } }), deployment({ container: { image } })),
      ['k8s-image-tag-unpinned'],
      image,
    );
  }
  for (const image of pinned) {
    assert.deepEqual(
      firedIds(deployment({ container: { image: 'ghcr.io/acme/api:1.4.1' } }), deployment({ container: { image } })),
      [],
      image,
    );
  }
});

test('k8s-image-pull-policy-always fires only when the policy moves', () => {
  const policy = (imagePullPolicy) => deployment({ container: { imagePullPolicy } });

  assert.deepEqual(firedIds(policy('IfNotPresent'), policy('Always')), ['k8s-image-pull-policy-always']);
  assert.deepEqual(firedIds(policy('Always'), policy('IfNotPresent')), []);
  // A new container declaring Always has not moved off anything.
  assert.deepEqual(firedIds(deployment(), policy('Always')), []);
});

test('k8s-replica-count-jump ignores routine scaling', () => {
  const jumps = [[2, 6], [3, 12], [10, 30], [1, 20]];
  const routine = [[1, 2], [2, 5], [1, 3], [4, 6], [12, 3]];

  for (const [before, after] of jumps) {
    assert.deepEqual(
      firedIds(deployment({ replicas: before }), deployment({ replicas: after })),
      ['k8s-replica-count-jump'],
      `${before} -> ${after}`,
    );
  }
  for (const [before, after] of routine) {
    assert.deepEqual(
      firedIds(deployment({ replicas: before }), deployment({ replicas: after })),
      [],
      `${before} -> ${after}`,
    );
  }

  // An autoscaler bound is not a replica count.
  const hpa = (maxReplicas) => ({
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: { name: 'api' },
    spec: { minReplicas: 2, maxReplicas },
  });
  assert.deepEqual(firedIds(hpa(10), hpa(40)), []);
});

test('k8s-resource-limits-removed reports limits, not requests', () => {
  const resources = (value) => deployment({ container: { resources: value } });
  const full = { limits: { cpu: '500m', memory: '512Mi' }, requests: { cpu: '100m', memory: '256Mi' } };

  assert.deepEqual(
    firedIds(resources(full), resources({ ...full, limits: { cpu: '500m' } })),
    ['k8s-resource-limits-removed'],
  );
  // Dropping the whole resources block removes every limit it held.
  const wholesale = evaluatePack(pack, diffTrees(resources(full), deployment()));
  assert.deepEqual(wholesale.map((f) => f.id), ['k8s-resource-limits-removed', 'k8s-resource-limits-removed']);

  // Raising a limit, adding one, or dropping a request is not a finding.
  assert.deepEqual(firedIds(resources(full), resources({ ...full, limits: { cpu: '750m', memory: '512Mi' } })), []);
  assert.deepEqual(
    firedIds(resources(full), resources({ ...full, limits: { ...full.limits, 'ephemeral-storage': '1Gi' } })),
    [],
  );
  assert.deepEqual(firedIds(resources(full), resources({ ...full, requests: { cpu: '100m' } })), []);
});

test('k8s-service-externally-exposed covers both external Service types', () => {
  assert.deepEqual(firedIds(service('ClusterIP'), service('LoadBalancer')), ['k8s-service-externally-exposed']);
  assert.deepEqual(firedIds(service('ClusterIP'), service('NodePort')), ['k8s-service-externally-exposed']);
  assert.deepEqual(firedIds(service('LoadBalancer'), service('ClusterIP')), []);
  assert.deepEqual(firedIds(service('ClusterIP'), service('ExternalName')), []);

  // A whole Service document added at once still resolves to its type.
  assert.deepEqual(firedIds({}, { 'Service/api': service('LoadBalancer') }), ['k8s-service-externally-exposed']);
  assert.deepEqual(firedIds({}, { 'Service/api': service('ClusterIP') }), []);
});

// ---------------------------------------------------------------------------
// expandChangeSubtrees
// ---------------------------------------------------------------------------

test('expandChangeSubtrees adds leaf changes and keeps the original event', () => {
  const changes = [{
    type: 'added',
    path: 'spec.securityContext',
    after: { privileged: true, capabilities: { add: ['SYS_ADMIN'] } },
  }];

  assert.deepEqual(expandChangeSubtrees(changes), [
    changes[0],
    { type: 'added', path: 'spec.securityContext.privileged', after: true },
    { type: 'added', path: 'spec.securityContext.capabilities.add[0]', after: 'SYS_ADMIN' },
  ]);
});

test('expandChangeSubtrees spells array segments the way the differ does', () => {
  const containers = [{ name: 'api', port: 8080 }, { name: 'sidecar', port: 9090 }];
  const expanded = expandChangeSubtrees([{ type: 'added', path: 'spec.containers', after: containers }]);

  // Named elements use the differ's quoted identity segment...
  assert.deepEqual(expanded.slice(1).map((change) => change.path), [
    'spec.containers["api"].name',
    'spec.containers["api"].port',
    'spec.containers["sidecar"].name',
    'spec.containers["sidecar"].port',
  ]);

  // ...and elements without a usable identity fall back to indices.
  const scalars = expandChangeSubtrees([{ type: 'added', path: 'args', after: ['--verbose', '--fast'] }]);
  assert.deepEqual(scalars.slice(1).map((change) => change.path), ['args[0]', 'args[1]']);
});

test('expandChangeSubtrees mirrors removals and leaves other changes alone', () => {
  const removal = { type: 'removed', path: 'spec.resources', before: { limits: { cpu: '1' } } };
  assert.deepEqual(expandChangeSubtrees([removal]), [
    removal,
    { type: 'removed', path: 'spec.resources.limits.cpu', before: '1' },
  ]);

  // Scalar adds, and every `changed` event, pass through untouched.
  const untouched = [
    { type: 'added', path: 'spec.replicas', after: 3 },
    { type: 'changed', path: 'spec.type', before: 'ClusterIP', after: 'LoadBalancer' },
  ];
  assert.deepEqual(expandChangeSubtrees(untouched), untouched);
});

test('expandChangeSubtrees terminates on a cyclic subtree', () => {
  // `loop: &anchor { self: *anchor }` is what a recursive YAML anchor parses
  // to. The cycle is built here rather than parsed from a file because the
  // unit under test is the guard in the expansion walk, not the parser: since
  // #103, parseContent breaks a cycle like this itself (the back-reference
  // normalizes to a `<circular>` sentinel), so it can no longer hand a
  // genuinely cyclic object to anything downstream. This test keeps
  // exercising the guard here directly in case a cyclic value ever reaches
  // expansion by some other route. The differ never recurses into an added
  // subtree, so expansion is the first walk that could meet one.
  const loop = { privileged: true };
  loop.self = loop;
  const parsed = { kind: 'Deployment', loop };
  assert.equal(parsed.loop.self, parsed.loop, 'fixture should be cyclic');

  const expanded = expandChangeSubtrees(diffTrees({}, parsed));
  assert.ok(expanded.length > 0);
  // The scalar beneath the anchor is still reached; the cycle just stops.
  assert.ok(expanded.some((change) => change.path === 'loop.privileged' && change.after === true));
  assert.ok(expanded.every((change) => (change.path.match(/self/g) ?? []).length <= 1));
});

test('expandChangeSubtrees walks a shared node once per branch', () => {
  // Sharing is not a cycle: an anchor reused on two branches must expand on both.
  const shared = { cpu: '500m' };
  const expanded = expandChangeSubtrees([
    { type: 'added', path: 'spec', after: { a: { limits: shared }, b: { limits: shared } } },
  ]);

  assert.deepEqual(expanded.slice(1).map((change) => change.path), [
    'spec.a.limits.cpu',
    'spec.b.limits.cpu',
  ]);
});

test('subtree expansion is opt-in, so other packs are unaffected', () => {
  // A secret-shaped key arriving inside a new subtree: the `default` pack is
  // path-anchored and does not expand, so its behaviour is unchanged.
  const changes = diffTrees({}, { database: { password: 'hunter2', host: 'db.internal' } });
  assert.equal(changes.length, 1);

  const defaults = evaluatePack(loadPack('default', process.cwd()), changes);
  assert.deepEqual(defaults.map((finding) => finding.path), []);

  // The same pack with expansion turned on would see the leaf.
  const expanded = evaluatePack(
    { ...loadPack('default', process.cwd()), expandSubtrees: true },
    changes,
  );
  assert.deepEqual(expanded.map((finding) => finding.path), ['database.password']);
});

test('expandSubtrees is validated like every other pack field', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-k8s-pack-'));
  try {
    mkdirSync(join(dir, 'policies'), { recursive: true });
    writeFileSync(
      join(dir, 'policies', 'broken.json'),
      JSON.stringify({ id: 'broken', expandSubtrees: 'yes', rules: [] }),
      'utf8',
    );
    assert.throws(
      () => loadPack('broken', dir),
      /pack\.expandSubtrees must be a boolean/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The rendered-manifest workflow through the CLI
// ---------------------------------------------------------------------------

test('compare gates a rendered manifest diff on the kubernetes pack', () => {
  const risky = spawnSync(
    process.execPath,
    [
      rootIndex, 'compare',
      join(FIXTURES, 'baseline.yaml'), join(FIXTURES, 'risky.yaml'),
      '--policies', 'kubernetes', '--fail-on', 'policy', '--format', 'json',
    ],
    { encoding: 'utf8' },
  );

  assert.equal(risky.status, 1, `${risky.stdout}${risky.stderr}`);
  const [result] = JSON.parse(risky.stdout);
  assert.equal(result.baseline, join(FIXTURES, 'baseline.yaml'));
  assert.equal(result.policies.length, 17);
  assert.ok(result.policies.every((finding) => finding.pack === 'kubernetes'));

  // The same command over an ordinary release render passes, even though the
  // manifests differ substantially.
  const benign = spawnSync(
    process.execPath,
    [
      rootIndex, 'compare',
      join(FIXTURES, 'baseline.yaml'), join(FIXTURES, 'benign.yaml'),
      '--policies', 'kubernetes', '--fail-on', 'policy', '--format', 'json',
    ],
    { encoding: 'utf8' },
  );

  assert.equal(benign.status, 0, `${benign.stdout}${benign.stderr}`);
  assert.deepEqual(JSON.parse(benign.stdout)[0].policies, []);
});

test('compare surfaces kubernetes findings in human output', () => {
  const run = spawnSync(
    process.execPath,
    [
      rootIndex, 'compare',
      join(FIXTURES, 'baseline.yaml'), join(FIXTURES, 'risky.yaml'),
      '--policies', 'kubernetes', '--fail-on', 'error',
    ],
    { encoding: 'utf8' },
  );

  assert.equal(run.status, 1);
  assert.match(run.stdout, /Service\/prod\/api\.spec\.type: "ClusterIP" → "LoadBalancer"/);
  assert.match(run.stdout, /policy\(error\) \[kubernetes\].*Service type is LoadBalancer/);
  assert.match(run.stdout, /policy\(error\) \[kubernetes\].*Container runs privileged/);
});

test('ci gates a committed rendered manifest against a git ref', () => {
  const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (gitVersion.status !== 0) {
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'flecto-k8s-ci-'));
  const rendered = join(dir, 'rendered.yaml');

  try {
    copyFileSync(join(FIXTURES, 'baseline.yaml'), rendered);
    assert.equal(spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.name', 'Flecto Test'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['commit', '-m', 'rendered baseline'], { cwd: dir, encoding: 'utf8' }).status, 0);

    // The pull request re-renders the chart over the committed manifest.
    copyFileSync(join(FIXTURES, 'risky.yaml'), rendered);

    const run = spawnSync(
      process.execPath,
      [
        rootIndex, 'ci', rendered,
        '--snapshot-ref', 'HEAD', '--policies', 'kubernetes',
        '--fail-on', 'error', '--format', 'json',
      ],
      { cwd: dir, encoding: 'utf8' },
    );

    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
    const [result] = JSON.parse(run.stdout);
    assert.equal(result.envelope.schema_version, '2.0');
    assert.equal(result.policies.length, 17);

    // Re-rendering the committed baseline unchanged is a clean run.
    copyFileSync(join(FIXTURES, 'baseline.yaml'), rendered);
    const clean = spawnSync(
      process.execPath,
      [rootIndex, 'ci', rendered, '--snapshot-ref', 'HEAD', '--policies', 'kubernetes', '--format', 'json'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(clean.status, 0, `${clean.stdout}${clean.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
