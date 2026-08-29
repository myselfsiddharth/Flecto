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

### `expandSubtrees`

The differ reports an added or removed key once, carrying its whole subtree as
the value: adding a nested block is *one* change at the parent path, not one per
field. A path-anchored rule cannot see inside such a value. Set the optional
pack-level `expandSubtrees` to expand added and removed subtrees into the leaf
changes they imply before rules run, so a rule fires the same way whether a
field changed in place or arrived with its parent:

```json
{ "id": "kubernetes", "expandSubtrees": true, "rules": [] }
```

A finding's path can then be deeper than any change in the emitted change list —
the finding names the leaf that is risky. The flag is per pack and defaults to
`false`, so packs that do not set it are unaffected. The built-in `kubernetes`
pack enables it; see [Kubernetes](kubernetes.md#whole-subtree-changes).

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
| `afterMatches` | Optional JavaScript regular expression matched against a **string** post-change value. |
| `afterAnyMatches` | The same expression applied to the elements of an **array** post-change value; matches when any string element matches. |
| `beforeLooksSecret` / `afterLooksSecret` | `true` when the value — or any string nested inside it — looks like a credential. |
| `numericJump.minMultiple` | Optional numeric increase threshold. |
| `message` | Static finding text. |
| `messageTemplate` | Finding text with `{before}`, `{after}`, and `{path}` placeholders. Takes precedence over `message`. |

Paths use dot notation and array indices, for example `database.pool_size` and `servers[0].port`. `match.path` is a regular expression, so anchor it when you need an exact path:

```json
{ "path": "^database\\.pool_size$", "pathFlags": "i" }
```

`numericJump` matches only when both values are JavaScript numbers, the previous value is greater than zero, and `after >= before * minMultiple`.

### Matching a value that became a list

`afterMatches` requires a string, so it sees nothing when a scalar and a list are
swapped in one edit. That edit is a single `changed` event whose `after` is an
array — the differ reports a type change and does not descend into it, so there
is no per-element leaf to match either:

```
~ jobs.build.runs-on: ubuntu-latest → [self-hosted, linux]
```

`afterAnyMatches` covers it, and the two compose in an `anyOf` so one rule reads
both shapes:

```json
{
  "id": "self-hosted-runner",
  "severity": "error",
  "match": { "path": "^jobs\\.[^.]+\\.runs-on$" },
  "anyOf": [
    { "afterMatches": "(^|[ ,])self-hosted([ ,]|$)" },
    { "afterAnyMatches": "(^|[ ,])self-hosted([ ,]|$)" }
  ]
}
```

The scan is deliberately flat and array-only:

- A **non-array** value never matches. `afterMatches` keeps its exact meaning, so
  adding `afterAnyMatches` to a pack cannot change what its existing rules match.
- Only **string** elements are tested; a number or `null` element is skipped
  rather than stringified.
- It does **not** recurse into a nested array or object element. A rule that
  matched at arbitrary depth could not be understood from its own text, which is
  the property that makes a rule reviewable.

It applies to any list a pack reasons about — allowed registries, CIDR ranges,
capability lists — not only to `runs-on`.

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

## Encrypted files

Rules can match encrypted files too, because Flecto reports their structure
without ever decrypting them. Two synthetic paths carry the signals a
key-by-key walk cannot express — `<encryption>` when a file gains or loses
encryption, and `<encryption.mac>` when a SOPS MAC moves on its own — and
recipient key groups are re-keyed by recipient identity so a key gaining access
is a single `added` event at a path that names it:

```json
{
  "id": "recipient-added",
  "severity": "error",
  "when": ["added"],
  "match": { "path": "^sops\\.(kms|gcp_kms|azure_kv|hc_vault|age|pgp)(?:$|[.\\[])" },
  "messageTemplate": "A key that can decrypt this file was added at {path}."
}
```

The built-in `sops` pack ships this and five more; `default` carries the two
that catch a secret committed in the clear. →
**[Encrypted files](encrypted-files.md#policy-rules)**

## GitHub Actions workflows

The built-in `github-actions` pack is enabled by `flecto init` when
`.github/workflows/` exists, and it watches `*.yml` and `*.yaml` workflows.

Workflow YAML is the one config file in most repositories where a bad change is
a **security incident rather than an outage**, so each rule below carries its
reasoning. A reviewer who cannot see why a finding exists suppresses it.

### Triggers

| Rule | Severity | Fires when | Why it is a finding |
|---|---|---|---|
| `github-actions-pull-request-target` | error | `on.pull_request_target` is added | `pull_request_target` runs with the **base** repository's token and secrets while the pull request's own code is what changed. It is the canonical CI takeover vector: a fork opens a PR, the workflow runs privileged, and anything the PR controls that reaches execution inherits that privilege. |
| `github-actions-schedule-exposed` | warn | `on.schedule` is added | A scheduled run reaches secrets and permissions with no pull request and no reviewer in the loop. The trigger itself is routine; what it makes reachable unattended is the thing to check. |
| `github-actions-workflow-dispatch-exposed` | warn | `on.workflow_dispatch` is added | Manual dispatch is gated on write access to the repository, not on review. It widens who can reach the job's permissions and secrets, so it needs a documented owner. |
| `github-actions-workflow-call-exposed` | warn | `on.workflow_call` is added | A reusable workflow inherits the **caller's** permissions and may inherit its secrets. The trust boundary moves to every caller, present and future, so it can no longer be read from this file alone. |

### Token scope

| Rule | Severity | Fires when | Why it is a finding |
|---|---|---|---|
| `github-actions-permissions-removed` | error | the `permissions` block is removed | Removing the block does not narrow the token — it hands scope selection back to the repository or organization default, which may be the legacy read/write default. A quiet deletion looks like cleanup in review and is a widening. |
| `github-actions-permissions-write-all` | error | `permissions` is set to `write-all` | `write-all` grants every scope, including `contents: write` and `packages: write`. Any code the job runs can push commits, publish releases, or move tags. |
| `github-actions-permission-write-scope` | warn | a single scope under `permissions` becomes `write` | This is how a least-privilege block regresses in practice: one scope at a time, in a diff that otherwise looks unrelated. `warn` rather than `error` because a single scope is often genuinely required — the point is that the reviewer sees it. |

### Execution surface

| Rule | Severity | Fires when | Why it is a finding |
|---|---|---|---|
| `github-actions-unpinned-action` | error | `uses` references anything other than a 40-character commit SHA | A tag or branch is mutable. `@v4` resolves to whatever the action's owner points it at today, so trusting it is trusting that account and everyone with push access to it, continuously — this is the shape of the `tj-actions/changed-files` compromise. Pin the SHA and keep the human-readable version in a trailing comment. |
| `github-actions-pull-request-head-checkout` | error | a step checks out `github.event.pull_request.head.sha` | On its own this is fine — it is what a build of the PR must do. It is a finding because combined with `pull_request_target` or a write-scoped token it puts fork-controlled code inside a privileged job. Flecto reports it so the combination gets a second look. |
| `github-actions-secrets-in-run` | error | `secrets.*` is interpolated into a `run:` block | Interpolation happens **before** the shell runs, so the secret is pasted into the command line, where it can be logged, leak through `set -x`, or be captured by anything the step invokes. Bind it through `env:` instead, which keeps it out of the command text. |
| `github-actions-self-hosted-runner` | error | a job moves to a `self-hosted` runner | Self-hosted runners are not ephemeral by default. They keep state, credentials, and network position between jobs, so code that runs on one can read what an earlier job left behind and reach hosts a GitHub-hosted runner cannot. |

### What the pack does not claim

The pack is **changed-file oriented**. It reports what this pull request changed,
not what the workflow already contained; scanning a workflow for pre-existing
problems is a linter's job, and `actionlint` and `zizmor` do it well.

Two limits are worth stating outright, because each is a case where a reader
could reasonably expect a finding and not get one:

- **Severity cannot depend on the trigger.** Widening `permissions` on a
  `pull_request_target` workflow is critical; the same edit on a manually
  dispatched workflow is routine. A rule matches one change event and cannot
  consult the rest of the document, so each severity here is chosen for the
  worst plausible context. That is a rule-engine limitation, recorded rather
  than encoded as a flat severity that trains people to ignore the finding.
- **A trigger added together with its sub-keys reports once, at the trigger.**
  The trigger rules use `pathEquals`, so adding `workflow_call:` with an
  `inputs:` block yields one finding rather than one per input.

The pack sets `expandSubtrees`, so a step, `with:` block, or whole job that
arrives at once is still inspected at its leaf paths — otherwise the newest code
in a workflow would be the code no rule could see.

Five fixtures record the boundary, and they are the specification:
`examples/fixtures/policies/github-actions/` (triggering changes),
`github-actions-permissions-removed/`, `github-actions-permission-scope/`,
`github-actions-runs-on-widened/` (a `runs-on` scalar widened to a list, with a
benign widening beside it), and `github-actions-benign/`, which asserts **zero**
findings for changes that only look risky.

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
