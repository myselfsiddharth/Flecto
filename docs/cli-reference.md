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
| `--format <type>` | `json` | `json`, `ndjson`, or `github-annotations` |
| `--fail-on <rules>` | `changed,policy,error` | Comma-separated fail triggers |
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

Full CI guide, including the GitHub Action: [ci.md](ci.md).

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

Write a starter `.flectorc` in the current directory.

```bash
flecto init
```

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
