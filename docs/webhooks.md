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
| `--webhook-format <service>` | `flecto` | Payload shape: `flecto`, `slack`, `discord`, `teams`, `auto` — see [Sending to chat](#sending-to-chat) |

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

`--webhook-format` posts a payload the chat service renders natively, so no
receiver of your own is needed. Everything else — headers, timeout, retries,
delivery modes, `--on-alert-failure` — works exactly as above; only the request
body changes.

```bash
flecto watch config/prod.yaml \
  --webhook "https://hooks.slack.com/services/T000/B000/XXXX" \
  --webhook-format slack
```

| Value | Body posted |
|---|---|
| `flecto` (default) | The raw envelope, unchanged |
| `slack` | [Block Kit](https://api.slack.com/block-kit) `blocks`, plus a `text` fallback for notifications |
| `discord` | One `embeds[]` entry, colored by severity |
| `teams` | A [MessageCard](https://learn.microsoft.com/en-us/outlook/actionable-messages/message-card-reference) for Office 365 connector webhooks |
| `auto` | Detected from the webhook host (see below) |

The default stays `flecto`: without the flag, the posted bytes are exactly what
earlier versions sent, so existing receivers are unaffected.

In `.flectorc` the key is `webhookFormat`:

```json
{
  "profiles": {
    "prod": { "webhookFormat": "slack" }
  }
}
```

The `X-Flecto-Event-Id`, `X-Flecto-Batch-Id`, and `X-Flecto-Schema` headers are
still sent with chat payloads — chat services ignore unknown headers, and they
make deliveries traceable.

### Auto-detection

`--webhook-format auto` picks a format from the webhook host:

| Host | Format |
|---|---|
| `hooks.slack.com` (any `*.slack.com`) | `slack` |
| `discord.com` / `discordapp.com` with an `/api/webhooks` path | `discord` |
| `*.office.com`, `*.office365.com` (e.g. `*.webhook.office.com`) | `teams` |
| anything else | `flecto` |

Detection is opt-in rather than automatic, so upgrading never changes what an
existing webhook receives. An explicit `--webhook-format slack` always wins over
detection. Power Automate endpoints (`*.logic.azure.com`) are not detected — set
`--webhook-format teams` for those.

### Severity and truncation

The highest policy severity in the event drives the color and emoji:

| Severity | Emoji | Color |
|---|---|---|
| `error` | 🔴 | `#D92D20` |
| `warn` | 🟡 | `#F79009` |
| `info` | 🔵 | `#2E90FA` |
| none (no findings) | 🟢 | `#12B76A` |

Large change sets are truncated rather than posted as a wall of text: at most 20
change lines and 20 policy findings per message, individual values cut at 80
characters, with a trailing `… +N more changes` / `… +N more findings`. Text is
then fitted to each service's documented maximum:

| Service | Limit coded against |
|---|---|
| Slack | 3000 chars per section `text`, 150 per `header`, 50 blocks per message |
| Discord | 4096 chars per embed `description`, 256 per `title` |
| Teams | 28 KB per incoming-webhook message |

The full change set is always in the envelope — use `--webhook-format flecto`
(or a second webhook) when a downstream system needs every change.

Note that policy finding messages are rendered verbatim, exactly as they appear
in the raw envelope. A pack whose `messageTemplate` interpolates `{before}` /
`{after}` can therefore surface a value that `--mask-secrets-webhooks` redacted
from `changes`. Keep secret-bearing paths out of message templates.

---

## Secret masking in payloads

`--mask-secrets` alone only affects terminal output. To redact secret-like values
in the webhook payload too:

```bash
flecto watch .env --mask-secrets --mask-secrets-webhooks
```

Masking happens before the envelope is built, so it applies to every
`--webhook-format` — a Slack, Discord, or Teams message renders the same `***`
placeholders the raw envelope carries.

See [configuration](configuration.md#secret-masking) for what counts as
secret-like.

---

## Migrating from envelope 1.1

- `schema_version` is now `"2.0"`
- The type name is `FlectoEnvelope`
- Change envelopes carry a new `policies` array
- Webhook headers are unchanged (`X-Flecto-*`)
