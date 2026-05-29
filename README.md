# Flecto

A semantic file watcher that detects *meaningful* changes in structured config files and reports them in plain English — not raw line diffs.

```
[10:42:31] config/prod.yaml — 3 changes
  ~ database.pool_size: 5 → 20
  + feature_flags.dark_mode: true
  - deprecated.old_key
```

Supports **JSON**, **YAML**, **TOML**, and **ENV** files.

Recruiter-focused overview: see `README_RECRUITERS.md`.

---

## Install

```bash
npm install -g flecto
```

Or from source:

```bash
git clone https://github.com/siddharrth2005/sentinel.git
cd sentinel
npm install
npm install -g .
```

After install, `flecto` is available globally.

---

## Usage

### Watch a file

```bash
flecto watch config/prod.yaml
flecto watch .env
flecto watch settings.json
flecto watch pyproject.toml
```

### Watch multiple files/globs

```bash
flecto watch "config/**/*.yaml" ".env"
```

### Watch with verbose output

```bash
flecto watch config/prod.yaml --mode verbose
```

Verbose mode shows before/after values on separate lines and adds a blank line between change events.

### Ignore specific key paths

```bash
flecto watch config/prod.yaml --ignore "updated_at,meta.timestamp"
```

Comma-separated paths. Supports:
- exact path ignore: `meta.timestamp`
- subtree ignore: `meta` (ignores `meta.*` and `meta[0].*`)
- wildcard segment: `servers[*].meta.timestamp`
- key anywhere: `**.updated_at`

### Run a shell command on every change

```bash
flecto watch .env --command "docker-compose restart app"
```

Changes are passed to the command as JSON in the `FLECTO_CHANGES` environment variable, and the watched file path in `FLECTO_FILE`.

If the change payload is too large for env vars, Flecto writes it to `FLECTO_CHANGES_FILE` and sets `FLECTO_CHANGES` to `[]`.

### POST changes to a webhook

```bash
flecto watch config/prod.yaml --webhook https://hooks.example.com/notify
```

Add custom headers (repeatable):

```bash
flecto watch config/prod.yaml \
  --webhook https://hooks.example.com/notify \
  --webhook-header "Authorization: Bearer TOKEN"
```

Flecto webhook payloads include an event envelope with:
- `schema_version`
- `event_id`
- `batch_id`
- `event_type` (`changes` or `lifecycle`)
- `source`
- `emitted_at`
- `file`
- `changes`

Payload shape:
```json
{
  "schema_version": "1.1",
  "event_id": "uuid",
  "batch_id": "uuid",
  "event_type": "changes",
  "source": "watch",
  "emitted_at": "2026-04-14T10:42:31.000Z",
  "file": "/absolute/path/to/config/prod.yaml",
  "changes": [
    { "type": "changed", "path": "database.pool_size", "before": 5, "after": 20 }
  ]
}
```

### Combine command + webhook

Both can be active at the same time:

```bash
flecto watch .env \
  --command "make reload" \
  --webhook https://hooks.example.com/notify
```

### Delivery semantics and failure policy

```bash
flecto watch config/prod.yaml \
  --webhook https://hooks.example.com/notify \
  --delivery-mode at-least-once \
  --on-alert-failure retry
```

- `--delivery-mode best-effort` (default): no persistent retries
- `--delivery-mode at-least-once`: failed webhook events are persisted and retried
- `--on-alert-failure warn|exit|retry`: controls behavior when command/webhook fails

### Polling interval

For network drives or editors that write via temp files, tune the polling interval:

```bash
flecto watch config/prod.yaml --polling --interval 500
```

Default polling interval is `100ms` (polling is **off** unless you pass `--polling`).

---

## CI mode

Run semantic diffs in CI against snapshots or git refs:

```bash
flecto ci "config/**/*.yaml" \
  --snapshot-ref HEAD~1 \
  --format github-annotations \
  --fail-on "changed,policy,error"
```

`--format` supports:
- `json`
- `ndjson`
- `github-annotations`

`--fail-on` supports:
- `changed`
- `added`
- `removed`
- `policy`
- `error`
- `warn`

---

## Snapshot & diff mode

### Save a baseline snapshot

```bash
flecto watch config/prod.yaml --snapshot
# → .flecto-snapshots/<id>.json
```

### Diff the current file against the saved snapshot

```bash
flecto watch config/prod.yaml --diff
```

Prints all changes since the snapshot was taken. Exits with:
- **code 0** — file is clean (no changes)
- **code 1** — changes detected (useful in CI pipelines)

---

## Output format

### Compact (default)

```
[HH:MM:SS] <filepath> — N changes
  ~ <path>: <before> → <after>
  + <path>: <value>
  - <path>: <value>
```

- `~` (yellow) — value changed
- `+` (green)  — key added
- `-` (red)    — key removed

### Verbose (`--mode verbose`)

```
[HH:MM:SS] <filepath> — N changes
  ~ <path>
    before: <value>
    after:  <value>
  + <path>: <value>
    (key added)

```

---

## Change event shape

Each semantic change is represented as:

```ts
{
  type: 'added' | 'removed' | 'changed',
  path: string,      // dot-notation key path, e.g. "database.pool_size"
  before?: unknown,  // previous value (absent for 'added')
  after?: unknown,   // new value (absent for 'removed')
  note?: string,     // optional note, e.g. "type changed from string to number"
}
```

Array items use index notation: `servers[1].port`.

---

## Policy checks

Built-in policy findings are evaluated from semantic changes:
- secret-looking keys changed (`secret`, `token`, `password`, `api_key`, etc.)
- dangerous toggles enabled (`debug`, `allow_insecure`, `disable_tls`, `skip_tls_verify`)
- large `pool_size` jumps (>=2x)

Policy findings can trigger CI failures with `--fail-on policy,error`.

---

## Error handling

| Situation | Behavior |
|---|---|
| File not found | Error message + exit 1 |
| Unsupported format | Lists supported extensions + exit 1 |
| Parse error during watch | Warning shown, last valid state kept, watching continues |
| Command failure | Warning shown, watcher continues |
| Webhook failure | Warning shown, watcher continues |
| Ctrl+C | Clean shutdown message |

---

## .flectorc configuration

Use `.flectorc`, `.flectorc.json`, `.flectorc.yaml`, or `.flectorc.yml`.
Bootstrap one with:

```bash
flecto init
```

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

CLI flags take precedence over profile/default values.

Use a profile with:

```bash
flecto watch --profile dev
flecto ci --profile ci
```

Check setup with:

```bash
flecto doctor
```

---

## Running tests

```bash
npm test
# or directly:
node --test test/*.test.js
```

Tests cover differ, watcher behavior, alert webhook delivery, policy logic, and CI command behavior.

---

## How it works

1. **Parser** — detects format by file extension and parses the file into JS values.
2. **Watcher** — uses [chokidar](https://github.com/paulmillr/chokidar) with debouncing and lifecycle events.
3. **Differ** — computes semantic changes (supports object/array/scalar roots, ignore rules).
4. **Policy engine** — derives severity findings from change patterns.
5. **Envelope** — wraps change batches in a versioned automation event schema.
6. **Alerter** — runs commands and/or webhook delivery with configurable retry semantics.
