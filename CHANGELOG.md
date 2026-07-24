# Changelog

All notable changes to Flecto will be documented in this file.

The format is based on [Keep a Changelog], and this project adheres to
[Semantic Versioning].

## [Unreleased]

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
[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[Semantic Versioning]: https://semver.org/spec/v2.0.0.html
