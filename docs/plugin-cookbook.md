# Plugin cookbook

This cookbook builds on the [plugin authoring guide](plugins.md) with runnable scenarios. All commands use the shared fixtures in [`examples/fixtures/policies`](../examples/fixtures/policies), so packs and plugins can exercise the same realistic config changes.

## Fixture set

The fixture pair contains four changes:

| Change | Path | Why it is useful |
| --- | --- | --- |
| Secret rotation | `auth.api_key` | Built-in secret detection |
| Dangerous toggle | `features.debug` | Boolean policy matching |
| Capacity jump | `database.pool_size` | Numeric threshold matching |
| Nested drift | `deployment.rollout.maxUnavailable` | Plugin or pack logic beyond a flat key |

Start in the fixture directory for every command below:

```bash
cd examples/fixtures/policies
```

`baseline.json` is a snapshot envelope and `current.json` is the config being evaluated.

## 1. Test the complete fixture

Run the fixture harness from the repository root:

```bash
flecto policies test examples/fixtures/policies
```

It exits `0` only when the findings exactly match `flecto-policy-test.json`. The fixture config selects the before/after files, packs, plugins, optional profile, and expected `{ id, severity, path }` values. Flecto reports missing and unexpected findings when they differ, making fixture failures useful in a pack or plugin's test suite.

## 2. Merge a pack with an async plugin

Use a pack for a stable declarative rule and a plugin for the context-sensitive production approval. The plugin awaits before returning findings, which is supported by `evaluate`.

```bash
node ../../../index.js ci current.json --snapshot-ref baseline.json --profile prod --policies default,deployment-review --plugins ./plugins/async-rollout-guard.js --fail-on policy
```

This command intentionally exits `1` because `--fail-on policy` treats findings as CI failures. Expected findings:

- `secret-key-changed` (`error`) from the built-in `default` pack
- `dangerous-toggle-enabled` (`error`) from the built-in `default` pack
- `pool-size-jump` (`warn`) from the built-in `default` pack
- `rollout-unavailability-increased` (`warn`) from `deployment-review`
- `async-rollout-approval` (`error`) from the plugin

Pack and plugin findings are merged before output. If two sources emit the same `id` and `path`, Flecto keeps only the highest severity.

## 3. Gate a plugin with `ctx`

[`async-rollout-guard.js`](../examples/fixtures/policies/plugins/async-rollout-guard.js) uses all context fields to ensure it runs only for the intended evaluation:

```js
if (
  ctx.source !== 'ci'
  || ctx.profile !== 'prod'
  || basename(ctx.file) !== 'current.json'
  || !ctx.packIds.includes('deployment-review')
) {
  return [];
}
```

`ctx.file` is the absolute config path, `ctx.profile` is the selected profile (or `null`), `ctx.source` is `ci` or `watch`, and `ctx.packIds` lists the active packs. Keep context checks narrow: use packs for rules that should apply everywhere, and plugins for rules whose behavior changes by source, profile, file, or active pack.

To see the same plugin deliberately opt out, omit the profile:

```bash
node ../../../index.js ci current.json --snapshot-ref baseline.json --policies default,deployment-review --plugins ./plugins/async-rollout-guard.js --fail-on policy
```

This also exits `1`, but it produces the four pack findings only; `async-rollout-approval` is absent because `ctx.profile` is `null`.

## 4. Fail closed when a plugin cannot load

Plugin load errors are command errors, never an empty finding set. This protects CI from silently skipping policy logic:

```bash
node ../../../index.js ci current.json --snapshot-ref baseline.json --plugins ./plugins/does-not-exist.js --fail-on policy
```

The command exits `1` and reports `Policy plugin not found: ./plugins/does-not-exist.js`. The same fail-closed behavior applies when a module has no `evaluate` export, throws during import or evaluation, or returns something other than an array.

## Adapt the fixtures

Copy the fixture directory into a temporary test directory when a test needs local `policies/` lookup, or load `baseline.json` and `current.json` directly to unit-test `diffTrees` and `evaluatePolicies`. Keep new fixtures focused on a semantic change and document their expected finding so packs and plugins can share them without duplicating setup.
