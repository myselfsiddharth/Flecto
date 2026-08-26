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

## Suppressing one finding in place

When a single finding is deliberate, accept it *next to the thing being
accepted* with an inline comment, rather than in a baseline file elsewhere:

```yaml
database:
  # flecto-ignore-next-line pool-size-jump — provisioned for the Black Friday load test, reverting in December
  pool_size: 200
```

The comment goes on the line above the flagged value and names the rule. **A
reason is mandatory** — a suppression without one is refused, with a pointer to
the file and line, so a repo never accumulates unexplained `# noqa`:

```
[error] Inline suppression is missing a required reason:
  config/prod.yaml:12: flecto-ignore-next-line pool-size-jump needs a reason …
```

The reason follows the rule id after an em dash (`—`), `--`, `:`, or just a
space. The directive works in every format Flecto parses that *has* comments —
YAML, TOML, INI, and dotenv (`#`, or `;` in INI). **JSON has no comment syntax,**
so use the [baseline](#adopting-on-an-existing-repo-the-baseline) for JSON.

A suppression is scoped to the **next line and the named rule** — never a bare
"ignore everything here"; `--ignore` and `severityRemap` already do that. It
resolves to the exact key on that line (with its full nesting), so a suppression
on one `pool_size` never hides an uncommented `pool_size` elsewhere in the file.
Array items and multi-document YAML resolve to no path — use the baseline for
those.

Suppressed findings are still surfaced so the gate stays legible: a **count** by
default, the full list with `--show-suppressed`, both on stderr.

**Suppression vs. baseline.** They solve different problems. A baseline is "we
are adopting Flecto and have 200 pre-existing findings." A suppression is "this
one line is deliberate, and here is why." Suppressions apply first — a finding
suppressed inline is gone before the baseline is consulted, so it is never
counted twice.

## Adopting on an existing repo: the baseline

Turn Flecto on in a repo that has been running for years and the first CI run is
a wall of findings for config that was already there. The baseline is how you get
to green without either fixing everything first or silencing rules you still want
enforced on *new* config.

```bash
# record what exists today (explicit — a baseline is never written automatically)
flecto ci "config/**/*.yaml" --snapshot-ref origin/main \
  --baseline .flecto-baseline.json --update-baseline

# from now on, gate only on findings that are NOT in the baseline
flecto ci "config/**/*.yaml" --snapshot-ref origin/main \
  --baseline .flecto-baseline.json --fail-on policy,error
```

Commit `.flecto-baseline.json`. A recorded finding is suppressed from both the
gate and the output; a genuinely new finding still fails the build.

**What makes a finding "the same one."** The baseline keys each finding on
`(rule id, file, path)` — deliberately **not** the value. A `pool-size-jump`
accepted at 5→20 stays accepted when it becomes 5→21, so the file does not churn
on every edit and get deleted. The flip side: renaming a file or restructuring a
path re-introduces its findings as new, which is the honest cost of a key precise
enough to tell two findings apart.

The file is human-reviewable and diff-friendly — one entry per finding, sorted,
each carrying the rule, file, path, severity, the message for context, and when
it was accepted. Add a `"reason"` to any entry by hand; `--update-baseline`
preserves it and the original `acceptedAt`:

```json
{
  "version": 1,
  "findings": [
    {
      "rule": "pool-size-jump",
      "file": "config/prod.yaml",
      "path": "database.pool_size",
      "severity": "warn",
      "message": "Pool size increased from 5 to 200 (>=2x).",
      "acceptedAt": "2026-08-17T10:00:00.000Z",
      "reason": "provisioned for the Black Friday load test, reverting in December"
    }
  ]
}
```

**Keeping it honest.** A run reports **stale** entries — recorded findings that no
longer occur — on stderr, so the file shrinks over time instead of accreting
forever. `--update-baseline` prunes them. Updating is always explicit: a CI run
that quietly re-recorded findings would launder new risk into the accepted set,
so it never happens without the flag. A malformed baseline is an error, not a
silent empty one, since treating it as empty would fail the build in a way that
looks like a regression.

`--fail-on changed` and the other change triggers are about the *diff*, not the
findings, so they still fire under a baseline — the baseline accepts policy
findings, it does not accept the change itself.

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

### `sarif`

SARIF 2.1.0, for upload to **GitHub code scanning**. Policy findings render on
the pull request diff and in the Security tab, and GitHub handles dedup,
new-vs-existing, and fixed-finding tracking across runs.

```bash
flecto ci "config/**/*.yaml" --snapshot-ref origin/main --format sarif > flecto.sarif
```

```yaml
permissions:
  contents: read
  security-events: write   # required to upload SARIF
steps:
  - run: flecto ci "config/**/*.yaml" --snapshot-ref origin/main --format sarif > flecto.sarif
  - uses: github/codeql-action/upload-sarif@v3
    with:
      sarif_file: flecto.sarif
```

Two things worth knowing:

- **SARIF carries policy findings, not raw changes.** A SARIF result needs a
  rule id; a bare change (`--fail-on changed`) has none. The run still exits
  non-zero, and the diff is still in the `json` output — SARIF reports the gated
  policy findings.
- **Results are file-level for now.** Flecto reports a semantic *path*
  (`Deployment/prod/api.spec.replicas`), not a source line, so each result
  anchors at the top of the file and preserves the full path as a SARIF *logical
  location*. GitHub still renders, dedupes, and tracks the alert; it just is not
  yet pinned to the exact line.
- **`--mask-secrets` applies.** A SARIF file is uploaded and retained, so mask
  before you upload if findings could carry sensitive values.

### `--changed-only`

`json` and `ndjson` emit one envelope per **scanned** file, so the output grows
with the size of the repository rather than the size of the change. On 250
service configs with one file edited, roughly 88% of it describes files that did
not change. For a human that is invisible — the terminal renderer already prints
only what changed — but webhook sinks, NDJSON consumers, and any agent handed
the JSON pay for it on every run.

`--changed-only` replaces those envelopes with a single manifest:

```bash
flecto ci "config/**/*.yaml" --format json --changed-only
```

```json
[
  {
    "file": "/repo/config/prod.yaml",
    "envelope": { "event_type": "changes", "changes": [ ... ] }
  },
  {
    "scanned": ["/repo/config/dev.yaml", "/repo/config/stage.yaml"],
    "envelope": {
      "event_type": "lifecycle",
      "lifecycle": { "type": "scanned", "message": "2 files scanned with no changes and no policy findings" }
    }
  }
]
```

| change (250 configs) | default | `--changed-only` | reduction |
|---|---|---|---|
| nothing changed | 112.8 KB | 13.3 KB | 88% |
| one file changed | 113.4 KB | 14.3 KB | 87% |
| every 10th file changed | 126.8 KB | 37.3 KB | 71% |

**The evidence that Flecto looked is kept.** An envelope for a scanned but
unchanged file tells a consumer diffing two runs that the file was *checked and
clean*, rather than *not checked at all* — dropping it would quietly weaken a
gate someone relies on. The manifest keeps that list; what it drops is the pair
of UUIDs, timestamp, and repeated schema fields attached to each entry. In the
one-file-changed row above, 11.1 KB of the remaining 14.3 KB **is** the path
list, so nearly all of the per-file overhead is gone and nearly all of what is
left is the evidence itself.

Notes:

- **Off by default.** `schema_version` stays `2.0` and the default output is
  byte-for-byte unchanged, so no existing consumer is affected.
- A file with **policy findings but no changes** is not collapsed — a finding is
  something to report.
- Discriminate on `envelope.event_type === "lifecycle"`; the manifest entry has
  no `file`, since it is not about one file. The path list rides on the result
  wrapper because schema 2.0 closes the envelope to extra properties.
- The flag applies to `json` and `ndjson`. `sarif`, `github-annotations`, and
  `pr-comment` already carry only what changed (or, for `sarif`, only
  findings), and Flecto warns rather than accepting the flag and doing nothing.
- Settable as `changedOnly: true` in `.flectorc` defaults or a profile.

### `pr-comment`

A markdown risk summary for a pull request: change counts, policy findings
grouped by severity, and the per-file change list (collapsed into a `<details>`
block once it passes ten changes). Annotations are easy to miss in the Checks
tab; a comment on the PR is not.

```markdown
<!-- flecto:pr-comment -->

## Flecto — config change report

❌ **Check failing** — 2 changes in 1 file — 2 changed, 0 added, 0 removed.

**Policy:** 1 error, 1 warning.

### Policy findings

#### Errors (1)

| File | Path | Rule | Message |
|---|---|---|---|
| `config/prod.yaml` | `logging.debug` | `dangerous-toggle-enabled` (`default`) | Potentially dangerous toggle enabled. |
```

The first line is a hidden marker, `<!-- flecto:pr-comment -->`. When posting is
enabled, Flecto looks for that marker in the PR's existing comments and edits
the one it finds, so a ten-push PR keeps **one** comment instead of ten. The
body is deterministic, so a run that changes nothing skips the write entirely
and leaves no "edited" noise.

**By default this format only prints to stdout — it never posts.** Posting
happens only when *both* of these are true:

1. You opted in explicitly with `--pr-comment-post` (or `"prCommentPost": true`
   in `.flectorc`), **and**
2. the process has a complete GitHub pull request context: `GITHUB_TOKEN`,
   `GITHUB_REPOSITORY` in `owner/repo` form, and a PR number from `GITHUB_REF`
   (`refs/pull/<n>/merge` or `/head`) or from the event payload at
   `GITHUB_EVENT_PATH`.

`GH_TOKEN` is deliberately ignored, because `gh auth login` exports it on
developer machines. Between the required flag and the required PR-context
variables, a local `flecto ci --format pr-comment` prints markdown and stops.

Anything missing or failing — no token, not a PR run, an API error, a token
without `pull-requests: write` — prints a `[warn]` on stderr and leaves the exit
code alone. **The exit code always reports the diff and policy result, never the
comment delivery.** The token is never printed, and it is redacted from any API
error text that is echoed back.

Before and after values are rendered as they are (truncated at 120 characters),
so pair posting with `--mask-secrets` whenever the watched files can carry
credentials — a PR comment is as visible as the pull request itself.

Because the markdown goes to stdout, you can also post it with your own tooling
and skip Flecto's GitHub client entirely:

```bash
flecto ci "config/**/*.yaml" --snapshot-ref origin/main --format pr-comment > comment.md
gh pr comment "$PR" --body-file comment.md --edit-last
```

In a GitHub Actions workflow, reach for the
[`flecto-pr-risk` Action](#flecto-pr-risk--the-pull-request-gate), which does
this by default and resolves the baseline from the pull request for you. The
general-purpose `flecto-ci` Action can do it too, with the `pr-comment-post`
input and write access to pull requests:

```yaml
permissions:
  contents: read
  pull-requests: write

steps:
  - uses: actions/checkout@v7
    with:
      fetch-depth: 2
  - uses: myselfsiddharth/Flecto/.github/actions/flecto-ci@main
    with:
      targets: config/**/*.{yaml,yml,json,toml,ini}
      format: pr-comment
      pr-comment-post: "true"
      github-token: ${{ github.token }}
```

Forked-PR runs get a read-only token, so posting there fails with a warning
rather than a failed job.

Envelope shape is documented in [webhooks.md](webhooks.md#envelope-shape) and
formally in
[`schemas/flecto-envelope-2.0.json`](../schemas/flecto-envelope-2.0.json).

---

## GitHub Actions

Two composite Actions ship with the repository. Both wrap `flecto ci`; they
differ in what they assume about the run.

| Action | Use it for | Baseline |
|---|---|---|
| [`flecto-ci`](#flecto-ci--the-general-purpose-step) | Any run — pull request, push, schedule | `HEAD~1`, or whatever you pass |
| [`flecto-pr-risk`](#flecto-pr-risk--the-pull-request-gate) | Pull requests, with a sticky risk comment | The pull request's base commit |

### `flecto-ci` — the general-purpose step

Wraps `flecto ci` with annotations enabled by default.

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
| `pr-comment-post` | `false` | With `format: pr-comment`, upsert the sticky PR comment |
| `github-token` | _(empty)_ | Token used to post that comment; posting is skipped without it |
| `snapshot-ref` | `HEAD~1` | Git ref or snapshot file used as the baseline |
| `node-version` | `20` | Node.js version used to run Flecto |

`contents: read` is required by `actions/checkout`. With the default
`github-annotations` format the Action only emits workflow commands, so it needs
no write permissions; `pr-comment-post: "true"` additionally needs
`pull-requests: write` and a `github-token`.

Keep `fetch-depth: 2` (or `0`) when using the default `HEAD~1` baseline —
the default shallow checkout of depth 1 has no parent commit to diff against.

A complete workflow is in
[`examples/github-action/flecto-ci.yml`](../examples/github-action/flecto-ci.yml),
and the Action itself is at
[`.github/actions/flecto-ci/action.yml`](../.github/actions/flecto-ci/action.yml).

### `flecto-pr-risk` — the pull request gate

Everything the sticky comment needs, already switched on. One `uses:` is a
complete adoption; every input below has a working default.

```yaml
permissions:
  contents: read
  pull-requests: write

steps:
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0
  - uses: myselfsiddharth/Flecto/.github/actions/flecto-pr-risk@main
```

| Input | Default | Description |
|---|---|---|
| `targets` | `config/**/*.{yaml,yml,json,toml,ini}` | Whitespace-separated paths or globs |
| `fail-on` | `policy,error` | Comma-separated events that fail the job |
| `policies` | _(empty)_ | Comma-separated pack ids; omit to use `.flectorc` |
| `profile` | _(empty)_ | Optional `.flectorc` profile |
| `format` | `pr-comment` | Output format; `github-annotations` keeps the PR baseline and reports inline |
| `pr-comment-post` | `true` | Upsert the sticky comment; `"false"` renders to the log only |
| `mask-secrets` | `true` | Redact secret-like values before rendering |
| `github-token` | `${{ github.token }}` | Token used to post the comment |
| `snapshot-ref` | _(empty)_ | Baseline override; empty means "the pull request's base commit" |
| `flecto-version` | `2` | npm version range for the CLI |
| `node-version` | `20` | Node.js version used to run Flecto |

Outputs: `snapshot-ref` (the baseline actually used) and `posting-enabled`.

#### The baseline

`HEAD~1` is the wrong baseline for a pull request: it is the previous commit on
the branch, not the state the PR is proposing to change. `flecto-pr-risk`
resolves it from the event instead, in this order:

1. The `snapshot-ref` input, when you set one. It is used verbatim — a git ref
   or a snapshot file — and `flecto ci` fails closed if it does not resolve.
2. `github.event.pull_request.base.sha`, refined to `git merge-base <base> HEAD`
   when the checkout has enough history for it. On a `pull_request` run the two
   are the same commit; the merge base is also right when the branch is checked
   out directly and the base has moved on since.

**`fetch-depth: 0` on `actions/checkout` is required.** The default shallow
checkout has one commit and no base to diff against. When the base commit is
missing the Action tries to fetch just that commit, and if it still cannot get
it the job **fails with an explicit message** naming `fetch-depth: 0` — an
unresolvable baseline would otherwise report "no changes" and wave a risky edit
through. Two other cases fail the same loud way: no `actions/checkout` ran, and
a non-pull-request event with no `snapshot-ref` set.

#### Permissions, and forks

```yaml
permissions:
  contents: read        # actions/checkout
  pull-requests: write  # upsert the sticky comment
```

Posting is the only thing that needs write access, and it is never load-bearing:
the exit code comes from the config diff and the policy result alone.

- **No `pull-requests: write`.** GitHub refuses the API call, Flecto warns on
  stderr, the job still passes or fails on the diff.
- **A pull request from a fork.** The `GITHUB_TOKEN` handed to a `pull_request`
  run from a fork is read-only unless the repository opted into write tokens for
  fork PRs, so posting is usually refused. The Action recognizes this before it
  runs and posts a workflow warning explaining why no comment will appear; the
  report is still printed in the job log in full. It does not fail, and it does
  not pre-emptively give up either, so a repository that has opted in still gets
  its comment.
- **An empty `github-token`.** Posting is disabled up front with a warning
  rather than attempted and refused.

A complete workflow is in
[`examples/github-action/flecto-pr-risk.yml`](../examples/github-action/flecto-pr-risk.yml),
and the Action itself is at
[`.github/actions/flecto-pr-risk/action.yml`](../.github/actions/flecto-pr-risk/action.yml).

### Pinning

Both Actions run `npx --yes flecto@3 ci`, so compatible updates are picked up
automatically. For fully reproducible builds, pin the Action reference to a
commit SHA; `flecto-pr-risk` also takes an exact CLI version through
`flecto-version`, so pinning it needs no fork.

---

## Other CI systems

`flecto ci` is a plain CLI with meaningful exit codes, so any runner works:

```yaml
# GitLab CI
config-check:
  image: node:22
  script:
    - npx --yes flecto@3 ci "config/**/*.yaml" --snapshot-ref "$CI_MERGE_REQUEST_DIFF_BASE_SHA" --fail-on "policy,error"
```

```bash
# Pre-commit hook (.git/hooks/pre-commit)
npx --yes flecto@3 ci "config/**/*.yaml" --snapshot-ref HEAD --fail-on "policy,error" || {
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

## Gating rendered Kubernetes manifests

The same `compare` shape gates a Helm or Kustomize change before `helm upgrade`
runs: render the base and the head to plain multi-document YAML, then diff the
two through the `kubernetes` policy pack.

```bash
helm template api ./charts/api -f values/prod.yaml > /tmp/head.yaml
flecto compare /tmp/base.yaml /tmp/head.yaml --policies kubernetes --fail-on error
```

Flecto never invokes `helm` or `kustomize` — neither binary is a dependency, and
neither is needed on the runner beyond whatever already renders your manifests.
The full workflow, the pack's rules, and its limits:
[kubernetes.md](kubernetes.md).

---

## Empty runs

If every target is missing or unsupported, `flecto ci` and
`flecto watch --snapshot` exit non-zero rather than reporting a clean pass. This
catches the common failure where a renamed directory quietly turns a config gate
into a no-op. Pass `--allow-empty` when an empty match is legitimately expected.
