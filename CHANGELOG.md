# Changelog

All notable changes to Flecto will be documented in this file.

The format is based on [Keep a Changelog], and this project adheres to
[Semantic Versioning].

## [Unreleased]

### Added

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

### Changed

- `flecto init` no longer claims to have initialized a config when one already
  exists. It now checks every `.flectorc` candidate — not just
  `.flectorc.json` — and warns that the existing file was left unchanged instead
  of writing a second config that `loadRcConfig` would shadow. ([#72])

### Fixed

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

[Unreleased]: https://github.com/myselfsiddharth/Flecto/compare/v2.1.0...HEAD
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
[#79]: https://github.com/myselfsiddharth/Flecto/issues/79
[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[Semantic Versioning]: https://semver.org/spec/v2.0.0.html
