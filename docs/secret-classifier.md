# The secret classifier

`src/secrets.js` buys a **zero-false-positive floor with recall**, deliberately.
Masking a real hostname in someone's terminal is worse than missing an unusual
secret, so its gates reject anything that could plausibly be a hostname, URL,
path, UUID, digest, or version string. That trade is correct as a default, and
it leaves two known, quantified gaps:

- roughly **5% of random tokens** are missed (worst at length 24, about 7%);
- **standard-base64 secrets containing `/` are missed by construction** — the
  charset gate excludes `/` precisely so that hostnames and paths can never be
  candidates.

`--classify-secrets` is an opt-in **second stage** that closes part of that gap.
It is off by default.

```bash
flecto ci "config/**/*.yaml" --mask-secrets --classify-secrets
flecto watch config/prod.yaml --mask-secrets --classify-secrets
```

`.flectorc`:

```json
{ "defaults": { "classifySecrets": true } }
```

A runner that must not run it at all: `FLECTO_CLASSIFY_SECRETS=0`, which
overrides both the flag and the config file.

## Results

Model `1.0.0`. Held-out corpus: 500 secrets, 28 benign values.

| | Secrets caught | Benign flagged |
|---|---|---|
| Heuristic alone | 240/500 (48.0%) | 1/28 |
| With `--classify-secrets` | 318/500 (63.6%) | 1/28 |
| **Classifier's own contribution** | **+78** | **+0** |

Standard-base64 secrets containing `/` — the gap the charset gate cannot see by construction: 0/189 caught by the heuristic, 76/189 with the classifier.

Cost: 0.0127 ms per value.

The one benign value flagged in both rows is `ChIJN1t_tDeuEmsRUsoyG83frY4`, a
Google Place ID — a public identifier with the charset, length, and case mix of
a token. **The existing heuristic already flags it**; the classifier does not
add it. It is left in the corpus rather than removed, because a benchmark that
quietly drops its hardest case is not a benchmark.

The numbers above are regenerated with `npm run bench:classifier`.

## What it will and will not do

**It may only add detections.** It runs after every existing detector and its
output is unioned with theirs:

| Situation | Result |
|---|---|
| A known vendor token format matches | secret — the classifier is not consulted |
| The entropy gate passes | secret — the classifier cannot un-flag it |
| The entropy gate rejects | the classifier gets a vote, and may flag it |

A model that can *suppress* a detection is a model that can leak a credential on
a version bump. Union-only also bounds the failure mode to false positives,
which are visible and annoying, rather than silent exposure.

Its matches carry their own kind, `classified`, so the renderer, `SecretMatch`,
and the redaction path can tell them apart — and so anyone who does not trust it
can see exactly what it caught.

**It considers nothing shorter than 24 characters**, the same floor the entropy
gate uses. Below that a configuration is full of `RollingUpdate`,
`IfNotPresent`, `ap-southeast-2`, and `P1Y2M10DT2H30M`: opaque, word-shaped,
and emphatically not credentials.

**It does not attempt hex or base32.** A 40-character lowercase-hex secret and a
git SHA are the same alphabet, the same length, and the same entropy; an
uppercase base32 secret and a TOTP seed likewise. These are not hard to tell
apart, they are *undecidable from the value alone*, and buying recall there
would cost the false-positive floor. The entropy gate excludes them for the same
reason.

## Determinism

Teams gate merges on Flecto's exit code, so identical input must produce an
identical finding on every run and every machine.

- Inference is a dot product over a pinned weight file. No sampling, no clock,
  no locale, nothing that lets a float wobble across the threshold.
- The model version travels in the JSON envelope as `classifier_version`, beside
  `schema_version`, and is present only when the classifier ran.
- **Changing the model is a breaking change**, treated with the same semver care
  as changing a policy pack default.

## Offline, and the model is the one that shipped

Flecto reads `.env` files, SOPS documents, and Terraform plans. Nothing is sent
anywhere: inference is local, over weights in the package, with no telemetry and
no network path of any kind.

There is deliberately **no `--classify-model <path>`**. `.flectorc` is
attacker-controlled on an untrusted pull request, and deserializing an
attacker-supplied model file is the same class of hole as loading their plugin
([GHSA-wq8m-fc3q-8m5x](https://github.com/myselfsiddharth/Flecto/security/advisories/GHSA-wq8m-fc3q-8m5x)).
One shipped model, no path option.

## The model

Character 3-gram logistic regression plus 22 named shape features — the right
class for deciding whether a short opaque string is key material, and small
enough to audit:

| | |
|---|---|
| Weights | `src/classifier-weights.json`, 48 KB (budget: 500 KB) |
| Cost | ~0.012 ms per value (budget: 1 ms) |
| New dependencies | none |

Training lives in `training/` and is **not published**. It is reproducible from
a clean checkout — the corpus is synthesized by a seeded generator, and there is
no shuffling, no dropout, and no early stopping:

```bash
node training/train.js --dry-run   # train and evaluate, write nothing
node training/train.js             # rewrite src/classifier-weights.json
```

The script **refuses to write weights** that produce a false positive on the
benign corpus. See [`training/README.md`](../training/README.md) for where every
example comes from.
