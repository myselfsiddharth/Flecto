# Policy-pack authoring

Policy packs turn semantic config changes into findings. Flecto loads a named pack from `policies/<id>.json`, `policies/<id>.yaml`, or `policies/<id>.yml` in the current working directory. Local packs take precedence over the built-in `default` and `strict-prod` packs.

Run the complete example:

```bash
cd examples/policy-pack
node ../../index.js ci config.yaml --snapshot-ref baseline.json --policies deployment-safety --fail-on policy
```

The command intentionally exits with status `1`: the example change triggers policy findings.

## Pack schema

A pack must be an object with a `rules` array. The top-level `id` is optional; if omitted, Flecto uses the pack id passed to `--policies`.

```json
{
  "id": "deployment-safety",
  "rules": [
    {
      "id": "public-service-enabled",
      "severity": "error",
      "when": ["added", "changed"],
      "match": { "path": "service\\.public$" },
      "afterEquals": true,
      "message": "A service was made public."
    }
  ]
}
```

Activate one or more packs with comma-separated ids:

```bash
flecto ci config/prod.yaml --policies default,deployment-safety
```

The same `policies` array can be set in `.flectorc` defaults or profiles.

## Fixture tests

Use a fixture directory to test pack findings without writing test harness code:

```bash
flecto policies test examples/fixtures/policies
```

The directory must contain `flecto-policy-test.json`, plus a baseline and current config (by default, `baseline.json` and `current.json`). The config names active `policies` and optional `plugins`, then lists the expected finding triples:

```json
{
  "policies": ["default", "deployment-review"],
  "expected": [
    { "id": "pool-size-jump", "severity": "warn", "path": "database.pool_size" }
  ]
}
```

The command succeeds only when every expected `{ id, severity, path }` matches and no unexpected finding is emitted. Mismatch output separates missing findings from unexpected findings. See the [plugin cookbook](plugin-cookbook.md) for a complete pack and plugin fixture.

## Rules and matchers

Each rule produces one finding for every change that satisfies all specified conditions.

| Field | Meaning |
| --- | --- |
| `id` | Finding identifier. Use a stable, descriptive id. |
| `severity` | `info`, `warn`, or `error`. |
| `when` | Optional change types: `added`, `removed`, and/or `changed`. Defaults to all three. |
| `match.path` | Optional JavaScript regular expression matched against the semantic change path. |
| `match.pathFlags` | Optional JavaScript regular-expression flags, such as `i`. |
| `afterEquals` | Optional exact post-change value matcher. |
| `numericJump.minMultiple` | Optional numeric increase threshold. |
| `message` | Static finding text. |
| `messageTemplate` | Finding text with `{before}`, `{after}`, and `{path}` placeholders. Takes precedence over `message`. |

Paths use dot notation and array indices, for example `database.pool_size` and `servers[0].port`. `match.path` is a regular expression, so anchor it when you need an exact path:

```json
{ "path": "^database\\.pool_size$", "pathFlags": "i" }
```

`numericJump` matches only when both values are JavaScript numbers, the previous value is greater than zero, and `after >= before * minMultiple`.

## Exact values, truthiness, and coercion

Flecto currently provides `afterEquals`, not `afterTruthy`. `afterEquals` uses JavaScript strict equality (`===`); it does not coerce strings, numbers, or booleans.

```json
{ "afterEquals": true }
```

This matches the boolean `true` from JSON or YAML, but does **not** match the string `"true"`, number `1`, or another truthy value. Likewise, `{ "afterEquals": 2 }` does not match `"2"`. Normalize configuration values in the source file, or use a local plugin when a truthy or coercing rule is required.

## Findings and CI

Flecto records the rule id, severity, changed path, message, and pack id. When multiple packs or plugins return the same `id` and `path`, Flecto keeps the highest severity (`error` > `warn` > `info`).

Use `--fail-on policy` to fail CI for any finding, or `--fail-on error` / `--fail-on warn` to set a severity threshold.

The [plugin cookbook](plugin-cookbook.md) demonstrates how pack findings merge with async plugins using shared policy fixtures.
