# Encrypted files (SOPS and age)

Teams that keep secrets in git already encrypt them. Until now those files were
the ones Flecto helped with least: a `sops`-encrypted YAML either got skipped or
was read as ordinary YAML, and the diff filled up with ciphertext blobs that
nobody could act on.

Flecto now understands the *shape* of an encrypted file. It reports what
changed structurally — which keys exist, which encrypted values moved, and who
can decrypt the file — and never shows a single byte of ciphertext.

## Flecto never decrypts

This is the whole point, so it is worth stating plainly.

- Flecto **never decrypts** an encrypted value.
- Flecto **never shells out** to `sops`, `age`, `gpg`, or anything else.
- Flecto **never reads a key file**, an agent socket, `SOPS_AGE_KEY`,
  `SOPS_AGE_KEY_FILE`, a KMS credential, or any other key material.
- Flecto **never sends ciphertext anywhere** — not to a webhook, not to a PR
  comment, not into a snapshot file on disk.

Pointing Flecto at an encrypted file is exactly as safe as pointing `git diff`
at it, minus the noise. Nothing in this feature can be configured to change
that; there is no flag that turns decryption on, because there is no
decryption.

## How detection works

Detection is based on **content, not filename**. Teams commit fully encrypted
files named `values.prod.yaml` and `db.json`, and `.sops.yaml` is not encrypted
at all — it is the plaintext creation-rules config. A filename is a hint at
best.

A file is treated as encrypted when either of these holds:

**1. It carries a SOPS metadata block.** A top-level `sops` map with a
`version`, plus at least two of: a `mac`, a `lastmodified` stamp, or a
non-empty key group (`kms`, `gcp_kms`, `azure_kv`, `hc_vault`, `age`, `pgp`).
For dotenv and INI files, SOPS writes this flat, as `sops_version` /
`sops_mac` / `sops_lastmodified`, and that shape is recognized too.

**2. A value is in a recognized ciphertext container.** A SOPS leaf
(`ENC[AES256_GCM,data:…]`), an armored age block
(`-----BEGIN AGE ENCRYPTED FILE-----`), or an armored PGP message
(`-----BEGIN PGP MESSAGE-----`). These are redacted wherever they appear, even
in a file with no metadata block.

A file whose entire contents are one armored age blob, and any file with an
`.age` extension, is treated as a single opaque value rather than a config
document — there is no structure in it to parse.

### False positives

The realistic near-miss is an ordinary config that has a top-level `sops` key.
Something like this is common, and is **not** treated as encrypted, because it
has no MAC, no modification stamp, and no key group:

```yaml
sops:
  version: 3.9.0
  enabled: true
  config_path: .sops.yaml
```

The version alone is not enough, and neither is a version plus one other
signal. A config that trips the metadata test would have to invent a `sops` map
with a version, a MAC, and a modification stamp — which is essentially only
produced by SOPS itself.

The other possibility is a file that quotes a literal `ENC[AES256_GCM,data:…]`
string in documentation or a test fixture. That value gets redacted in the
diff. It is cosmetic: nothing is lost but the display of a string that was
already meaningless.

## What is reported

### Encrypted values

Every ciphertext-bearing value is replaced, **at parse time**, with an opaque
sentinel of the form `<encrypted:SCHEME:DIGEST>`, where the digest is a
truncated SHA-256 of the ciphertext. The digest is what makes a change
observable; it reveals neither the value nor its length.

Because the substitution happens in the parser, no ciphertext exists anywhere
downstream — not in a diff, a `.flecto-snapshots/` file, a webhook body, a PR
comment, or an HTML report.

In human output an encrypted value collapses further:

```
  ~ database.password: <encrypted value changed>
  - api: {"key":"<encrypted value>"}
```

Machine-readable output (`--format json`, `ndjson`, webhooks) keeps the
sentinel, which is stable across runs and therefore useful to correlate.

### Structure

Keys added, removed, or moved are reported exactly as they are for any other
file — that structure *is* the signal for an encrypted file:

```
  + cache: {"ttl_seconds":300}
  - api: {"key":"<encrypted value>"}
  ~ database.password: <encrypted value changed>
  ~ sops.lastmodified: "2026-01-04T10:15:00Z" → "2026-02-11T09:00:00Z"
  ~ sops.mac: <encrypted value changed>
```

### Recipients — who can decrypt this file

The recipient list is the most valuable thing an encrypted file will tell you,
so it is reported in full. Public identifiers stay visible — the age recipient,
the PGP fingerprint, the KMS ARN — while the `enc` field on each entry, which
is the data key sealed to that recipient, is redacted like any other
ciphertext.

On disk the key groups are arrays, so a recipient inserted at the front would
otherwise index-shift every entry and read as "every recipient changed" —
exactly the case where a reviewer must not be misled. Flecto re-keys those
arrays by recipient identity, so the real event is a single addition:

```
  + sops.age.age1exampleexample…: {"recipient":"age1exampleexample…","enc":"<encrypted value>"}
```

Recipient *order* carries no meaning in a SOPS file, so reordering produces no
events. If any entry has no usable identity, or two share one, the array shape
is kept so the diff stays faithful to the file.

### Derived signals

Two things a key-by-key walk cannot express are reported at synthetic paths:

| Path | Meaning |
|---|---|
| `<encryption>` | The file gained or lost encryption. `"sops" → "plaintext"` means plaintext secrets were committed. |
| `<encryption.mac>` | The SOPS MAC moved while every value it covers stayed put. A normal edit moves both together. |

Both behave like ordinary paths: `--ignore '<encryption.mac>'` silences one.

A value that was encrypted and is now a plain scalar is reported as changed,
but the new value is replaced with `<no longer encrypted>`. The point of the
event is that the value was exposed; printing it into a CI log would expose it
again, to a wider audience.

### Multi-document files

A `---`-separated file — the shape Kubernetes secrets ship in — is handled per
document. Each document is inspected for its own `sops` metadata block, so a
`kind: Secret` travelling alongside a plain ConfigMap keeps every protection
above: its ciphertext is redacted, its recipient groups are re-keyed by
identity, and a value committed in the clear is withheld behind
`<no longer encrypted>`. Paths carry the document identity in front, and the
`sops` pack rules match there too:

```
  ~ Secret/prod/billing.data.dsn: <encrypted value> → "<no longer encrypted>" [value is no longer encrypted]
  + Secret/prod/billing.sops.age.age1newcomernewcomer…: {"recipient":"age1newcomernewcomer…","enc":"<encrypted value>"}
```

`<encryption>` stays a file-level signal: it fires when the *file* stops
carrying any encrypted document at all.

## What is deliberately *not* reported

- **Plaintext of any encrypted value.** There is no code path that could
  produce it.
- **Ciphertext, including the MAC and the sealed data keys.** Ciphertext in a
  diff is noise, and its length is metadata worth withholding.
- **Whether two encrypted values hold the same plaintext.** The digest is taken
  over the ciphertext, and SOPS uses a fresh IV per value, so two encryptions of
  the same secret produce unrelated sentinels. Identical *ciphertext* does
  produce identical sentinels — but that is already visible in the repository.
- **Encrypted key *names*.** SOPS encrypts values, not keys, so key names are
  in the file already.

## Policy rules

The built-in **`default`** pack carries the two rules that catch a secret
committed in the clear, so they apply without opting in:

| Rule | Severity | Fires when |
|---|---|---|
| `sops-file-decrypted` | `error` | An encrypted file is now plaintext. |
| `sops-value-decrypted` | `error` | A value that was encrypted is now stored in the clear. |

The built-in **`sops`** pack adds the rest. Enable it alongside `default`:

```bash
flecto ci 'secrets/**/*.yaml' --policies default,sops
```

```json
{
  "defaults": {
    "policies": "default,sops"
  }
}
```

| Rule | Severity | Fires when |
|---|---|---|
| `sops-file-decrypted` | `error` | An encrypted file is now plaintext. |
| `sops-value-decrypted` | `error` | A value that was encrypted is now stored in the clear. |
| `sops-recipient-added` | `error` | A key was added that can now decrypt this file. |
| `sops-recipient-removed` | `warn` | A key lost access. Anything it already read stays readable to its holder. |
| `sops-mac-changed-without-value-change` | `warn` | The MAC moved on its own — a hand-edited or tampered metadata block. |
| `sops-file-encrypted` | `info` | A previously plaintext file is now encrypted. Git history still holds the old values. |
| `sops-creation-rule-recipients-changed` | `warn` | A `.sops.yaml` creation rule changed who future encryptions are readable by. |

Severities are remappable like any other rule. →
**[Policy packs](policy-packs.md)**

## `.sops.yaml` is not an encrypted file

`.sops.yaml` (or `.sops.json`) is the creation-rules config: it decides which
recipients *future* encryptions go to. It is plaintext, and Flecto diffs it like
any other YAML — which is the useful behavior, since the recipient lists in it
are readable. `sops-creation-rule-recipients-changed` flags a change to one.

Changing a creation rule does not change any existing file. Those keep their
current recipients until they are re-encrypted, which is why the rule is a
warning rather than an error.

## Limitations

- **SOPS dotenv and INI format.** The flat `sops_*` metadata is detected, and
  `ENC[…]` values are redacted, but the flattened key groups
  (`sops_age__list_0__map_enc` and friends) are not re-keyed by recipient. A
  KMS `enc` blob in flat format is base64 with no container marker and is left
  as-is; it is a sealed data key, not a secret.
- **Non-armored binary `.age` files** are read as UTF-8 to compute their
  digest, so two different binaries could in principle produce the same
  sentinel. Armored files, which is what gets committed to git, are exact.
