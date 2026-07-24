<p align="center">
  <img src="docs/assets/flecto-hero.png" alt="Flecto — semantic config watcher" width="920"/>
</p>

<h1 align="center">Flecto</h1>

<p align="center">
  <strong>Config changes, in plain English — with risk flags built in.</strong><br/>
  Watch · Diff · Policy · CI · Webhooks
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/flecto"><img alt="npm" src="https://img.shields.io/npm/v/flecto?style=flat-square&color=34d399&labelColor=0b1220"/></a>
  <a href="https://github.com/myselfsiddharth/Flecto/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/myselfsiddharth/Flecto/ci.yml?branch=main&style=flat-square&label=CI&labelColor=0b1220"/></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-8fa3bf?style=flat-square&labelColor=0b1220"/></a>
  <a href="https://github.com/myselfsiddharth/Flecto/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/myselfsiddharth/Flecto?style=flat-square&color=fbbf24&labelColor=0b1220"/></a>
</p>

<p align="center">
  <a href="https://github.com/myselfsiddharth/Flecto/stargazers">⭐ Star this repo</a> if Flecto saves you from a noisy config diff — it helps others find the project.
</p>

<p align="center">
  <img src="docs/assets/flecto-demo.png" alt="Flecto watch demo in the terminal" width="920"/>
</p>

<p align="center">
  <img src="docs/assets/demo-watch.svg" alt="Animated Flecto watch output" width="920"/>
</p>

---

## Why teams use Flecto

Line diffs lie about config. Formatting churn, key reorders, and “small” YAML edits hide the changes that actually matter in production.

**Flecto** turns structured config into semantic events:

- What changed (`pool_size: 5 → 20`)
- What was added or removed
- What looks risky (secrets, dangerous toggles, pool jumps)
- What to do next (CI gate, webhook, shell command)

See the [changelog and migration notes](CHANGELOG.md) for release history and
upcoming v2.1 behavior changes.

> Diff tools compare trees. **Flecto watches, scores risk, and alerts.**

| Without Flecto | With Flecto |
|---|---|
| `+  40 lines of YAML noise` | `~ database.pool_size: 5 → 20` |
| Hope someone notices `debug: true` | Policy finding → CI fails |
| “Something in `.env` changed” | Exact keys + optional secret masking |

---

## Install

```bash
npm install -g flecto
```

Requires Node.js 20.19.0 or later.

```bash
flecto --version
flecto doctor
```

---

## Quick start

```bash
flecto watch config/prod.yaml
flecto watch .env
flecto watch settings.json
flecto watch pyproject.toml
flecto watch app.ini
```

That’s it — Flecto prints a clear summary on every meaningful change.

---

## Features at a glance

- **Semantic diffs** for JSON, YAML, TOML, INI, and dotenv (`.env`, `.env.*`, `*.env`)
- **Live watch** with optional command + webhook delivery
- **Policy packs** (`default`, `strict-prod`, `compose`, `node-runtime`) + custom `policies/*.json` + local ESM plugins
- **CI mode** with JSON / NDJSON / GitHub annotations and fail rules
- **Snapshots & diffs** for deploy scripts and pre-commit hooks
- **Profiles** via `--profile` or `FLECTO_PROFILE`
- **Default array identity** (`id` / `name`, or `--array-id-key`) and secret masking

---

## Common use cases

### Watch multiple files

```bash
flecto watch "config/**/*.yaml" ".env"
```

### Verbose before/after

```bash
flecto watch config/prod.yaml --mode verbose
```

### Ignore noisy keys

```bash
flecto watch config/prod.yaml --ignore "updated_at,meta.timestamp"
```

| Pattern | What it ignores |
|---|---|
| `meta.timestamp` | That exact key |
| `meta` | Everything under `meta.*` |
| `servers[*].meta.timestamp` | That key inside any array item |
| `**.updated_at` | Any key named `updated_at`, anywhere |

### Run a command on change

```bash
flecto watch .env --command "docker-compose restart app"
```

Changes are passed as JSON via `FLECTO_CHANGES` (large payloads may use `FLECTO_CHANGES_FILE`).

### Webhooks

```bash
flecto watch config/prod.yaml \
  --webhook https://hooks.example.com/notify \
  --webhook-header "Authorization: Bearer TOKEN"
```

Envelope shape (`schema_version: "2.0"`):

```json
{
  "schema_version": "2.0",
  "event_id": "uuid",
  "event_type": "changes",
  "emitted_at": "2026-04-14T10:42:31.000Z",
  "file": "/absolute/path/to/config/prod.yaml",
  "changes": [
    { "type": "changed", "path": "database.pool_size", "before": 5, "after": 20 }
  ],
  "policies": [
    {
      "id": "pool-size-jump",
      "severity": "warn",
      "path": "database.pool_size",
      "message": "Pool size increased from 5 to 20 (>=2x).",
      "pack": "default"
    }
  ]
}
```

JSON Schema: [`schemas/flecto-envelope-2.0.json`](schemas/flecto-envelope-2.0.json).

### Policy packs and profiles

```bash
flecto ci config/prod.yaml --profile prod --snapshot-ref HEAD~1
```

```json
{
  "defaults": {
    "policies": ["default"],
    "maskSecrets": false
  },
  "profiles": {
    "prod": {
      "policies": ["default", "strict-prod"],
      "severityRemap": { "pool-size-jump": "error" },
      "maskSecrets": true
    }
  }
}
```

Profile selection: `--profile` > `FLECTO_PROFILE` > defaults.  
Custom packs: `policies/<id>.json`. Plugins: local ESM exporting `evaluate(changes, ctx)`.

#### Declarative rule predicates

Rules combine their top-level predicates with AND. In addition to `when`, regex
`match.path`, `afterEquals`, and `numericJump`, packs can use:

- `beforeEquals`, `afterIn`, and `beforeIn` for exact values or allowed value lists.
- `beforeTruthy: true` and `afterTruthy: true` to require a truthy before/after value.
- `afterMatches` to require a string after value that matches a regular expression.
- `numericDelta: { "min": 10 }` to match an absolute numeric change of at least 10.
- `match.pathEquals` and `match.pathPrefix` for exact or prefix path matching without regex.
- `allOf` and `anyOf` arrays of simple match clauses. Every `allOf` clause and at least
  one `anyOf` clause must match. Clauses support the same value, truthiness, numeric, and
  `match` predicates, but cannot nest composition.

```json
{
  "id": "risky-feature-enable",
  "severity": "error",
  "allOf": [
    { "match": { "pathPrefix": "features." } },
    { "afterTruthy": true }
  ],
  "anyOf": [
    { "afterEquals": true },
    { "afterIn": ["unsafe", "disabled"] }
  ]
}
```

Pack loading fails closed for unknown rule or `match` fields, invalid regexes, and invalid
predicate shapes, so misspelled predicates cannot silently disable a rule.

Use `severityRemap` in defaults or a profile to change pack rule severities without forking a pack:

```json
{
  "profiles": {
    "dev": {
      "severityRemap": { "pool-size-jump": "off" }
    },
    "prod": {
      "severityRemap": { "pool-size-jump": "error" }
    }
  }
}
```

Each key is a rule id and each value must be `info`, `warn`, `error`, or `off`. The remap applies after all configured built-in and local packs load, before findings and CI `--fail-on` checks. When multiple packs provide the same rule id, the remap applies to every matching pack rule. Plugin findings are unchanged. Unknown rule ids print a warning instead of being ignored silently.

Authoring guides: [policy packs](docs/policy-packs.md) · [plugins](docs/plugins.md) · [plugin cookbook](docs/plugin-cookbook.md).

### Discover policy packs

```bash
flecto policies list
flecto policies list --json
```

The command lists every bundled and local pack that resolves from the current
working directory, including its source path and rule count. For a given pack
id, Flecto resolves local files before bundled packs in this order:
`policies/<id>.json`, `policies/<id>.yaml`, `policies/<id>.yml`, then the
built-in pack. A local pack with the same id overrides its built-in counterpart.

### Array identity matching

```bash
flecto watch config/services.yaml
```

Arrays of objects automatically match by a shared, unique `id` key, falling back
to `name` when `id` is unavailable. This avoids false changes when named items
are reordered. Use a custom identity field when needed:

```bash
flecto watch config/services.yaml --array-id-key serviceKey
```

To restore index-based diffs for every array, pass `--no-array-id`:

```bash
flecto watch config/services.yaml --no-array-id
```

In `.flectorc`, set `"arrayId": false` in `defaults` or a profile for the same
escape hatch.

### Command + webhook together

```bash
flecto watch .env \
  --command "make reload" \
  --webhook https://hooks.example.com/notify
```

### Retry on failure

```bash
flecto watch config/prod.yaml \
  --webhook https://hooks.example.com/notify \
  --delivery-mode at-least-once \
  --on-alert-failure retry
```

| Flag | Options | What it does |
|---|---|---|
| `--delivery-mode` | `best-effort` (default), `at-least-once` | Persist and retry failed webhook events |
| `--on-alert-failure` | `warn`, `exit`, `retry` | Behavior when command/webhook fails |

---

## Snapshots & diffs

```bash
flecto watch config/prod.yaml --snapshot
flecto watch config/prod.yaml --diff
flecto history config/prod.yaml --limit 10
```

Exit codes: `0` clean · `1` changes detected.

`flecto history` stays local: it lists recent snapshots from `.flecto-snapshots/` with their timestamps and semantic change counts from the previous snapshot. Counts use the same ignore paths, array identity, and order settings as `flecto watch --diff` (CLI flags or `.flectorc`). Omit files to view all saved snapshot history.

---

## CI mode

```bash
flecto ci "config/**/*.yaml" \
  --snapshot-ref HEAD~1 \
  --format github-annotations \
  --fail-on "changed,policy,error"
```

**Formats:** `json`, `ndjson`, `github-annotations`  
**Fail triggers:** `changed`, `added`, `removed`, `policy`, `error`, `warn`  
Unresolved `--snapshot-ref` fails closed (no silent empty baseline).  
If every target is missing or unsupported, `flecto ci` and `flecto watch --snapshot` exit non-zero (pass `--allow-empty` to opt out).

### GitHub Action

Use the [Flecto CI Action](.github/actions/flecto-ci/action.yml) to run `flecto ci` in a workflow with GitHub annotations enabled by default. A complete local-action workflow is available at [`examples/github-action/flecto-ci.yml`](examples/github-action/flecto-ci.yml).

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

`contents: read` is required by `actions/checkout`. The Action emits workflow-command annotations and needs no write permissions. Keep `fetch-depth: 2` (or use `fetch-depth: 0`) when using the default `HEAD~1` baseline.

| Input | Default | Description |
|---|---|---|
| `targets` | `config/**/*.{yaml,yml,json,toml,ini}` | Whitespace-separated paths or glob patterns to check |
| `fail-on` | `policy,error` | Comma-separated events that fail the job |
| `policies` | _(empty)_ | Comma-separated policy pack IDs; omit to use `.flectorc` / Flecto defaults |
| `profile` | _(empty)_ | Optional `.flectorc` profile |
| `format` | `github-annotations` | Flecto output format |
| `snapshot-ref` | `HEAD~1` | Git ref or snapshot file used as the baseline |
| `node-version` | `20` | Node.js version used to run Flecto |

The Action runs `npx --yes flecto@2 ci`: the major version is pinned so compatible Flecto updates are received. For fully reproducible builds, pin the Action reference to a commit SHA and replace `@2` in a forked Action with an exact published Flecto version.

---

## Built-in policy checks

Built-in pack ids:

- `default` — secrets, dangerous toggles, and pool-size jumps.
- `strict-prod` — stricter severities and matching for production use.
- `compose` — privileged services, host networking, Docker socket mounts, and sensitive host-directory bind mounts.
- `node-runtime` — removed Node.js engine requirements, TLS verification bypasses, and enabled Node debugging or inspector options.

Fail CI with `--fail-on policy`.

---

## Migrating from envelope 1.1

- `schema_version` is now `"2.0"`
- Type name is `FlectoEnvelope` (docs/types)
- New `policies` array on change envelopes
- Webhook headers unchanged (`X-Flecto-*`)

---

## Tuning for network drives / odd editors

```bash
flecto watch config/prod.yaml --polling --interval 500
```

Polling is off by default (interval default `100ms` when enabled).

---

## Config file (`.flectorc`)

```bash
flecto init
```

Looks for `.flectorc`, `.flectorc.json`, `.flectorc.yaml`, or `.flectorc.yml`.

```json
{
  "defaults": {
    "mode": "compact",
    "interval": 100,
    "ignore": ["**.updated_at"],
    "deliveryMode": "best-effort",
    "onAlertFailure": "warn",
    "policies": ["default"],
    "arrayId": true
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
  "files": ["config/**/*.{yaml,yml,json,toml,ini}", ".env", ".env.*", "*.env"],
  "exclude": ["**/node_modules/**"]
}
```

```bash
flecto watch --profile dev
flecto ci --profile ci
flecto doctor
```

CLI flags override profile/default values.

---

## Output format reference

### Compact (default)

```
[HH:MM:SS] <filepath> — N changes
  ~ path: before → after     (yellow — value changed)
  + path: value              (green  — key added)
  - path: value              (red    — key removed)
```

### Verbose (`--mode verbose`)

```
[HH:MM:SS] <filepath> — N changes
  ~ path
    before: old_value
    after:  new_value
```

---

## Error handling

| Situation | Behavior |
|---|---|
| File not found | Error + exit 1 |
| Unsupported format | Lists supported extensions + exit 1 |
| Parse error while watching | Warning, last valid state kept |
| Command / webhook fails | Warning (unless `--on-alert-failure exit`) |
| Ctrl+C | Clean shutdown |

---

## How it works

1. **Parser** — format by extension / dotenv naming → structured values  
2. **Watcher** — [chokidar](https://github.com/paulmillr/chokidar) + debounce  
3. **Differ** — semantic tree diff (objects, arrays, ignore rules, automatic array ids)
4. **Policy engine** — packs + plugins → severity findings  
5. **Envelope** — versioned automation payload (`2.0`)  
6. **Alerter** — command and/or webhook with retry modes  

---

## Contributing

Flecto is open source. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, PR rules, and review expectations.  
Please read the [Code of Conduct](CODE_OF_CONDUCT.md) and [Security policy](SECURITY.md).

Roadmap lives in [GitHub milestones](https://github.com/myselfsiddharth/Flecto/milestones).

---

## Star the project

If Flecto helps your team catch a risky config change — **[star the repo](https://github.com/myselfsiddharth/Flecto)** so more people can find it.

---

## License

MIT — see [LICENSE](./LICENSE).
