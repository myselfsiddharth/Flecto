# Changelog

All notable changes to Flecto will be documented in this file.

The format is based on [Keep a Changelog], and this project adheres to
[Semantic Versioning].

## [Unreleased]

### Changed

- `flecto ci` and `flecto watch --snapshot` now fail closed when every target
  is missing or unsupported. Pass `--allow-empty` to explicitly permit an
  empty run. ([#20], [#29], [#40])

### Planned for 2.1

- Array identity matching will be enabled by default, automatically using
  common item keys such as `id` and `name` when available. This is tracked in
  [#6] and is not yet included in a release.
- Recursive secret masking will redact sensitive nested values whenever
  masking is enabled. ([#24])
- Profile configuration will take precedence over Commander defaults as
  documented: `--profile` > `FLECTO_PROFILE` > defaults. ([#19])

### Migration notes for 2.1

- Array diffs may change from positional (index-based) paths to identity-based
  paths after [#6] ships. Review snapshots, CI baselines, and any automation
  that consumes diff paths before upgrading.
- To retain 1.x/2.0-style index-based array diffs, use `--no-array-id` or set
  `"arrayId": false` in `.flectorc`. These escape hatches ship with [#6]; they
  are not available until that work is released.
- Recursive masking will affect only output produced with secret masking
  enabled, but may replace nested values previously visible in terminal and
  webhook payloads.
- The profile precedence correction makes `.flectorc` profile settings apply
  where Commander defaults previously overrode them.

[Unreleased]: https://github.com/myselfsiddharth/Flecto/compare/v2.0.0...HEAD
[#6]: https://github.com/myselfsiddharth/Flecto/issues/6
[#19]: https://github.com/myselfsiddharth/Flecto/issues/19
[#20]: https://github.com/myselfsiddharth/Flecto/issues/20
[#24]: https://github.com/myselfsiddharth/Flecto/issues/24
[#29]: https://github.com/myselfsiddharth/Flecto/issues/29
[#40]: https://github.com/myselfsiddharth/Flecto/pull/40
[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[Semantic Versioning]: https://semver.org/spec/v2.0.0.html
