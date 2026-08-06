# Webhooks and commands

Flecto can forward every change to an HTTP endpoint, run a shell command, or
both. This page covers the payload shape, delivery guarantees, and the
environment passed to commands.

---

## Sending a webhook

```bash
flecto watch config/prod.yaml \
  --webhook https://hooks.example.com/notify \
  --webhook-header "Authorization: Bearer TOKEN"
```

`--webhook-header` is repeatable.

| Flag | Default | Description |
|---|---|---|
| `--webhook-timeout <ms>` | `5000` | Request timeout |
| `--webhook-retries <n>` | `2` | Retry attempts per event |

Each request carries identifying headers:

| Header | Description |
|---|---|
| `X-Flecto-Event-Id` | Unique id for this event |
| `X-Flecto-Batch-Id` | Groups events emitted from one file change |
| `X-Flecto-Schema` | Envelope schema version |

---

## Envelope shape

`schema_version: "2.0"`:

```json
{
  "schema_version": "2.0",
  "event_id": "a3485f3c-1d27-4cea-a513-56a78ef468d3",
  "batch_id": "3518ac0a-bca6-4920-b034-780ef55596e9",
  "event_type": "changes",
  "source": "ci",
  "emitted_at": "2026-08-06T01:19:20.915Z",
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

`changes[].type` is one of `changed`, `added`, or `removed`.
`policies[].severity` is `info`, `warn`, or `error`.

Formal schema:
[`schemas/flecto-envelope-2.0.json`](../schemas/flecto-envelope-2.0.json).
The TypeScript type name is `FlectoEnvelope`.

---

## Delivery modes

| Flag | Options | Behavior |
|---|---|---|
| `--delivery-mode` | `best-effort` (default), `at-least-once` | `at-least-once` persists failed events to `.flecto-queue/` and retries them |
| `--on-alert-failure` | `warn` (default), `exit`, `retry` | What happens when a command or webhook fails |

```bash
flecto watch config/prod.yaml \
  --webhook https://hooks.example.com/notify \
  --delivery-mode at-least-once \
  --on-alert-failure retry
```

Pick `best-effort` for a chat notification you can afford to miss, and
`at-least-once` when the webhook drives real automation.

Note that `at-least-once` means exactly that — a receiver may see the same
`event_id` twice, so make handlers idempotent.

---

## Running a command on change

```bash
flecto watch .env --command "docker-compose restart app"
```

The command runs through your shell on every change, with these variables set:

| Variable | Description |
|---|---|
| `FLECTO_FILE` | Absolute path of the changed file |
| `FLECTO_EVENT_ID` | Unique id for this event |
| `FLECTO_BATCH_ID` | Groups events from one file change |
| `FLECTO_SCHEMA_VERSION` | Envelope schema version |
| `FLECTO_CHANGES` | Changes as a JSON array |
| `FLECTO_CHANGES_FILE` | Path to a temp file with the payload, for large change sets |
| `FLECTO_CHANGES_TRUNCATED` | `1` when the payload was too large to pass inline |

Because a large payload may be moved out of `FLECTO_CHANGES` and into a file,
robust scripts should check `FLECTO_CHANGES_FILE` first:

```bash
#!/usr/bin/env bash
payload="${FLECTO_CHANGES}"
if [ -n "${FLECTO_CHANGES_FILE}" ]; then
  payload="$(cat "${FLECTO_CHANGES_FILE}")"
fi
echo "${payload}" | jq -r '.[] | "\(.type) \(.path)"'
```

---

## Command and webhook together

```bash
flecto watch .env \
  --command "make reload" \
  --webhook https://hooks.example.com/notify
```

---

## Sending to chat

There is no built-in Slack or Discord formatter yet — the webhook posts Flecto's
own envelope, which chat services won't render directly. Today that means a small
receiver that reshapes the payload.
[#68](https://github.com/myselfsiddharth/Flecto/issues/68) tracks native
formatters.

---

## Secret masking in payloads

`--mask-secrets` alone only affects terminal output. To redact secret-like values
in the webhook payload too:

```bash
flecto watch .env --mask-secrets --mask-secrets-webhooks
```

See [configuration](configuration.md#secret-masking) for what counts as
secret-like.

---

## Migrating from envelope 1.1

- `schema_version` is now `"2.0"`
- The type name is `FlectoEnvelope`
- Change envelopes carry a new `policies` array
- Webhook headers are unchanged (`X-Flecto-*`)
