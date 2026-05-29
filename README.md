# Flecto

**Flecto watches your config files and tells you exactly what changed — in plain English.**

No more staring at raw line diffs. When your `.env`, `YAML`, `JSON`, or `TOML` file changes, Flecto shows you what actually happened:

```
[10:42:31] config/prod.yaml — 3 changes
  ~ database.pool_size: 5 → 20
  + feature_flags.dark_mode: true
  - deprecated.old_key
```

---

## Why Flecto?

Standard file watchers tell you *a file changed*. Flecto tells you *what* changed and *why it might matter* — flagging secrets, dangerous toggles, and risky config jumps automatically.

---

## Install

```bash
npm install -g flecto
```

After that, `flecto` is available globally from anywhere.

---

## Quick Start

Watch any config file:

```bash
flecto watch config/prod.yaml
flecto watch .env
flecto watch settings.json
flecto watch pyproject.toml
```

That's it. Flecto starts watching and prints a clear summary every time something changes.

---

## Common Use Cases

### Watch multiple files at once

```bash
flecto watch "config/**/*.yaml" ".env"
```

### See detailed before/after values

```bash
flecto watch config/prod.yaml --mode verbose
```

### Ignore noisy keys (like timestamps)

```bash
flecto watch config/prod.yaml --ignore "updated_at,meta.timestamp"
```

You can ignore exact keys, entire subtrees, wildcards, or keys anywhere in the file:

| Pattern | What it ignores |
|---|---|
| `meta.timestamp` | That exact key |
| `meta` | Everything under `meta.*` |
| `servers[*].meta.timestamp` | That key inside any array item |
| `**.updated_at` | Any key named `updated_at`, anywhere |

### Run a command when something changes

```bash
flecto watch .env --command "docker-compose restart app"
```

Flecto passes the changes as JSON to your command via the `FLECTO_CHANGES` environment variable.

### Send changes to a webhook

```bash
flecto watch config/prod.yaml --webhook https://hooks.example.com/notify
```

Add auth headers if needed:

```bash
flecto watch config/prod.yaml \
  --webhook https://hooks.example.com/notify \
  --webhook-header "Authorization: Bearer TOKEN"
```

Each webhook payload includes a full event envelope:

```json
{
  "schema_version": "1.1",
  "event_id": "uuid",
  "event_type": "changes",
  "emitted_at": "2026-04-14T10:42:31.000Z",
  "file": "/absolute/path/to/config/prod.yaml",
  "changes": [
    { "type": "changed", "path": "database.pool_size", "before": 5, "after": 20 }
  ]
}
```

### Use both command and webhook together

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
| `--delivery-mode` | `best-effort` (default), `at-least-once` | Whether to persist and retry failed webhook events |
| `--on-alert-failure` | `warn`, `exit`, `retry` | What happens if a command or webhook fails |

---

## Snapshots & Diffs

Save a baseline snapshot of your file:

```bash
flecto watch config/prod.yaml --snapshot
# Saved to .flecto-snapshots/<id>.json
```

Then compare the current file against it anytime:

```bash
flecto watch config/prod.yaml --diff
```

Exit codes:
- `0` — no changes (file is clean)
- `1` — changes detected

This is useful in deployment scripts and pre-commit hooks.

---

## CI Mode

Catch risky config changes before they ship:

```bash
flecto ci "config/**/*.yaml" \
  --snapshot-ref HEAD~1 \
  --format github-annotations \
  --fail-on "changed,policy,error"
```

**Output formats:** `json`, `ndjson`, `github-annotations`

**Fail triggers:** `changed`, `added`, `removed`, `policy`, `error`, `warn`

---

## Built-in Policy Checks

Flecto automatically flags changes that look risky:

- 🔑 **Secrets touched** — keys named `secret`, `token`, `password`, `api_key`, etc.
- ⚠️ **Dangerous toggles** — `debug: true`, `disable_tls`, `skip_tls_verify`, `allow_insecure`
- 📈 **Large pool size jumps** — `pool_size` doubled or more

Policy violations can fail your CI pipeline with `--fail-on policy`.

---

## Tuning for Network Drives or Odd Editors

Some editors write files via a temp file swap, which can confuse standard watchers. Enable polling mode:

```bash
flecto watch config/prod.yaml --polling --interval 500
```

Default polling interval is `100ms`. Polling is off by default.

---

## Config File (.flectorc)

Set your defaults once so you don't have to repeat flags every time.

Generate a starter config:

```bash
flecto init
```

Flecto looks for `.flectorc`, `.flectorc.json`, `.flectorc.yaml`, or `.flectorc.yml`.

Example:

```json
{
  "defaults": {
    "mode": "compact",
    "interval": 100,
    "ignore": ["**.updated_at"],
    "deliveryMode": "best-effort",
    "onAlertFailure": "warn"
  },
  "profiles": {
    "dev": { "mode": "verbose" },
    "ci": { "failOn": "policy,error" }
  },
  "files": ["config/**/*.yaml", ".env"],
  "exclude": ["**/node_modules/**"]
}
```

Use a named profile:

```bash
flecto watch --profile dev
flecto ci --profile ci
```

CLI flags always override profile/default values.

Verify your setup:

```bash
flecto doctor
```

---

## Output Format Reference

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
  + path: value
    (key added)
```

---

## Error Handling

Flecto is designed to keep running even when things go wrong:

| Situation | Behavior |
|---|---|
| File not found | Error message + exit 1 |
| Unsupported file format | Lists supported extensions + exit 1 |
| File has a parse error | Warning shown, last valid state kept, watching continues |
| Command fails | Warning shown, watcher continues |
| Webhook fails | Warning shown, watcher continues |
| Ctrl+C | Clean shutdown message |

---

## Running Tests

```bash
npm test
# or directly:
node --test test/*.test.js
```

Tests cover the differ, watcher behavior, webhook delivery, policy logic, and CI command behavior.

---

## How It Works

1. **Parser** — detects the file format by extension and parses it into structured JS values.
2. **Watcher** — uses [chokidar](https://github.com/paulmillr/chokidar) with debouncing so rapid saves don't flood you with events.
3. **Differ** — computes a semantic diff (not a line diff), supporting objects, arrays, scalars, and ignore rules.
4. **Policy engine** — inspects the changes for patterns that look risky and adds severity findings.
5. **Envelope** — wraps each batch of changes in a versioned event schema ready for automation.
6. **Alerter** — delivers events via command execution and/or webhook, with configurable retry logic.

---

## License

MIT — see [LICENSE](./LICENSE).
