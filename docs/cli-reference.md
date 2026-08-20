# CLI reference

Complete flag reference for every Flecto command. For task-oriented guides, start
with the [README](../README.md).

Global:

```bash
flecto --version
flecto --help
flecto help <command>
```

---

## `flecto watch [files...]`

Watch config files or globs and print semantic changes as they happen. Also hosts
the snapshot and diff modes.

```bash
flecto watch config/prod.yaml
flecto watch "config/**/*.yaml" ".env"
```

If you omit `files`, Flecto uses the `files` / `include` patterns from `.flectorc`.

| Flag | Default | Description |
|---|---|---|
| `-p, --profile <name>` | — | Use a profile from `.flectorc` (else `FLECTO_PROFILE`) |
| `-m, --mode <mode>` | `compact` | Output mode: `compact` or `verbose` |
| `-i, --interval <ms>` | `100` | Polling interval, used when `--polling` is on |
| `--polling` | off | Force polling instead of native filesystem events |
| `-c, --command <cmd>` | — | Shell command to run on every change |
| `-w, --webhook <url>` | — | POST the change envelope to this URL |
| `--webhook-header <header>` | — | Extra webhook header, repeatable |
| `--webhook-timeout <ms>` | `5000` | Webhook request timeout |
| `--webhook-retries <n>` | `2` | Webhook retry attempts |
| `--webhook-format <service>` | `flecto` | Payload shape: `flecto`, `slack`, `discord`, `teams`, or `auto` (detect from the URL) |
| `--delivery-mode <mode>` | `best-effort` | `best-effort` or `at-least-once` |
| `--on-alert-failure <mode>` | `warn` | `warn`, `exit`, or `retry` |
| `--ignore <keys>` | — | Comma-separated key paths to ignore |
| `--policies <ids>` | `default` | Comma-separated policy pack ids |
| `--plugins <paths>` | — | Comma-separated local ESM plugin paths |
| `--array-id-key <key>` | auto | Diff arrays by this identity key |
| `--no-array-id` | — | Diff arrays by index instead of identity |
| `--array-ignore-order` | off | Treat array order as insignificant |
| `--mask-secrets` | off | Mask secret-like values in terminal output |
| `--mask-secrets-webhooks` | off | Also mask secrets in webhook payloads |
| `--snapshot` | — | Save current state as a baseline instead of watching |
| `--diff` | — | Diff against the saved baseline and exit |
| `--allow-empty` | off | Let `--snapshot` succeed when nothing was written |

**Exit codes:** watch mode runs until interrupted (`0` on clean shutdown).
With `--diff`: `0` when the file matches the baseline, `1` when it differs.

See [configuration](configuration.md) for `--ignore` pattern syntax and array
identity behavior, and [webhooks](webhooks.md) for delivery details.

---

## `flecto ci [files...]`

Run a one-shot semantic diff against a baseline and exit with a status code CI
can gate on.

```bash
flecto ci "config/**/*.yaml" --snapshot-ref HEAD~1 --fail-on "policy,error"
```

| Flag | Default | Description |
|---|---|---|
| `-p, --profile <name>` | — | Use a profile from `.flectorc` (else `FLECTO_PROFILE`) |
| `--snapshot-ref <ref>` | local snapshot | Baseline: a snapshot file path, or a git ref |
| `--format <type>` | `json` | `json`, `ndjson`, `sarif`, `github-annotations`, or `pr-comment` |
| `--pr-comment-post` | off | With `--format pr-comment`, upsert the sticky comment on the PR |
| `--fail-on <rules>` | `changed,policy,error` | Comma-separated fail triggers |
| `--baseline <file>` | — | Gate only on findings not already recorded in this file |
| `--update-baseline` | off | Rewrite the `--baseline` file from the current findings |
| `--ignore <keys>` | — | Comma-separated key paths to ignore |
| `--policies <ids>` | `default` | Comma-separated policy pack ids |
| `--plugins <paths>` | — | Comma-separated local ESM plugin paths |
| `--array-id-key <key>` | auto | Diff arrays by this identity key |
| `--no-array-id` | — | Diff arrays by index instead of identity |
| `--array-ignore-order` | off | Treat array order as insignificant |
| `--mask-secrets` | off | Mask secret-like values in CI output |
| `--allow-empty` | off | Succeed when no files were diffed |

**Fail triggers:** `changed`, `added`, `removed`, `policy`, `error`, `warn`.

**Exit codes:** `0` when nothing matched a fail trigger, `1` when something did
or when the run errored.

Two things fail closed by design: an unresolved `--snapshot-ref` is an error
rather than a silently empty baseline, and a run where every target is missing or
unsupported exits non-zero unless you pass `--allow-empty`.

`--format pr-comment` prints a markdown risk summary to stdout. It posts that
summary as a single sticky pull request comment only when `--pr-comment-post` is
passed *and* `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, and a PR number (from
`GITHUB_REF` or `GITHUB_EVENT_PATH`) are all present — otherwise it warns and
prints. A delivery failure never changes the exit code.

Full CI guide, including the GitHub Action: [ci.md](ci.md).

---

## `flecto compare <fileA> <fileB>`

Diff two *different* files against each other — the same differ and policy engine
`watch` and `ci` use, pointed at environment skew instead of drift over time.

```bash
flecto compare config/prod.yaml config/staging.yaml
flecto compare config/prod.yaml config/prod.json --format json
```

**`fileA` is the baseline.** Changes are reported as what `fileB` does to it:
`+` exists only in `fileB`, `-` exists only in `fileA`, `~` is a value that
differs. Swap the arguments to flip the direction.

Both arguments are single file paths, not globs, and both are required — a
missing one is an error rather than a skipped target. The two files do not have
to share a format, since every supported format parses to a plain tree.

| Flag | Default | Description |
|---|---|---|
| `-p, --profile <name>` | — | Use a profile from `.flectorc` (else `FLECTO_PROFILE`) |
| `--format <type>` | `human` | `human`, `json`, `ndjson`, or `github-annotations` |
| `--fail-on <rules>` | `changed,added,removed,policy,error` | Comma-separated fail triggers |
| `--ignore <keys>` | — | Comma-separated key paths to ignore |
| `--policies <ids>` | `default` | Comma-separated policy pack ids |
| `--plugins <paths>` | — | Comma-separated local ESM plugin paths |
| `--array-id-key <key>` | auto | Diff arrays by this identity key |
| `--no-array-id` | — | Diff arrays by index instead of identity |
| `--array-ignore-order` | off | Treat array order as insignificant |
| `--mask-secrets` | off | Mask secret-like values in output |

**Fail triggers:** the same set `ci` uses — `changed`, `added`, `removed`,
`policy`, `error`, `warn`. The default differs from `ci`: two environments that
are meant to match should also match on added and removed keys, so all three
change kinds gate by default.

**Exit codes:** `0` when the two files match under the active fail triggers, `1`
when they differ, a policy trigger fires, or the run errored.

The non-`human` formats emit exactly what `ci` emits — an array of per-file
results, each with a `2.0` envelope — plus a `baseline` field naming `fileA`.
Envelopes carry `source: "diff"`.

---

## `flecto plan <planFiles...>`

Diff Terraform plan JSON (the output of `terraform show -json`) and run
policies on it — the same differ, envelope, and exit-code model every other
Flecto command uses, pointed at a plan instead of a config file.

```bash
terraform plan -out plan.tfplan
terraform show -json plan.tfplan > plan.json

flecto plan plan.json
```

Flecto never runs the `terraform` binary; it only reads the JSON you hand it.

| Flag | Default | Description |
|---|---|---|
| `-p, --profile <name>` | — | Use a profile from `.flectorc` (else `FLECTO_PROFILE`) |
| `--format <type>` | `human` | `human`, `json`, `ndjson`, `github-annotations`, or `pr-comment` |
| `--pr-comment-post` | off | With `--format pr-comment`, upsert the comment on the PR (needs `GITHUB_TOKEN` + PR context) |
| `--fail-on <rules>` | `error` | Comma-separated fail rules: `changed`, `added`, `removed`, `policy`, `error`, `warn` |
| `--ignore <keys>` | — | Comma-separated key paths to ignore, e.g. `**.tags_all,**.#action` |
| `--policies <ids>` | `terraform` | Comma-separated policy pack ids |
| `--plugins <paths>` | — | Comma-separated local ESM plugin paths |
| `--mask-secrets` | off | Also mask Flecto-detected secret-like values (Terraform-sensitive values are always redacted, regardless of this flag) |

**Fail triggers:** the same set `ci` uses — `changed`, `added`, `removed`,
`policy`, `error`, `warn`. The default is `error` alone, not `changed`: a plan
is supposed to contain changes, so gating on their existence would fail every
non-empty plan.

**Exit codes:** `0` when nothing matched a fail trigger, `1` when something did
or the run errored.

A replace (destroy-and-recreate) is reported as a `removed` event, so
`--fail-on removed` catches every replace with no policy pack loaded at all.
Values Terraform marks sensitive are redacted to `(sensitive value)`
unconditionally, before any formatter sees them.

Several plan files in one run each produce their own result entry, exactly
like `ci` with multiple files.

Full guide, including the `terraform` policy pack and CI wiring:
[terraform.md](terraform.md).

---

## `flecto history [files...]`

Summarize drift across local snapshots in `.flecto-snapshots/`. Omit `files` to
show all saved history.

```bash
flecto history config/prod.yaml --limit 10
```

| Flag | Default | Description |
|---|---|---|
| `-l, --limit <n>` | `10` | Number of recent snapshots to show |
| `-p, --profile <name>` | — | Use a profile from `.flectorc` (else `FLECTO_PROFILE`) |
| `--ignore <keys>` | — | Comma-separated key paths to ignore |
| `--array-id-key <key>` | auto | Diff arrays by this identity key |
| `--array-ignore-order` | off | Treat array order as insignificant |

Change counts use the same ignore paths, array identity, and order settings as
`flecto watch --diff`. This command is entirely local — it reads snapshot files
and sends nothing anywhere.

---

## `flecto report [files...]`

Render the same snapshot history `flecto history` summarizes as a single
self-contained HTML file you can share. Omit `files` to report on all saved
history.

```bash
flecto report
flecto report config/prod.yaml --limit 20 --output drift.html
flecto report --profile prod --mask-secrets
```

| Flag | Default | Description |
|---|---|---|
| `-o, --output <path>` | `flecto-report.html` | Where to write the report |
| `-l, --limit <n>` | `10` | Number of recent snapshots to include |
| `-p, --profile <name>` | — | Use a profile from `.flectorc` (else `FLECTO_PROFILE`) |
| `--ignore <keys>` | — | Comma-separated key paths to ignore |
| `--policies <ids>` | `default` | Comma-separated policy pack ids |
| `--plugins <paths>` | — | Comma-separated local ESM plugin paths |
| `--array-id-key <key>` | auto | Diff arrays by this identity key |
| `--no-array-id` | — | Diff arrays by index instead of identity |
| `--array-ignore-order` | off | Treat array order as insignificant |
| `--mask-secrets` | off | Mask secret-like values in the report |

The page holds a per-file timeline of snapshots — each with its UTC timestamp,
the snapshot it is measured against, every semantic change, and the policy
findings that change produced — plus a summary and all findings grouped by
severity. Missing directories in `--output` are created.

**The file is self-contained.** Inline CSS, one small inline script for
filtering and collapsing, and nothing else: no fonts, no images, no CDN scripts,
no analytics, no network access when it is opened. It reads the same
`.flecto-snapshots/` history `flecto history` reads, so nothing new is
collected and nothing leaves your machine. It follows the viewer's light or dark
theme and prints reasonably.

Every config value, path, and message is HTML-escaped, so a value containing
markup renders as text. Values that reach the page are the *only* place a secret
could leak from a report, so pass `--mask-secrets` (or set `maskSecrets` in a
profile) whenever you plan to share one: masking uses the same key-name and
value-pattern detection as everywhere else, and it also redacts policy messages
that interpolate values.

**Exit codes:** `0` when a report was written, `1` when no snapshots matched —
the same message `flecto history` gives, and no file is written.

---

## `flecto policies add <name>`

Install a policy pack from an npm package that follows the `flecto-pack-*`
convention. The package must already be installed; this command does not reach
the network.

```bash
npm install --save-dev flecto-pack-deployment-safety
flecto policies add deployment-safety
flecto policies add flecto-pack-deployment-safety   # same thing
flecto policies add deployment-safety --force       # after npm update
```

| Flag | Default | Description |
|---|---|---|
| `--force` | off | Overwrite an existing local pack with the same id |

`<name>` is either the pack id or the full package name; the two are normalized
onto each other, and `@scope/flecto-pack-<id>` is supported. The pack is
validated with the same validator used at evaluation time, then written to
`policies/<id>.json`, where the normal resolution order finds it. Provenance is
recorded in `policies/.flecto-packs.json` and shown by `flecto policies list`;
resolution itself never consults that file.

Only the package's declarative pack file is read — no JavaScript from the
package is imported or run, and JS in a pack package is ignored. Plugins, which
do execute code, are never installed by this command.

**Exit codes:** `0` when the pack is written, `1` when the package is not
installed, carries no valid pack, or would overwrite a local pack without
`--force`.

See [installing community packs](policy-packs.md#installing-a-community-pack)
and [distributing a pack](policy-packs.md#distributing-a-pack).

---

## `flecto policies list`

List every bundled and local policy pack that resolves from the current
directory, with its source path and rule count.

```bash
flecto policies list
flecto policies list --json
```

| Flag | Default | Description |
|---|---|---|
| `--json` | off | Machine-readable output |

Resolution order for a given pack id: `policies/<id>.json`, then
`policies/<id>.yaml`, then `policies/<id>.yml`, then the built-in pack. A local
pack with the same id overrides its built-in counterpart.

Packs installed with `flecto policies add` carry a `package` field naming the
npm package they came from (`-` in the text output when a pack was written by
hand).

---

## `flecto policies test <fixtureDir>`

Assert that a policy pack or plugin produces the findings you expect, from a
fixture directory.

```bash
flecto policies test examples/fixtures/policies
```

| Flag | Default | Description |
|---|---|---|
| `--config <name>` | `flecto-policy-test.json` | Fixture config file name |

**Exit codes:** `0` when the fixture's expectations hold, `1` otherwise.

A worked example lives in
[`examples/fixtures/policies`](../examples/fixtures/policies). See the
[policy pack guide](policy-packs.md) for authoring.

---

## `flecto init`

Write a starter `.flectorc.json` in the current directory, pre-selecting policy
packs and file patterns from the stack signals it finds there.

```bash
flecto init
```

| Detected | Effect |
|---|---|
| `docker-compose.yml` / `.yaml`, `compose.yml` / `.yaml` | `compose` pack + the compose file in `files` |
| `package.json` | `node-runtime` pack + `package.json` in `files` |
| `config/` | `config/**/*.{yaml,yml,json,toml,ini}` in `files` |
| `.env`, `.env.*`, `*.env` | `.env`, `.env.*`, `*.env` in `files` |
| `*.tf` | Reported only — no `terraform` pack exists yet, and `.tf` is not parseable |

The `default` pack is always enabled, and detected packs are added to the `prod`
profile alongside `strict-prod`. With no signals, the generic starter config is
written instead.

An existing `.flectorc`, `.flectorc.json`, `.flectorc.yaml`, or `.flectorc.yml`
is never overwritten: `init` reports the file it found and leaves it alone.

**Exit codes:** `0` whether a config was written or an existing one was kept.

See [configuration](configuration.md#creating-a-config-file) for the generated
keys.

---

## `flecto doctor`

Check the local setup: which config file resolved, how many files its patterns
match, and whether the Node.js runtime is supported.

```bash
flecto doctor
```

**Exit codes:** `0` when the environment is usable, `1` on an unsupported Node.js
version or a broken config.

---

## Environment variables

| Variable | Read by | Description |
|---|---|---|
| `FLECTO_PROFILE` | all commands | Profile name, when `--profile` is not passed |

Flecto also *sets* variables for `--command` subprocesses — see
[webhooks and commands](webhooks.md#running-a-command-on-change).
