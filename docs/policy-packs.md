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
| `beforeLooksSecret` / `afterLooksSecret` | `true` when the value — or any string nested inside it — looks like a credential. |
| `numericJump.minMultiple` | Optional numeric increase threshold. |
| `message` | Static finding text. |
| `messageTemplate` | Finding text with `{before}`, `{after}`, and `{path}` placeholders. Takes precedence over `message`. |

Paths use dot notation and array indices, for example `database.pool_size` and `servers[0].port`. `match.path` is a regular expression, so anchor it when you need an exact path:

```json
{ "path": "^database\\.pool_size$", "pathFlags": "i" }
```

`numericJump` matches only when both values are JavaScript numbers, the previous value is greater than zero, and `after >= before * minMultiple`.

## Secret-shaped values

`afterLooksSecret` (and its mirror `beforeLooksSecret`) matches on the value
rather than the path, so a credential stored under a name like `db.connstr` or a
bare `value` is caught:

```json
{
  "id": "credential-in-config",
  "severity": "error",
  "when": ["added", "changed"],
  "afterLooksSecret": true,
  "message": "This value looks like a credential."
}
```

The predicate is true when the value — or any string nested inside an object or
array value — matches a known token format (AWS, GitHub, Slack, Google, Stripe,
JWT, PEM private-key block, or credentials embedded in a URL) or clears a
conservative high-entropy test. It is the same detection that `--mask-secrets`
uses, documented in [secret masking](configuration.md#secret-masking); benign
shapes such as hostnames, UUIDs, git SHAs, version strings, and file paths do
not match, and environment references such as `${DB_PASSWORD}` are ignored.

The built-in `default` and `strict-prod` packs ship this as
`secret-value-detected` (`error`), alongside the key-name rule
`secret-key-changed`; `strict-prod` also covers removals. A change whose key
*and* value both look secret produces both findings. Silence either one per
profile with `severityRemap`.

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

## Installing a community pack

Any npm package named `flecto-pack-<id>` — or `@scope/flecto-pack-<id>` — that
carries a declarative pack file is installable. npm is the registry; Flecto
hosts nothing.

```bash
npm install --save-dev flecto-pack-deployment-safety
flecto policies add deployment-safety   # the full package name works too
flecto ci config/prod.yaml --policies default,deployment-safety
```

`flecto policies add` writes the pack to `policies/<id>.json`, so the ordinary
resolution order picks it up with no new mechanism and nothing to configure. The
copy is yours: a plain file, reviewable in a pull request and diffable when you
upgrade. After `npm update`, re-run the command with `--force` to pull the newer
version in.

What the command does:

- Resolves the package from `node_modules`, walking up from the working
  directory exactly like `require` does. When it is not installed, the error
  names the `npm install` to run and the command exits `1`.
- Validates the pack with the same validator used at evaluation time (see the
  [pack schema](../schemas/flecto-policy-pack-2.0.json)). A malformed
  third-party pack is rejected at add time and nothing is written.
- Refuses to overwrite an existing local `policies/<id>.json`, `.yaml`, or
  `.yml` unless `--force` is passed, and warns when the id shadows a built-in
  pack.
- Records provenance in `policies/.flecto-packs.json`, which `flecto policies
  list` surfaces as the pack's `package`. Pack resolution never reads that file.

**No third-party code is executed.** The command reads exactly one declarative
JSON or YAML file and nothing else — it never imports, requires, or evaluates
JavaScript from the package. A `flecto-pack-*` package that also ships JS has
that JS ignored, and the command says so; a `"flecto"` field pointing at a `.js`
file is rejected outright.

Policy *plugins* are a different thing: they are JavaScript, they run inside
your Flecto process, and `flecto policies add` never installs them. Point
`--plugins` at a path you have read yourself. See [plugins](plugins.md).

Normal supply-chain care still applies. A pack is a small JSON file — read it
before trusting it, and pin the version in `package.json`.

## Distributing a pack

Publishing a pack means publishing a JSON (or YAML) file to npm. Two rules:

1. **Name the package `flecto-pack-<id>`.** Whatever follows the prefix is the
   pack id users pass to `--policies` and the filename written into `policies/`.
   Scopes are supported: `@acme/flecto-pack-edge` installs as `edge`.
2. **Put the pack file at the package root**, named `flecto-pack.json`,
   `flecto-pack.yaml`, or `flecto-pack.yml`.

```
flecto-pack-deployment-safety/
├── package.json
├── flecto-pack.json
└── README.md
```

```json
{
  "name": "flecto-pack-deployment-safety",
  "version": "1.0.0",
  "files": ["flecto-pack.json"],
  "keywords": ["flecto", "flecto-pack", "policy-pack"]
}
```

The convention is filename-based on purpose: a valid pack needs no build step,
no entry point, and no code — `npm publish` on a directory with two files is the
whole workflow, and anyone can read what they are installing.

When the pack file has to live elsewhere, such as a build output, point at it
from `package.json`:

```json
{ "flecto": { "pack": "dist/pack.json" } }
```

A bare string (`"flecto": "dist/pack.json"`) means the same thing. The path must
stay inside the package and end in `.json`, `.yaml`, or `.yml`; a JavaScript
entry point is rejected, because Flecto will not run pack code.

The file's contents are exactly the [pack schema](#pack-schema) documented
above. The top-level `id` is optional: omit it, or set it to the short id. An
`id` that disagrees with the package name is an error, so what a user types
after `--policies` always matches what they installed.

Two conventions worth following, neither enforced: publish with the
`flecto-pack` keyword so packs are findable on npm, and ship a fixture
directory so `flecto policies test` can act as the pack's test suite in CI.
