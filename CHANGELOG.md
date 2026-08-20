# Changelog

All notable changes to Flecto will be documented in this file.

The format is based on [Keep a Changelog], and this project adheres to
[Semantic Versioning].

## [Unreleased]

### Added

- `flecto init` now detects Kubernetes manifests and SOPS usage — the two file
  shapes 3.0 was built around — and enables the `kubernetes` and `sops` packs
  accordingly. Detection is content-based: a YAML document must actually carry
  `apiVersion` + `kind` to count as a manifest (a config with a bare `kind:`
  field does not), and SOPS is recognized from a top-level metadata block or a
  `.sops.yaml` creation-rules file. Sniffing is bounded — the repo root plus the
  conventional `k8s/` / `kubernetes/` / `manifests/` / `deploy/` directories, a
  cap on files read, and files over 256 KB skipped — so `init` never turns into
  a full-tree scan. The "detected nothing" generic fallback is unchanged. ([#123])

### Fixed

- Adding a second YAML document beside an existing one no longer re-paths the
  whole file. A lone Kubernetes-shaped document (`apiVersion` + `kind` +
  `metadata.name`) is now keyed by identity — `kind/namespace/name` — exactly as
  it is inside a multi-document file, so a `Service` added next to a `Deployment`
  reads as one addition instead of reporting the untouched Deployment as removed
  and re-added. Ordinary single-document YAML (anything without both
  `apiVersion` and `kind`) is unchanged. ([#124])

  **Migration:** paths for a *single*-document manifest change from bare
  (`spec.replicas`) to identity-prefixed (`Deployment/prod/api.spec.replicas`).
  Snapshots and CI baselines taken of a single manifest before this release will
  show one-time churn on the next diff; `--ignore` entries and custom pack path
  regexes written against the bare paths need the prefix. Multi-document files
  and non-manifest config are unaffected.

### Security

- **Terraform plan JSON is refused by every command except `flecto plan`.**
  Terraform's `before_sensitive` / `after_sensitive` redaction is applied only by
  `flecto plan`; a plan file is ordinary JSON, so `ci`, `watch`, `compare`,
  `report`, and snapshot writes read it as a plain config tree and printed the
  values Terraform itself refuses to print. `--mask-secrets` was not a backstop —
  it fires on the attribute *name*, and `user_data` does not match. Realistic
  ways to hit it: `flecto ci "**/*.json"`, a committed `tfplan.json`, or
  `.flectorc` `files` patterns that sweep JSON. Those commands now fail with a
  pointer to `flecto plan`, mirroring the guard `flecto plan` already had in the
  other direction. ([#113])

### Fixed

- `flecto policies test` now resolves packs installed by `flecto policies add`.
  The harness searched only the fixture directory's `policies/`, while
  `policies add` writes to the invoking project's — so the two commands added in
  the same release did not compose. A fixture's own `policies/` still wins, so
  self-contained fixtures are unaffected; the project is a fallback. The
  "unknown pack" error now names every directory it searched instead of
  suggesting a path that already existed. ([#114])

## [3.0.1] - 2026-08-07

### Security

- **Policy plugins declared in `.flectorc` are no longer loaded**
  ([GHSA-wq8m-fc3q-8m5x], critical). A pull request that added a `.flectorc`
  with a `plugins` entry achieved **arbitrary code execution on the CI runner** —
  `flecto ci` is what teams run on pull requests, and it honoured the attacker's
  config with no opt-in, no allowlist, and no path containment. The attacker's
  code ran with whatever the workflow exposed, including `GITHUB_TOKEN`, and the
  path was not contained, so `../../../../tmp/x.mjs` loaded a module from
  anywhere on disk.

  Plugins now load only from an explicit `--plugins` flag. If a config file is
  genuinely trusted, set `FLECTO_ALLOW_RC_PLUGINS=1`; even then an rc-declared
  plugin must live inside the working directory. Flecto **fails loudly** rather
  than skipping the plugin silently, because a policy plugin that stopped running
  without saying so would quietly weaken a gate the operator believes is
  enforced.

  Policy *packs* are declarative and were never affected. `--plugins` is
  unchanged, including paths outside the project, since the flag is operator
  intent rather than attacker input.

  **If you run Flecto on untrusted pull requests, upgrade.** If you rely on
  `plugins` in `.flectorc`, move it to `--plugins` or set the opt-in.

  The trust boundary is now documented in [plugin authoring](docs/plugins.md);
  it previously was not stated anywhere.


## [3.0.0] - 2026-08-06

### Migration notes

Flecto 3.0.0 is additive in surface — no command, flag, or envelope field was
removed, exit codes are unchanged, and `schema_version` is still `2.0`. Two
behavior changes can turn a green 2.1.0 pipeline red, so read these first.

**1. The `default` policy pack catches more.** Value-pattern secret detection
and the SOPS decryption rules were added to `default`, so a credential-shaped
value under an innocuous key name — or a secret committed in the clear — is now
an `error`. A pipeline using `--fail-on policy` can fail on config that passed
in 2.1.0:

```
flecto ci config.yaml --fail-on policy,error
#  2.1.0 -> exit 0        3.0.0 -> exit 1
```

That is the intended behavior, but it is worth a dry run before upgrading CI.
To keep the 2.1.0 rule set while you triage, name the packs explicitly and
silence the new rules with `severityRemap`:

```json
{ "profiles": { "ci": { "severityRemap": {
  "secret-value-detected": "off",
  "sops-file-decrypted": "off",
  "sops-value-decrypted": "off"
} } } }
```

**2. Unknown `--fail-on` triggers are now an error.** A typo previously matched
nothing and the run exited `0`, so the gate was silently absent:

```
flecto ci config.yaml --fail-on "polciy,eror"
#  2.1.0 -> exit 0, ignored        3.0.0 -> exit 1, "unknown triggers: polciy, eror"
```

Any pipeline carrying a typo will go red on upgrade. That is the bug being
fixed — those runs were never actually gated — but the failure is new.

**Also worth knowing, unlikely to break a build:**

- **Multi-document YAML now parses** instead of failing the file. Paths inside
  such a file are prefixed with the document identity (`Deployment/prod/api.…`),
  so `--ignore` entries and custom pack path regexes written against
  single-document paths will not match. Single-document files are unchanged.
- **Encrypted files no longer emit ciphertext to machine consumers.** 2.1.0 put
  `ENC[AES256_GCM,data:…]` in the diff; 3.0.0 emits sentinels. Anything parsing
  the JSON/NDJSON envelope for SOPS files needs updating.
- **`flecto init` no longer overwrites an existing config.** 2.1.0 silently
  regenerated `.flectorc.json`, destroying edits. Both still exit `0`, so a
  script relying on regeneration now gets a no-op.
- **`--mask-secrets` masks more than before** — value-shaped detection and
  nested values, not only top-level sensitive key names.

### Added

- A test that every runtime dependency's `engines.node` is satisfiable by the
  Node version Flecto itself declares, plus a check that the CI matrix actually
  exercises that floor. This class of bug has now happened twice ([#22], and
  chalk 6 requiring Node >=22 in [#104]) and CI could not catch it: `engines` is
  advisory, so the Node 20 job passes while npm warns users with `EBADENGINE`.
  The check reads each manifest off disk rather than through `require()`,
  because a package whose `exports` map hides `./package.json` — chalk 6 is
  exactly that — would otherwise be skipped silently. `chalk` majors are held in
  Dependabot alongside `commander` and `js-yaml`. ([#104])
- Pre-merge review of rendered Kubernetes manifests, and a `kubernetes` policy
  pack to gate it. ArgoCD, Flux, and `helm diff` compare a cluster to the
  repository; this compares the manifests a pull request *would* produce against
  the ones the merge target produces, before `helm upgrade` runs. The workflow
  needs no new command and no new dependency: render both sides to plain
  multi-document YAML with whatever you already use — `helm template`,
  `kustomize build`, `kubectl kustomize`, `jsonnet`, `cdk8s` — and diff them with
  `flecto compare base.yaml head.yaml --policies kubernetes`. Repositories that
  commit their rendered output can use `flecto ci manifests/prod.yaml
  --snapshot-ref origin/main` instead and render once. **Flecto never invokes
  `helm` or `kustomize`**; neither is a dependency and neither has to exist on
  the runner, which is what keeps the renderer your choice. The pack carries ten
  rules for changes that are risky at review time: `privileged`, host
  namespaces, weakened `runAsNonRoot`, `allowPrivilegeEscalation`, `SYS_ADMIN` /
  `NET_ADMIN` / `ALL` capabilities, images that resolve to `:latest`,
  `imagePullPolicy` moving to `Always`, replica jumps, removed resource limits,
  and Services becoming `LoadBalancer` or `NodePort`. Thresholds are tuned so
  routine work stays quiet — a replica jump needs both a 3× multiple and an
  increase of at least 3, so `1 → 2` does not fire. Policy packs also gained an
  optional pack-level `expandSubtrees`, which expands added and removed subtrees
  into the leaf changes they imply before rules run; without it a brand-new
  `Service` document is a single change carrying the whole manifest, and a rule
  anchored at `spec.type` never sees inside it. It is opt-in per pack and off by
  default, so every existing pack behaves exactly as before. ([#76])
- SOPS- and age-aware diffing, structural and **without ever decrypting**.
  Encrypted files were previously the ones Flecto helped with least: skipped, or
  read as ordinary YAML with ciphertext blobs filling the diff. They are now
  detected from their **contents** — a SOPS metadata block (a `sops` map with a
  version plus a MAC, a modification stamp, or a key group; also the flat
  `sops_*` form used for dotenv and INI), or a recognized ciphertext container
  (`ENC[AES256_GCM,…]`, an armored age blob, an armored PGP message). Filenames
  are only a hint: teams commit fully encrypted `values.prod.yaml`, and
  `.sops.yaml` is a *plaintext* creation-rules config. A config that merely pins
  `sops.version` is not mistaken for an encrypted file. `.age` files, and any
  file that is one armored blob, are now supported as a single opaque value.
  Every ciphertext-bearing value is replaced **in the parser** with an opaque
  `<encrypted:SCHEME:DIGEST>` sentinel, so no diff, snapshot, webhook payload,
  PR comment, or HTML report can carry ciphertext — there is no code path that
  produces any, with or without `--mask-secrets`. Human output collapses it
  further, to `~ db.password: <encrypted value changed>`. What you get instead
  is the structure: keys added and removed, which encrypted values moved, the
  `sops` metadata block, and — the useful part — the recipient list. Public
  identifiers stay visible (age recipient, PGP fingerprint, KMS ARN) while the
  data key sealed to each is redacted, and the key groups are re-keyed by
  recipient identity so a recipient inserted at the front reads as one addition
  rather than "every recipient changed". Two synthetic paths carry what a
  key-by-key walk cannot express: `<encryption>` when a file gains or loses
  encryption, and `<encryption.mac>` when the MAC moves while every value it
  covers stays put. Both respect `--ignore` like any other path. A value that
  stopped being encrypted is reported as changed with the new value withheld —
  the event is that it was exposed, and a CI log should not widen that. A new
  built-in `sops` policy pack covers recipient added (`error`), recipient
  removed (`warn`), a lone MAC change (`warn`), a file that became encrypted
  (`info`), and `.sops.yaml` creation-rule recipient changes (`warn`); the
  `default` pack gains the two that catch a secret committed in the clear,
  `sops-file-decrypted` and `sops-value-decrypted`, both `error`. Flecto never
  shells out to `sops`, `age`, or `gpg`, never reads a key file, agent socket,
  or KMS credential, and has no flag that turns decryption on. Unencrypted files
  are untouched: a tree with nothing to redact comes back from the encryption
  pass as the same object, and a diff between two of them returns the very array
  it always did. ([#77])
- A second bundled composite Action, `flecto-pr-risk`, that packages the pull
  request risk comment as a one-line adoption: `uses:` it after
  `actions/checkout` and the defaults do the rest (`format: pr-comment`,
  posting on, `fail-on: policy,error`, secret masking on, the workflow token).
  It resolves the baseline from the pull request instead of `HEAD~1`, which is
  the wrong commit on a PR — `github.event.pull_request.base.sha`, refined to
  the merge base with `HEAD` when the checkout carries enough history. A
  missing base commit is fetched if it can be; when it still cannot be resolved
  the job fails with a message naming `fetch-depth: 0`, rather than reporting
  "no changes" and letting a risky edit through. Posting degrades instead of
  breaking: a fork's read-only token, a missing `pull-requests: write`, or an
  empty `github-token` produce a workflow warning and a report in the log,
  never a failed check — the exit code stays with the diff and policy result.
  `flecto-version` pins the CLI without forking the Action. The existing
  `flecto-ci` Action is untouched, inputs and defaults included, and is now
  covered by tests that parse both committed `action.yml` files. ([#74])
- `flecto report [files...]`: a static HTML drift report rendered from the local
  snapshot history `flecto history` already reads, written to
  `--output` (default `flecto-report.html`). The page carries a per-file
  timeline — each snapshot with its UTC timestamp, the snapshot it is measured
  against, its semantic changes, and the policy findings those changes produced
  — plus a summary and every finding grouped by severity. `--limit`,
  `--profile`, `--ignore`, `--policies`, `--plugins`, and the array-identity
  flags resolve through the same effective-options path as every other command,
  so a report matches what `flecto history` and `flecto watch --diff` report.
  The file is **fully self-contained**: inline CSS, one small inline script for
  filtering and collapsing, and nothing else — no fonts, no images, no CDN
  scripts, no analytics, and no network access when it is opened. It follows the
  viewer's light or dark theme, is responsive, and prints. Every config value,
  path, and message is HTML-escaped, so a value containing markup renders as
  text rather than as part of the page. `--mask-secrets` (flag or profile)
  applies the same key-name and value-pattern redaction used elsewhere, and also
  redacts policy messages that interpolate values — a report is a shareable
  artifact, so a leak there is worse than one in a terminal. With no snapshots
  it prints the same guidance `flecto history` does and writes no file. ([#75])
- A convention for distributing policy packs, plus `flecto policies add <name>`
  to install one. A community pack is an npm package named `flecto-pack-<id>`
  (or `@scope/flecto-pack-<id>`) with a `flecto-pack.json`, `flecto-pack.yaml`,
  or `flecto-pack.yml` at its root — no build step, no entry point, no code. A
  package that builds its pack elsewhere can point at it with a `"flecto"` field
  in its package.json (`{ "pack": "dist/pack.json" }`, or the bare path).
  `flecto policies add` takes either the pack id or the full package name,
  resolves the already-installed package from `node_modules`, validates it with
  the same validator that runs at evaluation time, and writes it to
  `policies/<id>.json` so the existing resolution order picks it up unchanged. A
  malformed third-party pack is rejected at add time rather than failing later
  during evaluation, and an existing local pack is never overwritten without
  `--force`. Nothing from the package is imported or executed: only the
  declarative pack file is read, JavaScript shipped in a pack package is ignored
  (and reported), and a `"flecto"` field pointing at a `.js` file is rejected.
  Plugins, which do run code, are deliberately out of scope for this command.
  `flecto policies list` now reports the originating npm package for packs
  installed this way, tracked in `policies/.flecto-packs.json`; hand-written
  local packs list exactly as before. ([#71])
- Value-pattern secret detection. Secrets are now found by what the value looks
  like, not only by the key name: known token formats (AWS `AKIA…`/`ASIA…`,
  GitHub `ghp_…`/`gho_…`/`ghu_…`/`ghs_…`/`ghr_…`, Slack `xox[abprs]-…`, Google
  `AIza…`, Stripe `sk_live_…`/`rk_live_…`, JWTs, PEM private-key blocks, and
  credentials embedded in a `scheme://user:password@host` URL) plus a
  conservative high-entropy fallback for opaque strings. The same detection
  drives `--mask-secrets` redaction and the new `secret-value-detected` rule in
  the built-in `default` and `strict-prod` packs, so a credential under a boring
  key such as `db.connstr` is both flagged and masked. Packs can use it directly
  through the new `afterLooksSecret` / `beforeLooksSecret` predicates. Key-name
  detection is unchanged. ([#66])
- Native Slack, Discord, and Microsoft Teams alert payloads:
  `flecto watch --webhook-format <flecto|slack|discord|teams|auto>` (or
  `webhookFormat` in `.flectorc`). The existing webhook path is reused as-is —
  headers, `--webhook-timeout`, `--webhook-retries`, `--delivery-mode`, and
  `--on-alert-failure` all behave identically; only the request body changes, so
  no receiver of your own is needed. Slack gets Block Kit `blocks` with an
  mrkdwn `text` fallback, Discord an embed colored by the highest policy
  severity, Teams a MessageCard. Long change sets truncate to `… +N more`
  within each service's documented limits (Slack 3000 chars per section, Discord
  4096 per embed description, Teams 28 KB per message). `auto` detects the
  format from the webhook host (`hooks.slack.com`, `discord.com/api/webhooks`,
  `*.office.com`) and is opt-in: the default remains `flecto`, which posts the
  raw envelope byte-for-byte as before. `--mask-secrets-webhooks` applies to
  chat payloads too. ([#68])
- `flecto ci --format pr-comment`: a markdown risk summary for pull requests —
  change counts, policy findings grouped by severity with file and path, and the
  per-file change list, collapsed into a `<details>` block past ten changes.
  The body opens with a hidden `<!-- flecto:pr-comment -->` marker, so posting
  updates the one comment Flecto already left instead of adding a new one per
  push; an unchanged report skips the write entirely. Rendering to stdout is the
  default and never touches the network. Posting requires **both** the explicit
  `--pr-comment-post` opt-in and a complete GitHub pull request context
  (`GITHUB_TOKEN`, `GITHUB_REPOSITORY`, and a PR number from `GITHUB_REF` or
  `GITHUB_EVENT_PATH`); `GH_TOKEN` is ignored so a local `gh auth login` cannot
  turn a laptop run into a comment. Delivery problems warn on stderr and leave
  the exit code to the diff and policy result, and the token is never printed.
  The bundled `flecto-ci` Action exposes this as the opt-in `pr-comment-post`
  and `github-token` inputs. ([#67])
- Multi-document YAML support (`---`-separated), the usual shape of a Kubernetes
  manifest. Previously such a file failed to parse. Each document is diffed
  under its own key: `kind/name` for Kubernetes-shaped documents (namespaced
  resources include the namespace), then a top-level `id` or `name`, falling
  back to the document index when no stable identity is available — so a
  document inserted at the top of a file no longer renumbers every other path.
  Empty documents (a leading or trailing `---`, or a template that rendered
  nothing) are dropped. Single-document files are unchanged: they still parse to
  the document itself, with identical diff paths. ([#69])
- Stack-aware `flecto init`: the generated `.flectorc.json` now pre-selects
  policy packs and file patterns from signals in the working directory —
  `docker-compose.yml` / `compose.yaml` enables the `compose` pack and watches
  the compose file, `package.json` enables `node-runtime`, and `config/` plus
  `.env` files shape the `files` patterns. Terraform files are reported as
  context only, since no `terraform` pack ships yet and `.tf` is not a parseable
  format. `init` prints what it detected and why, and falls back to the previous
  generic starter config when nothing is found. ([#72])
- `flecto compare <fileA> <fileB>`: run the differ and policy engine across two
  different files, for environment skew ("works in staging, fails in prod")
  rather than drift in one file over time. `fileA` is the baseline, so `+` is
  present only in `fileB` and `-` only in `fileA`. The two files need not share
  a format — `config/prod.yaml` against `config/prod.json` works, since every
  supported format parses to a plain tree. Respects `--profile`, `--ignore`,
  `--policies`, `--plugins`, `--array-id-key`, `--no-array-id`,
  `--array-ignore-order`, and `--mask-secrets` exactly as `ci` does, and adds
  `--fail-on` with the same triggers (defaulting to
  `changed,added,removed,policy,error`, since environments that should match
  ought to match on added and removed keys too). Output defaults to the
  human-readable renderer; `--format json|ndjson|github-annotations` emits the
  same envelopes and result shape as `ci`, plus a `baseline` field naming
  `fileA`. Exit code is `0` when the files match under the active fail triggers,
  `1` otherwise. ([#70])
- A reproducible large-repo benchmark harness (`npm run bench`) and the findings
  it produced in [docs/performance.md](docs/performance.md). The harness
  generates a synthetic repo at 50/250/1000 config files — including deeply
  nested trees and files with 5,000-entry arrays — snapshots it, mutates it, and
  then measures `flecto ci` end to end while attributing time across glob
  discovery, snapshot load, parse, diff, and policy evaluation. It uses
  `node:perf_hooks` only, adds no dependency, never runs during `npm test`, and
  is excluded from the published package. Developer tooling: nothing in `src/`
  or the CLI depends on it. ([#78])
- `flecto plan <planFiles...>`: diff Terraform plan JSON (`terraform show
  -json`) with the same differ, envelope, and policy engine every other command
  uses. Flecto never runs the `terraform` binary — it only reads the JSON you
  hand it. Paths are keyed by the resource address
  (`aws_security_group.web.ingress[0].cidr_blocks[0]`), and every resource also
  gets a synthetic `#action` attribute so resource-level rules can match one
  event instead of one per attribute: `create` reports as `added`, `delete` as
  `removed`, `update` as `changed`, and — deliberately — a `replace`
  (destroy-and-recreate, in either action ordering) also reports as `removed`
  carrying the value `"replace"`, so `--fail-on removed` catches every replace
  with no policy pack loaded, and the note names the attribute that forced it
  (`(forced by: engine_version)`). Values Terraform cannot resolve until apply
  (`after_unknown`) render as `(known after apply)`, never `null`, except on a
  pure create, where an all-computed attribute is dropped rather than listed.
  Values Terraform marks sensitive are replaced with `(sensitive value)`
  unconditionally — before the policy engine, the envelope, or any formatter
  sees them — independent of `--mask-secrets`; that flag adds Flecto's own
  value-shaped detection on top, for credentials Terraform did not mark.
  `--format human|json|ndjson|github-annotations|pr-comment`, `--ignore`,
  `--policies` (default `terraform`), `--plugins`, and `--fail-on` (default
  `error`, not `changed` — a plan is supposed to contain changes) all work as
  they do elsewhere. Ships with a new `terraform` policy pack, loaded by
  default: a resource replaced or a stateful resource destroyed, security-group
  ingress opened to `0.0.0.0/0` / `::/0`, an IAM policy granting a wildcard
  `Action`/`Resource`, an S3 public-access-block disabled or a public ACL, an
  instance-size change, a capacity setting jumping 2x or more, any
  Terraform-sensitive value changing, and a credential-shaped value Terraform
  did not mark sensitive. See [docs/terraform.md](docs/terraform.md). ([#73])

### Changed

- `flecto init` no longer claims to have initialized a config when one already
  exists. It now checks every `.flectorc` candidate — not just
  `.flectorc.json` — and warns that the existing file was left unchanged instead
  of writing a second config that `loadRcConfig` would shadow. ([#72])
- Policy packs are now cached across a run instead of being re-resolved,
  re-parsed, and re-validated on every file (`ci`) or every change event
  (`watch`). The cache key is the working directory, the resolved pack path,
  and that file's mtime, so a `policies/<id>.json` edited mid-`watch` is picked
  up on the very next change event rather than served stale — watch mode's
  fail-closed behavior on a bad pack edit is unchanged, and per-profile
  `severityRemap` still applies after the cache, so one profile's remap can
  never leak into another's findings. `matchClause()` also compiles each
  rule's `match.path` and `afterMatches` regular expressions once at pack-load
  time instead of once per change event. Measured with `npm run bench`: the
  policy phase of the in-process pipeline at 1,000 files drops by roughly 60%
  (median across two 15-run sessions: ~38 ms to ~15 ms); end-to-end `flecto ci`
  wall time improves more modestly and closer to the harness's documented ±10%
  run-to-run noise. See [docs/performance.md](docs/performance.md).
  ([#92], [#93]) ([#108])

### Fixed

- **SOPS protections no longer disengage on multi-document YAML.** Multi-document
  files ([#69]) wrap each document in a synthetic identity-keyed object, so a
  `sops` metadata block sits one level below the root — and `encryptionState` /
  `normalizeEncrypted` looked only at the root. Every SOPS protection silently
  switched off on exactly the file shape Kubernetes secrets ship in: the
  plaintext of a value that had just been decrypted was printed verbatim (with
  `--mask-secrets` on as well as off), no `sops` or `default` pack rule could
  fire, and a recipient inserted at the front of a document's key list read as
  "every recipient changed". A pull request that added an attacker's decryption
  key *and* committed a secret in the clear passed `--fail-on policy,error`
  while printing the secret into the CI log. Encryption state is now determined
  per document, `sops` pack rules match a document-prefixed path, and recipient
  groups inside a document are re-keyed by identity exactly as they are at the
  root. Ciphertext itself never leaked — `redactCiphertext` always walked the
  whole tree — and single-document behaviour is byte-for-byte unchanged.
  ([#109])
- **`--mask-secrets` no longer masks every value in a document whose resource
  name looks secret-shaped.** Secret-name matching ran against the whole diff
  path, and a multi-document path begins with the document's identity, so any
  resource whose kind or name contained `secret`, `token`, `password`,
  `api_key`, `private_key`, or `credential` — every `kind: Secret`, and any
  Deployment called something like `token-service` — had all of its values
  replaced by `***`, numbers and booleans included. A reviewer could not see
  that `replicas` went 2 → 9 or that `privileged` went false → true, and policy
  messages interpolating those values degraded to nonsense. The parser now
  records the keys it invented for a multi-document file and the renderers match
  secret names against the path *below* that prefix: a resource name is user
  data and never participates. Genuinely sensitive keys inside a document —
  `data.password`, `stringData.token` — are masked exactly as before. Snapshots
  of multi-document files record their document keys so `flecto report` and
  `flecto history` mask correctly too; snapshots of ordinary files are
  unchanged. ([#110])
- Policy finding messages no longer bypass secret masking. `evaluatePolicies`
  runs on unmasked events, so a pack rule whose `messageTemplate` interpolates
  `{before}` / `{after}` could print a credential that `--mask-secrets` had
  redacted from `changes` — across the terminal, webhooks, CI JSON, GitHub
  annotations, and the PR comment. Interpolated values are now masked with the
  same path-aware logic as change events. ([#88])
- **Unknown `--fail-on` triggers are rejected instead of silently ignored.** A
  typo such as `--fail-on polciy,eror` previously matched nothing, so the run
  exited `0` with a real diff present and the CI gate was effectively absent.
  Unknown triggers now fail with the list of valid ones. ([#97])
- YAML and TOML scalars are normalized to a JSON-safe tree before they reach
  snapshots, the differ, or renderers — dates, BigInts, non-finite numbers, and
  objects carrying a `toJSON()`. Previously these could diff or serialize
  inconsistently depending on which parser produced them. Existing snapshots
  are unaffected: `JSON.stringify` already wrote these as strings, so this makes
  the in-memory tree match what was always on disk. ([#94])
- Top-level `include` patterns are merged with `files` instead of being dropped
  whenever `files` was also present in `.flectorc`. ([#95])
- `--on-alert-failure exit` now terminates watch mode. It reported the failure
  but left the watcher running, so a build depending on it to stop never did.
  ([#96])
- `flecto watch` no longer misses changes when a file's valid JSON root is
  `null`. The baseline was treated as absent rather than as the value `null`,
  so the first real change after it went unreported. ([#98])
- `flecto watch --snapshot` no longer degrades quadratically with the number of
  tracked files. Deciding whether a file already had snapshot history listed the
  whole `.flecto-snapshots/` directory once per file — and compiled a regular
  expression once per directory entry — so re-snapshotting a repo cost N
  listings of O(N) entries. The directory is now listed once per run. Measured
  on 1,000 tracked files, re-snapshotting went from 2,229 ms to 546 ms (~4x);
  the first snapshot of a repo, which never took this path, is unchanged.
  ([#78])
- `flecto ci --snapshot-ref <git-ref>` now resolves the baseline correctly when
  run from a subdirectory of the repository. `git show <rev>:<path>` resolves
  `<path>` from the repository root, so the previous cwd-relative path failed
  outside the repo root — a common setup in monorepos. Paths are also
  canonicalized before comparison, fixing baseline resolution under symlinked
  directories such as macOS `/tmp` and `/var/folders`. ([#79])
- `--mask-secrets` now redacts nested secret values in terminal output
  (`watch` and `watch --diff`), matching the masking already applied to
  webhook/CI payloads. Previously a change on a benign-looking path such as
  `database` printed its `password` / `api_key` children in the clear.
  ([#24])
- A YAML file with a self-referential anchor (`a: &x\n  b: *x`) no longer
  fails to parse. js-yaml resolves such an alias to the same object it
  anchors, producing a genuinely cyclic tree; scalar normalization walked it
  and overflowed the call stack (`Maximum call stack size exceeded`) before
  the file could load at all — a bare `Parse error`, not a crash. Cyclic
  back-references now normalize to a fixed `"<circular>"` sentinel, so the
  rest of the file parses, snapshots, and diffs normally, two files with the
  same cycle shape compare equal, and merge keys (`<<: *base`), which resolve
  to an ordinary acyclic tree, are unaffected. ([#103]) ([#107])

## [2.1.0] - 2026-07-24

### Added

- Default-on array identity matching with auto-detect of unique `id`, then
  `name`. Escape hatch: `--no-array-id` or `"arrayId": false` in `.flectorc`.
  Custom keys still work via `--array-id-key`. ([#6])
- `flecto history` for local snapshot drift baselines (`--limit`). ([#7])
- Richer declarative policy predicates: `beforeEquals`, `beforeIn` / `afterIn`,
  `beforeTruthy` / `afterTruthy`, `afterMatches`, `numericDelta`,
  `match.pathEquals` / `match.pathPrefix`, and `allOf` / `anyOf`. ([#34])
- Built-in `compose` and `node-runtime` policy packs. ([#8])
- JSON Schema + load-time validation for policy packs
  (`schemas/flecto-policy-pack-2.0.json`). ([#36])
- `flecto policies list` (+ `--json`) for pack discovery. ([#37])
- `flecto policies test <fixtureDir>` fixture harness for packs/plugins. ([#38])
- Per-profile `severityRemap` to raise, lower, or silence pack rules without
  forking. ([#39])
- Reusable GitHub Action wrapper for `flecto ci`
  (`.github/actions/flecto-ci`). ([#9])
- Policy pack + plugin authoring guides, cookbook, and examples. ([#32], [#35])
- `CHANGELOG.md` with v2.1 migration notes. ([#33])

### Changed

- Node.js requirement raised to **>=20.19.0** (matches chokidar 5). CI matrix
  is 20/22/24; publish uses Node 22. ([#22], [#27])
- `flecto ci` and `flecto watch --snapshot` fail closed when every target is
  missing or unsupported. Pass `--allow-empty` to permit an empty run.
  ([#20], [#29], [#40])
- Only options explicitly set on the CLI override `.flectorc` profiles
  (Commander defaults no longer wipe profile settings). ([#19], [#31])
- Watch mode fails closed on policy pack/plugin load or evaluation errors,
  independent of `--on-alert-failure`. ([#25])
- Secret masking recursively redacts nested secret values when enabled. ([#24])
- Dangerous-toggle rules treat stringy truthy values (`true` / `1` / `yes`) as
  enabled, so `.env` / INI configs are covered. ([#23])

### Fixed

- `arrayIgnoreOrder` no longer false-positives on object key order or throws on
  non-JSON values such as `undefined`. ([#21])
- `fireAlerts` preserves its `{ ok }` result and surfaces queue errors; watch
  consumes rejected alert handlers safely. ([#26])
- GitHub annotation output escapes `%`, newlines, commas, and colons per
  workflow-command rules. ([#28])
- Removed leftover `.sentinel-snapshots/` gitignore entry. ([#30])

### Migration notes

- **Array identity is on by default.** Diff paths may change from index-based
  (`services[0].…`) to identity-based (`services["api"].…`). Review snapshots,
  CI baselines, and any automation that consumes diff paths before upgrading.
- To keep 2.0-style index-based array diffs: `--no-array-id` or
  `"arrayId": false` in `.flectorc`.
- **Node 18 is no longer supported.** Use Node.js 20.19.0 or newer.
- Recursive masking only affects output when secret masking is enabled, but
  nested secret values previously visible in terminal/webhook payloads are now
  redacted.
- `.flectorc` profile settings (for example `mode`, `failOn`, `format`) now
  apply when you omit the corresponding CLI flags.
- Misconfigured policy packs/plugins cause `watch` to exit non-zero instead of
  continuing with no policies.

[Unreleased]: https://github.com/myselfsiddharth/Flecto/compare/v3.0.1...HEAD
[3.0.1]: https://github.com/myselfsiddharth/Flecto/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/myselfsiddharth/Flecto/compare/v2.1.0...v3.0.0
[2.1.0]: https://github.com/myselfsiddharth/Flecto/compare/v2.0.0...v2.1.0
[#6]: https://github.com/myselfsiddharth/Flecto/issues/6
[#7]: https://github.com/myselfsiddharth/Flecto/issues/7
[#8]: https://github.com/myselfsiddharth/Flecto/issues/8
[#9]: https://github.com/myselfsiddharth/Flecto/issues/9
[#19]: https://github.com/myselfsiddharth/Flecto/issues/19
[#20]: https://github.com/myselfsiddharth/Flecto/issues/20
[#21]: https://github.com/myselfsiddharth/Flecto/issues/21
[#22]: https://github.com/myselfsiddharth/Flecto/issues/22
[#23]: https://github.com/myselfsiddharth/Flecto/issues/23
[#24]: https://github.com/myselfsiddharth/Flecto/issues/24
[#25]: https://github.com/myselfsiddharth/Flecto/issues/25
[#26]: https://github.com/myselfsiddharth/Flecto/issues/26
[#27]: https://github.com/myselfsiddharth/Flecto/issues/27
[#28]: https://github.com/myselfsiddharth/Flecto/issues/28
[#29]: https://github.com/myselfsiddharth/Flecto/issues/29
[#30]: https://github.com/myselfsiddharth/Flecto/issues/30
[#31]: https://github.com/myselfsiddharth/Flecto/issues/31
[#32]: https://github.com/myselfsiddharth/Flecto/issues/32
[#33]: https://github.com/myselfsiddharth/Flecto/issues/33
[#34]: https://github.com/myselfsiddharth/Flecto/issues/34
[#35]: https://github.com/myselfsiddharth/Flecto/issues/35
[#36]: https://github.com/myselfsiddharth/Flecto/issues/36
[#37]: https://github.com/myselfsiddharth/Flecto/issues/37
[#38]: https://github.com/myselfsiddharth/Flecto/issues/38
[#39]: https://github.com/myselfsiddharth/Flecto/issues/39
[#40]: https://github.com/myselfsiddharth/Flecto/pull/40
[#66]: https://github.com/myselfsiddharth/Flecto/issues/66
[#67]: https://github.com/myselfsiddharth/Flecto/issues/67
[#68]: https://github.com/myselfsiddharth/Flecto/issues/68
[#69]: https://github.com/myselfsiddharth/Flecto/issues/69
[#70]: https://github.com/myselfsiddharth/Flecto/issues/70
[#71]: https://github.com/myselfsiddharth/Flecto/issues/71
[#72]: https://github.com/myselfsiddharth/Flecto/issues/72
[#73]: https://github.com/myselfsiddharth/Flecto/issues/73
[#74]: https://github.com/myselfsiddharth/Flecto/issues/74
[#75]: https://github.com/myselfsiddharth/Flecto/issues/75
[#76]: https://github.com/myselfsiddharth/Flecto/issues/76
[#77]: https://github.com/myselfsiddharth/Flecto/issues/77
[#78]: https://github.com/myselfsiddharth/Flecto/issues/78
[#79]: https://github.com/myselfsiddharth/Flecto/issues/79
[#88]: https://github.com/myselfsiddharth/Flecto/issues/88
[#92]: https://github.com/myselfsiddharth/Flecto/issues/92
[#93]: https://github.com/myselfsiddharth/Flecto/issues/93
[#94]: https://github.com/myselfsiddharth/Flecto/issues/94
[#95]: https://github.com/myselfsiddharth/Flecto/issues/95
[#96]: https://github.com/myselfsiddharth/Flecto/issues/96
[#97]: https://github.com/myselfsiddharth/Flecto/issues/97
[#98]: https://github.com/myselfsiddharth/Flecto/issues/98
[#103]: https://github.com/myselfsiddharth/Flecto/issues/103
[#104]: https://github.com/myselfsiddharth/Flecto/issues/104
[#107]: https://github.com/myselfsiddharth/Flecto/pull/107
[#108]: https://github.com/myselfsiddharth/Flecto/pull/108
[#109]: https://github.com/myselfsiddharth/Flecto/issues/109
[#110]: https://github.com/myselfsiddharth/Flecto/issues/110
[#123]: https://github.com/myselfsiddharth/Flecto/issues/123

[#124]: https://github.com/myselfsiddharth/Flecto/issues/124

[#113]: https://github.com/myselfsiddharth/Flecto/issues/113

[#114]: https://github.com/myselfsiddharth/Flecto/issues/114
[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[Semantic Versioning]: https://semver.org/spec/v2.0.0.html
[GHSA-wq8m-fc3q-8m5x]: https://github.com/myselfsiddharth/Flecto/security/advisories/GHSA-wq8m-fc3q-8m5x
