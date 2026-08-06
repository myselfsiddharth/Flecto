# Configuration

Everything Flecto reads from `.flectorc`, plus the pattern syntax used by
`--ignore` and array identity matching.

---

## Creating a config file

```bash
flecto init
```

Flecto looks for `.flectorc`, `.flectorc.json`, `.flectorc.yaml`, or
`.flectorc.yml` in the working directory. `flecto init` writes
`.flectorc.json` and **never overwrites** an existing config — if any of the four
names is already there, it is reported and left untouched.

`init` reads the signals already present in the directory and pre-selects the
policy packs and file patterns that match, printing what it found and why:

| Detected | Effect |
|---|---|
| `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, `compose.yaml` | Enables the [`compose`](policy-packs.md) pack and watches the compose file |
| `package.json` | Enables the `node-runtime` pack and watches `package.json` |
| `config/` | Adds `config/**/*.{yaml,yml,json,toml,ini}` to `files` |
| `.env`, `.env.*`, `*.env` | Adds `.env`, `.env.*`, `*.env` to `files` |
| `*.tf` | Reported only — no `terraform` pack ships yet, and `.tf` is not a parseable format, so nothing is enabled |

Detected packs also land in the `prod` profile, alongside `strict-prod`. Only
built-in pack ids and formats Flecto can parse are ever written, so the generated
config always loads.

```console
$ flecto init
Initialized config: /srv/app/.flectorc.json
Detected docker-compose.yml → enabled the `compose` policy pack and watched it
Detected package.json → enabled the `node-runtime` policy pack and watched it
Policy packs: default, compose, node-runtime
```

When nothing is detected, you get the generic starter config:

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

Verify what resolved:

```bash
flecto doctor
```

---

## Top-level keys

| Key | Description |
|---|---|
| `defaults` | Settings applied to every run |
| `profiles` | Named overrides, selected with `--profile` |
| `files` | Glob patterns used when you run a command with no file arguments |
| `include` | Additional patterns merged with `files` |
| `exclude` | Patterns removed from the resolved set |

Any flag from the [CLI reference](cli-reference.md) can appear in `defaults` or a
profile, in camelCase — `--mask-secrets` becomes `maskSecrets`,
`--fail-on` becomes `failOn`, `--delivery-mode` becomes `deliveryMode`.

---

## Profiles and precedence

Profiles let one config serve local development, CI, and production checks.

```bash
flecto watch --profile dev
flecto ci --profile ci
FLECTO_PROFILE=prod flecto ci
```

Profile selection: `--profile` beats `FLECTO_PROFILE`, which beats no profile at
all.

Setting precedence, highest first:

1. A flag you explicitly typed on the command line
2. The selected profile
3. `defaults`
4. Flecto's built-in defaults

Only flags you actually type override a profile. A flag left off the command line
does not silently reset a profile setting back to its built-in default.

---

## Ignoring noisy keys

```bash
flecto watch config/prod.yaml --ignore "updated_at,meta.timestamp"
```

| Pattern | What it ignores |
|---|---|
| `meta.timestamp` | That exact key |
| `meta` | Everything under `meta.*` |
| `servers[*].meta.timestamp` | That key inside any array item |
| `**.updated_at` | Any key named `updated_at`, at any depth |

Ignore patterns apply consistently across `watch`, `watch --diff`, `ci`, and
`history`, so a key you silence locally stays silent in CI.

---

## Array identity matching

By default, arrays of objects are matched by a shared, unique `id` key, falling
back to `name` when `id` is unavailable. This is what keeps a reordered list of
named services from reading as a pile of unrelated changes.

```bash
flecto watch config/services.yaml
```

Use a different identity field:

```bash
flecto watch config/services.yaml --array-id-key serviceKey
```

Fall back to index-based diffs for every array:

```bash
flecto watch config/services.yaml --no-array-id
```

In `.flectorc`, `"arrayId": false` in `defaults` or a profile does the same.

To treat order itself as insignificant — useful for arrays of scalars where
position carries no meaning — use `--array-ignore-order`.

> **Upgrading from 2.0:** identity matching is on by default as of 2.1, so diff
> paths may change from `services[0].…` to `services["api"].…`. Review any
> automation that consumes diff paths. See the [changelog](../CHANGELOG.md).

---

## Multi-document YAML

A YAML file may hold several `---`-separated documents — the usual shape of a
Kubernetes manifest. Flecto diffs each document under its own key, chosen the
same way arrays pick an identity: something stable if one exists, position if
not.

| Document shape | Key |
|---|---|
| `kind` + `metadata.name` | `Deployment/api` |
| `kind` + `metadata.namespace` + `metadata.name` | `Deployment/prod/api` |
| Top-level `id`, else top-level `name` | `api` |
| Anything else | `0`, `1`, `2`, … |

```
Deployment/api.spec.replicas changed from 2 to 5
```

Identity keys are all-or-nothing per file: if any document lacks one, or two
documents resolve to the same key, the whole file falls back to index keys. That
keeps the keys in one file consistent, at the cost of shifting every path when a
document is inserted ahead of others — so give documents a `kind`/`name` if you
want paths that survive edits.

Empty documents are dropped, so a leading `---`, a trailing `---`, or a template
that rendered nothing does not create a phantom entry.

A file with exactly one document is diffed as that document, unchanged — paths
in ordinary single-document YAML are identical to earlier versions. The
corollary is that a file going from two documents to one (or the reverse)
changes shape, and that diff reads as a rewrite rather than a single removal.

---

## Secret masking

```bash
flecto watch .env --mask-secrets
flecto watch .env --mask-secrets --mask-secrets-webhooks
```

`--mask-secrets` redacts secret-like values in terminal output; add
`--mask-secrets-webhooks` to redact them in webhook payloads too. Masking
recurses, so a secret nested under a benign-looking parent key is redacted along
with its parent.

Detection runs on two independent paths:

**Key name.** Paths matching `secret`, `token`, `password`, `api_key`,
`private_key`, or `credential` are redacted whole, whatever the value is.

**Value shape.** The value is redacted even under a name that gives no hint —
`db.connstr`, a bare `value` — when it matches a known token format (AWS
`AKIA…`/`ASIA…`, GitHub `ghp_…`/`gho_…`/`ghu_…`/`ghs_…`/`ghr_…`, Slack
`xox[abprs]-…`, Google `AIza…`, Stripe `sk_live_…`/`rk_live_…`, a JWT, a PEM
private-key block, or credentials embedded in a `scheme://user:password@host`
URL), or when it is an opaque high-entropy string. Only the secret part of a
value is replaced, so `postgres://app:hunter2@db.internal:5432/appdb` prints as
`postgres://app:***@db.internal:5432/appdb`.

The entropy fallback is deliberately conservative: it requires 24+ characters
drawn only from `[A-Za-z0-9+=_-]`, a mix of upper, lower, and digits with
25–85% of the letters uppercase, no run of 8+ same-case letters, and Shannon
entropy of at least 4.0 bits per character. Hostnames, URLs, file paths, UUIDs,
git SHAs, version strings, `sha512-…` integrity hashes, and base64 of ordinary
text all fail those gates and are never masked. The trade is real: an
all-lowercase or standard-base64 secret containing `/` is missed unless it
matches one of the known formats above. Values that only *reference* a secret
(`${DB_PASSWORD}`, `$TOKEN`, `<your-key>`) are left alone.

The same detection drives the `secret-value-detected` policy rule in the
built-in `default` pack, so what gets flagged and what gets redacted stay in
step.

---

## Watching on network drives

Native filesystem events are used by default. Some network drives and editors
don't emit them reliably:

```bash
flecto watch config/prod.yaml --polling --interval 500
```

Polling is off by default; `--interval` applies only when it's on.
