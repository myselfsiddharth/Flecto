# Running Flecto in CI

`flecto ci` diffs config against a baseline and exits non-zero when something you
care about changed — so a risky config edit fails the build instead of reaching
production unnoticed.

---

## The basic run

```bash
flecto ci "config/**/*.yaml" \
  --snapshot-ref HEAD~1 \
  --format github-annotations \
  --fail-on "changed,policy,error"
```

**Exit codes:** `0` when nothing matched a fail trigger, `1` when something did.

---

## Choosing a baseline

`--snapshot-ref` accepts either a git ref or a snapshot file path. The value is
resolved as a filesystem path first; if no such file exists, it's treated as a
git ref and read with `git show <ref>:<file>`.

```bash
flecto ci config/prod.yaml --snapshot-ref HEAD~1
flecto ci config/prod.yaml --snapshot-ref origin/main
flecto ci config/prod.yaml --snapshot-ref .flecto-snapshots/4b8cbbd70d1832a2.json
```

Omit `--snapshot-ref` entirely and Flecto compares against the local snapshot
saved for that file by `flecto watch --snapshot`. That's convenient locally, but
in CI you almost always want an explicit git ref, since a fresh runner has no
local snapshots.

An unresolved ref is an error, not an empty baseline — otherwise a bad ref would
silently report "no changes" and pass every build.

> Don't glob into `--snapshot-ref`. Each `--snapshot` run writes both a stable
> `<hash>.json` and a timestamped history file, so `.flecto-snapshots/*.json`
> expands to several paths — the first becomes the ref and the rest are parsed as
> target files. Name one file, or omit the flag.

---

## Fail triggers

`--fail-on` takes a comma-separated list. Default: `changed,policy,error`.

| Trigger | Fails when |
|---|---|
| `changed` | Any value changed |
| `added` | Any key was added |
| `removed` | Any key was removed |
| `policy` | Any policy finding was produced |
| `error` | Any `error`-severity finding was produced |
| `warn` | Any `warn`-severity finding was produced |

Most teams start with `policy,error` — gate on risk, not on the existence of a
diff — and tighten later.

---

## Output formats

### `github-annotations`

Findings appear inline on the changed lines in the PR's Files tab.

```
::warning file=config/prod.yaml,title=flecto policy pool-size-jump [default]::database.pool_size: Pool size increased from 5 to 20 (>=2x).
::error file=config/prod.yaml,title=flecto policy dangerous-toggle-enabled [default]::logging.debug: Potentially dangerous toggle enabled.
```

### `json`

One array of per-file results, each carrying a full envelope. Good for archiving
a build's config state or post-processing.

### `ndjson`

One JSON object per line — for streaming into a log pipeline without buffering
the whole run.

Envelope shape is documented in [webhooks.md](webhooks.md#envelope-shape) and
formally in
[`schemas/flecto-envelope-2.0.json`](../schemas/flecto-envelope-2.0.json).

---

## GitHub Action

The bundled Action wraps `flecto ci` with annotations enabled by default.

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@v7
    with:
      fetch-depth: 2
  - uses: myselfsiddharth/Flecto/.github/actions/flecto-ci@main
    with:
      targets: config/**/*.{yaml,yml,json,toml,ini}
      snapshot-ref: HEAD~1
```

| Input | Default | Description |
|---|---|---|
| `targets` | `config/**/*.{yaml,yml,json,toml,ini}` | Whitespace-separated paths or globs |
| `fail-on` | `policy,error` | Comma-separated events that fail the job |
| `policies` | _(empty)_ | Comma-separated pack ids; omit to use `.flectorc` |
| `profile` | _(empty)_ | Optional `.flectorc` profile |
| `format` | `github-annotations` | Output format |
| `snapshot-ref` | `HEAD~1` | Git ref or snapshot file used as the baseline |
| `node-version` | `20` | Node.js version used to run Flecto |

`contents: read` is required by `actions/checkout`. The Action only emits
workflow-command annotations, so it needs no write permissions.

Keep `fetch-depth: 2` (or `0`) when using the default `HEAD~1` baseline —
the default shallow checkout of depth 1 has no parent commit to diff against.

A complete workflow is in
[`examples/github-action/flecto-ci.yml`](../examples/github-action/flecto-ci.yml),
and the Action itself is at
[`.github/actions/flecto-ci/action.yml`](../.github/actions/flecto-ci/action.yml).

### Pinning

The Action runs `npx --yes flecto@2 ci`, so compatible updates are picked up
automatically. For fully reproducible builds, pin the Action reference to a
commit SHA and replace `@2` in a forked Action with an exact published version.

---

## Other CI systems

`flecto ci` is a plain CLI with meaningful exit codes, so any runner works:

```yaml
# GitLab CI
config-check:
  image: node:22
  script:
    - npx --yes flecto@2 ci "config/**/*.yaml" --snapshot-ref "$CI_MERGE_REQUEST_DIFF_BASE_SHA" --fail-on "policy,error"
```

```bash
# Pre-commit hook (.git/hooks/pre-commit)
npx --yes flecto@2 ci "config/**/*.yaml" --snapshot-ref HEAD --fail-on "policy,error" || {
  echo "Flecto flagged a risky config change. Review above, or commit with --no-verify."
  exit 1
}
```

---

## Gating environment skew

`flecto ci` asks "did this file change?". `flecto compare` asks "do these two
files agree?" — the same differ, policy engine, fail triggers, and output
formats, with another file as the baseline instead of an earlier version of the
same one.

```bash
flecto compare config/prod.yaml config/staging.yaml \
  --format github-annotations \
  --fail-on "policy,error"
```

The first argument is the baseline; annotations and JSON results are attributed
to the second file, with `baseline` recorded alongside. Exit codes work the same
way, so it drops into a pipeline wherever `flecto ci` does. Flags:
[cli-reference.md](cli-reference.md#flecto-compare-filea-fileb).

---

## Empty runs

If every target is missing or unsupported, `flecto ci` and
`flecto watch --snapshot` exit non-zero rather than reporting a clean pass. This
catches the common failure where a renamed directory quietly turns a config gate
into a no-op. Pass `--allow-empty` when an empty match is legitimately expected.
