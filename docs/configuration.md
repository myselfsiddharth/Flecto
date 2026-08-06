# Configuration

Everything Flecto reads from `.flectorc`, plus the pattern syntax used by
`--ignore` and array identity matching.

---

## Creating a config file

```bash
flecto init
```

Flecto looks for `.flectorc`, `.flectorc.json`, `.flectorc.yaml`, or
`.flectorc.yml` in the working directory.

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

## Secret masking

```bash
flecto watch .env --mask-secrets
flecto watch .env --mask-secrets --mask-secrets-webhooks
```

`--mask-secrets` redacts secret-like values in terminal output; add
`--mask-secrets-webhooks` to redact them in webhook payloads too. Masking
recurses, so a secret nested under a benign-looking parent key is redacted along
with its parent.

Detection is based on the *key name* — paths matching `secret`, `token`,
`password`, `api_key`, `private_key`, or `credential`. A secret stored under a key
name that gives no hint is not currently detected;
[#66](https://github.com/myselfsiddharth/Flecto/issues/66) tracks value-based
detection.

---

## Watching on network drives

Native filesystem events are used by default. Some network drives and editors
don't emit them reliably:

```bash
flecto watch config/prod.yaml --polling --interval 500
```

Polling is off by default; `--interval` applies only when it's on.
