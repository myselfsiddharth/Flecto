<p align="center">
  <img src="docs/assets/flecto-hero.png" alt="Flecto — semantic config watcher" width="920"/>
</p>

<h1 align="center">Flecto</h1>

<p align="center">
  <strong>Know what your config actually changed — and whether it's risky.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/flecto"><img alt="npm" src="https://img.shields.io/npm/v/flecto?style=flat-square&color=34d399&labelColor=0b1220"/></a>
  <a href="https://github.com/myselfsiddharth/Flecto/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/myselfsiddharth/Flecto/ci.yml?branch=main&style=flat-square&label=CI&labelColor=0b1220"/></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-8fa3bf?style=flat-square&labelColor=0b1220"/></a>
  <a href="#documentation"><img alt="Docs" src="https://img.shields.io/badge/docs-read-34d399?style=flat-square&labelColor=0b1220"/></a>
</p>

<p align="center">
  <img src="docs/assets/demo-watch.svg" alt="Flecto reporting semantic config changes in the terminal" width="920"/>
</p>

---

Config drives the parts of a system that break loudest: connection pools, feature
flags, TLS, retries, secrets. But we still review it as text — so a reordered key
looks identical to a doubled pool size, and `debug: true` slips through in a
40-line formatting diff.

Flecto reads config as structure, not lines. It tells you what changed in plain
English, flags what looks risky, and gives you an exit code to gate on.

| Reviewing config without Flecto | With Flecto |
|---|---|
| `+ 40 lines of YAML noise` | `~ database.pool_size: 5 → 20` |
| Hope someone notices `debug: true` | Policy finding → build fails |
| "Something in `.env` changed" | The exact keys, with secrets masked |

The same engine reads whatever your change actually lives in:

| You are reviewing | Flecto reads |
|---|---|
| App config — YAML, JSON, TOML, INI, dotenv | the files directly |
| A Terraform change | `terraform show -json` output, via `flecto plan` |
| A Kubernetes change | rendered manifests from `helm`, `kustomize`, or anything else |
| A SOPS-encrypted file | its structure and recipients — **never its plaintext** |

It never invokes `terraform`, `helm`, `kustomize`, `sops`, or `age`, so nothing
extra has to exist on the CI runner.

---

## Install

```bash
npm install -g flecto
```

Requires **Node.js 20.19.0+**. Verify:

```bash
flecto --version
flecto doctor
```

Prefer not to install globally? Every example below works with
`npx --yes flecto@3` instead of `flecto`.

---

## Quick start

A complete walkthrough, start to finish. Copy-paste it anywhere.

**1. Create a config file to track.**

```bash
mkdir flecto-demo && cd flecto-demo && mkdir config
cat > config/prod.yaml <<'EOF'
database:
  host: db.internal
  pool_size: 5
  ssl: true
logging:
  level: info
  debug: false
EOF
```

**2. Save it as your baseline.**

```bash
flecto watch config/prod.yaml --snapshot
```

```
✓ Snapshot saved: /path/to/flecto-demo/.flecto-snapshots/4b8cbbd70d1832a2.json
```

**3. Make the kind of edit that causes incidents.**

```bash
cat > config/prod.yaml <<'EOF'
database:
  host: db.internal
  pool_size: 20
  ssl: true
logging:
  level: info
  debug: true
EOF
```

**4. Ask what changed.**

```bash
flecto watch config/prod.yaml --diff
```

```
/path/to/flecto-demo/config/prod.yaml — 2 changes from snapshot:
  ~ database.pool_size: 5 → 20
  ~ logging.debug: false → true
```

Two sentences instead of a diff you have to interpret. Now let Flecto judge it:

```bash
flecto ci config/prod.yaml --format github-annotations
```

```
::warning title=flecto changed::database.pool_size
::warning title=flecto changed::logging.debug
::warning title=flecto policy pool-size-jump [default]::database.pool_size: Pool size increased from 5 to 20 (>=2x).
::error title=flecto policy dangerous-toggle-enabled [default]::logging.debug: Potentially dangerous toggle enabled.
```

Exit code `1`. In CI, that's a failed build — before the change ships.

**5. Watch it live.** Leave this running and edit the file in another window:

```bash
flecto watch config/prod.yaml
```

```
flecto watching /path/to/flecto-demo/config/prod.yaml
Press Ctrl+C to stop.

[18:24:48] /path/to/flecto-demo/config/prod.yaml — 2 changes
  ~ database.pool_size: 5 → 20
  ~ logging.debug: false → true
  ! policy(warn) [default] database.pool_size: Pool size increased from 5 to 20 (>=2x).
  ! policy(error) [default] logging.debug: Potentially dangerous toggle enabled.
```

That's the whole product. Everything below is depth.

---

## What you can do with it

### Catch risky changes before they merge

Add one step to your workflow and risky config edits show up as annotations on
the pull request:

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

Prefer a summary nobody can miss? `--format pr-comment` renders the changes and
policy findings as markdown and, when you opt in with `--pr-comment-post` inside
a GitHub PR run, keeps **one** sticky comment up to date instead of adding a new
one per push. Without that flag it just prints the markdown, so it can't post
from your laptop.

The `flecto-pr-risk` Action is that, packaged — the whole adoption is one
`uses:`, with the baseline resolved from the pull request rather than `HEAD~1`:

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

A fork's pull request gets a read-only token, so the comment is skipped with a
warning there — the check itself still runs and still fails on risky changes.

Works on any CI runner — it's a plain CLI with meaningful exit codes.
→ **[CI guide](docs/ci.md)**

### Trigger automation on change

Restart a service, reload a process, or notify an endpoint whenever config moves:

```bash
flecto watch .env --command "docker-compose restart app"

flecto watch config/prod.yaml \
  --webhook https://hooks.example.com/notify \
  --delivery-mode at-least-once
```

Changes arrive as a versioned JSON envelope, and `at-least-once` persists and
retries failed deliveries.

Posting straight to chat needs no receiver of your own — `--webhook-format`
shapes the body for Slack, Discord, or Teams, colored by the highest policy
severity:

```bash
flecto watch config/prod.yaml \
  --webhook "https://hooks.slack.com/services/T000/B000/XXXX" \
  --webhook-format slack
```

→ **[Webhooks and commands](docs/webhooks.md)**

### Compare two environments

"Works in staging, fails in prod" is usually one key apart:

```bash
flecto compare config/prod.yaml config/staging.yaml
```

```
"+" exists only in the compared file, "-" only in the baseline, "~" differs
/path/to/config/staging.yaml — 2 changes from /path/to/config/prod.yaml:
  - only_in_prod: true
  ~ database.pool_size: 5 → 20
  ! policy(warn) [default] database.pool_size: Pool size increased from 5 to 20 (>=2x).
```

The first file is the baseline, the files don't have to share a format, and
`--format json` gives you the same output `flecto ci` produces.
→ **[CLI reference](docs/cli-reference.md#flecto-compare-filea-fileb)**

### Track drift over time

```bash
flecto history config/prod.yaml --limit 10
```

Snapshots stay on your machine in `.flecto-snapshots/`. Nothing is uploaded and
no account is required. → **[CLI reference](docs/cli-reference.md#flecto-history-files)**

### Share what changed before the incident

```bash
flecto report --limit 20 --mask-secrets --output drift.html
```

One HTML file from that same local history: a timeline per file, every change
with its UTC timestamp, and policy findings grouped by severity. Fully
self-contained — inline styles, no fonts, no CDN scripts, no analytics — so you
can attach it to an incident thread and it renders offline. No server and no
account, same as everything else here.
→ **[CLI reference](docs/cli-reference.md#flecto-report-files)**

### Review a Kubernetes change before it reaches a cluster

ArgoCD, Flux, and `helm diff` compare the cluster to the repo — which needs a
cluster, and an apply that already happened. Flecto compares the manifests *this
pull request would produce* against the ones `main` produces:

```bash
helm template api ./charts/api -f values/prod.yaml > /tmp/head.yaml
flecto compare /tmp/base.yaml /tmp/head.yaml --policies kubernetes --fail-on error
```

```
~ Service/prod/api.spec.type: "ClusterIP" → "LoadBalancer"
  ! policy(error) [kubernetes] Service type is LoadBalancer, which exposes the
    workload outside the cluster. Confirm the exposure is intended.
```

Multi-document YAML is keyed by `kind/namespace/name`, so findings name the
resource. Flecto never runs `helm` or `kustomize` — you render, it diffs, so any
renderer works and no binary is needed in CI.
→ **[Kubernetes](docs/kubernetes.md)**

### Read a Terraform plan in plain English

`terraform plan` output is precise and long. Flecto turns it into the handful of
lines a reviewer actually needs to argue about:

```bash
terraform show -json plan.tfplan > plan.json
flecto plan plan.json --fail-on error
```

```
plan.json — plan format 1.2
Plan: 0 to add, 1 to change, 0 to destroy, 1 to replace.
  ~ aws_security_group.web.ingress[0].cidr_blocks[0]: "10.0.0.0/8" → "0.0.0.0/0"
  - aws_db_instance.main.#action: "replace" [terraform will destroy and recreate aws_db_instance.main]
  ~ aws_db_instance.main.password: "(sensitive value)" → "(sensitive value)" [sensitive]
  ! policy(error) [terraform] …cidr_blocks[0]: Security group ingress will accept
    traffic from the whole internet (0.0.0.0/0). Restrict the source to a known CIDR…
  ! policy(error) [terraform] …#action: Terraform will destroy a stateful resource.
    Its data does not survive. Take a final snapshot, or add a prevent_destroy…
```

A **replace reads as a removal**, not a benign update — a recreated database
should never look like a config tweak. Values Terraform marks sensitive are
redacted during parsing, before the policy engine or any formatter sees them, and
`after_unknown` renders as `(known after apply)` rather than `null`.

**Flecto never runs `terraform`** — you produce the JSON, it reads it, so nothing
extra has to exist on the CI runner.
→ **[Terraform plans](docs/terraform.md)**

### Encode your own rules

Beyond the built-in packs, write rules as declarative JSON or YAML — no code:

```json
{
  "id": "risky-feature-enable",
  "severity": "error",
  "allOf": [
    { "match": { "pathPrefix": "features." } },
    { "afterTruthy": true }
  ]
}
```

For anything a predicate can't express, a local ESM plugin exporting
`evaluate(changes, ctx)` gets the full change set.
→ **[Writing policy packs](docs/policy-packs.md)** · **[Plugins](docs/plugins.md)**

### Cut the noise

```bash
flecto watch config/prod.yaml --ignore "updated_at,**.meta.timestamp"
```

Arrays of objects are matched by `id` or `name`, so reordering a list of named
services doesn't read as a wall of changes.
→ **[Configuration](docs/configuration.md)**

---

## Built-in policy packs

| Pack | Catches |
|---|---|
| `default` | Secret-like keys added or changed, secret-shaped *values* under any key, dangerous toggles, pool-size jumps |
| `strict-prod` | The same ground, with production-grade severities and matching |
| `compose` | Privileged services, host networking, Docker socket mounts, sensitive bind mounts |
| `kubernetes` | Privileged containers, host namespaces, weakened `runAsNonRoot`, added `SYS_ADMIN`, unpinned images, replica jumps, dropped limits, `LoadBalancer`/`NodePort` exposure |
| `node-runtime` | Dropped engine requirements, TLS verification bypasses, debug/inspector flags |
| `terraform` | Replaced and destroyed stateful resources, ingress opened to `0.0.0.0/0`, IAM wildcards, public S3, capacity jumps |
| `sops` | Decryption recipients added or removed, a MAC that moved on its own, a file that stopped being encrypted |

```bash
flecto policies list          # see what resolves here, built-in and local
flecto ci "config/**/*.yaml" --policies "default,strict-prod" --fail-on policy
```

Pass files or glob patterns, quoted so your shell doesn't expand them first — a
bare directory is not a valid target.

A local `policies/<id>.json` overrides the built-in pack of the same id, and
`severityRemap` raises or silences individual rules per profile without forking
anything. → **[Policy packs](docs/policy-packs.md)**

Community packs ship on npm as `flecto-pack-<id>` packages — a package name and
one declarative JSON file, nothing else:

```bash
npm install --save-dev flecto-pack-deployment-safety
flecto policies add deployment-safety
```

`policies add` validates the pack, writes it to `policies/deployment-safety.json`,
and runs no code from the package. →
**[Installing community packs](docs/policy-packs.md#installing-a-community-pack)**

---

## Supported formats

| Format | Extensions |
|---|---|
| JSON / JSONC | `.json`, `.jsonc` |
| YAML | `.yaml`, `.yml` |
| TOML | `.toml` |
| INI | `.ini` |
| dotenv | `.env`, `.env.*`, `*.env` |
| age (armored) | `.age`, or any file whose contents are one armored blob |

`.json` accepts comments and trailing commas, so `tsconfig.json`,
`.vscode/settings.json`, `jsconfig.json`, and `devcontainer.json` are read as
written. →
**[JSON with comments](docs/configuration.md#json-with-comments)**

Terraform plan JSON (`terraform show -json`) is read by **`flecto plan`**, which
applies Terraform's own sensitivity marking. Point `plan` at it rather than `ci`
or `watch` — those treat it as ordinary JSON and will print values Terraform
marks sensitive ([#113](https://github.com/myselfsiddharth/Flecto/issues/113)).

Multi-document YAML (`---`-separated, the usual shape of a Kubernetes manifest)
is supported. Each document is diffed under its own key — `kind/name` for
Kubernetes-shaped documents, so a document inserted at the top of the file does
not renumber every other path. →
**[Multi-document YAML](docs/configuration.md#multi-document-yaml)**

---

## Encrypted files

A `sops`- or age-encrypted file is detected from its **contents**, and diffed
structurally:

```
  + cache: {"ttl_seconds":300}
  ~ database.password: <encrypted value changed>
  + sops.age.age1exampleexample…: {"recipient":"age1exampleexample…","enc":"<encrypted value>"}
```

You get keys added and removed, which encrypted values moved, and — the useful
part — who can decrypt the file. A recipient added is a genuine security event
and the `sops` pack raises it as one.

**Flecto never decrypts.** It never shells out to `sops` or `age`, never reads a
key file or agent socket, and never prints ciphertext — not even without
`--mask-secrets`. Ciphertext is replaced with an opaque sentinel in the parser,
so no diff, snapshot, webhook, or report can carry it. →
**[Encrypted files](docs/encrypted-files.md)**

---

## Configuration

Most teams commit a `.flectorc` so local runs and CI agree:

```bash
flecto init
```

```json
{
  "defaults": {
    "policies": ["default"],
    "ignore": ["**.updated_at"]
  },
  "profiles": {
    "dev": { "mode": "verbose" },
    "ci": { "failOn": "policy,error" },
    "prod": {
      "policies": ["default", "strict-prod"],
      "severityRemap": { "pool-size-jump": "error" },
      "maskSecrets": true
    }
  },
  "files": ["config/**/*.{yaml,yml,json,toml,ini}", ".env"]
}
```

```bash
flecto watch --profile dev
flecto ci --profile ci
```

Explicit CLI flags win over profiles, which win over `defaults`.
→ **[Full configuration reference](docs/configuration.md)**

---

## Commands

| Command | What it does |
|---|---|
| `flecto watch [files...]` | Watch for changes and print them as they happen |
| `flecto watch --snapshot` | Save the current state as a baseline |
| `flecto watch --diff` | Compare against the baseline and exit |
| `flecto ci [files...]` | One-shot check with a gate-able exit code |
| `flecto compare <fileA> <fileB>` | Diff two files against each other (`fileA` is the baseline) |
| `flecto plan <planFiles...>` | Review `terraform show -json` output and gate on it |
| `flecto history [files...]` | Summarize drift across local snapshots |
| `flecto report [files...]` | Render that history as a self-contained HTML file |
| `flecto policies add <name>` | Install a pack from an `flecto-pack-*` npm package |
| `flecto policies list` | List available policy packs |
| `flecto policies test <dir>` | Assert pack and plugin findings from fixtures |
| `flecto init` | Create a `.flectorc` from detected stack signals |
| `flecto doctor` | Check setup, config, and environment |

→ **[Every flag, every command](docs/cli-reference.md)**

---

## Documentation

| Guide | Covers |
|---|---|
| **[CLI reference](docs/cli-reference.md)** | Every command, flag, and exit code |
| **[Configuration](docs/configuration.md)** | `.flectorc`, profiles, ignore patterns, array identity, masking |
| **[Encrypted files](docs/encrypted-files.md)** | SOPS and age: what is detected, what is reported, why nothing is decrypted |
| **[CI](docs/ci.md)** | Baselines, fail triggers, output formats, the bundled GitHub Actions |
| **[Kubernetes](docs/kubernetes.md)** | Diffing rendered Helm/Kustomize manifests before they reach a cluster |
| **[Terraform plans](docs/terraform.md)** | Reviewing `terraform show -json` output and the `terraform` pack |
| **[Webhooks and commands](docs/webhooks.md)** | Envelope shape, delivery modes, command environment |
| **[Policy packs](docs/policy-packs.md)** | Writing declarative rules |
| **[Plugins](docs/plugins.md)** · **[Cookbook](docs/plugin-cookbook.md)** | Rules that need real code |
| **[Troubleshooting](docs/troubleshooting.md)** | When something doesn't behave |
| **[Changelog](CHANGELOG.md)** | Release history and migration notes |

---

## How it works

1. **Parse** — format detected by extension or dotenv naming → structured values
2. **Watch** — [chokidar](https://github.com/paulmillr/chokidar) with debounce
3. **Diff** — semantic tree comparison with ignore rules and array identity
4. **Evaluate** — policy packs and plugins → severity-tagged findings
5. **Emit** — a versioned envelope (`schema_version: "2.0"`)
6. **Deliver** — terminal output, shell command, webhook, or CI annotations

Flecto runs entirely on your machine. Snapshots are local files, and nothing
leaves the process unless you configure a webhook or command.

---

## Project

- **Questions and ideas** — [Discussions](https://github.com/myselfsiddharth/Flecto/discussions)
- **Bugs and requests** — [Issues](https://github.com/myselfsiddharth/Flecto/issues)
- **Contributing** — [CONTRIBUTING.md](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md)
- **Security** — [SECURITY.md](SECURITY.md), private disclosure only
- **Roadmap** — [Milestones](https://github.com/myselfsiddharth/Flecto/milestones)

Released under the [MIT License](LICENSE).
