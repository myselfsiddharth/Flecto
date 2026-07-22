# Flecto Roadmap

This document tracks planned milestones for Flecto. The current shipped release is
**v2.0** (policy-native config ops: declarative packs, local plugins, richer CI
annotations, envelope `schema_version: "2.0"`).

The next milestone is **v2.1 — "History & Insight"**.

---

## Milestone: v2.1 — History & Insight

**Theme:** Make config drift *observable over time* and make risky changes *impossible
to miss*, without asking teams to change their stack.

**Goals**

1. Give Flecto a memory: track how a config evolved, not just the latest change.
2. Ship more risk coverage out of the box (stack-aware policy packs).
3. Reduce integration friction (native chat alerts, ad-hoc diffs, typed API).
4. Harden the current v2.0 surface (performance, portability, docs).

Features are grouped as **Must / Should / Could** using MoSCoW so scope can flex
without losing the milestone's intent.

---

### Must-have features

#### 1. `flecto history` — local drift timeline
Persist an append-only, content-addressed history of each watched file under
`.flecto-history/` so teams can answer "when did this change and what was it before?"
offline.

- `flecto history <file>` — list recorded revisions (timestamp, change summary, id).
- `flecto history <file> --since <rev|time>` — semantic diff across a time range.
- `flecto history <file> --show <id>` — full state at a revision.
- Watch mode records a revision on every applied change (opt-out via `--no-history`).

*Rationale:* directly delivers the "historical drift / local baselines" item from
`pitch.md`, and complements the existing single-shot snapshot model in `index.js`.

**Acceptance:** recording a series of edits produces an ordered, replayable timeline;
`--since HEAD~n`-style range diffs match `diffTrees` output; history is prunable and
size-bounded.

#### 2. Stack-aware built-in policy packs
Grow `src/packs/` beyond `default` and `strict-prod` with curated packs and
auto-detection by file shape/name.

- New packs: `kubernetes`, `nginx`, `postgres`, `docker-compose`, `dotenv-prod`.
- `flecto watch --policies auto` detects likely stack and loads matching packs.
- `flecto policies list` / `flecto policies show <id>` to introspect active rules.

**Acceptance:** each new pack ships with fixtures and tests; `auto` selection is
documented and deterministic; unknown stacks fall back to `default`.

#### 3. `flecto diff <a> <b>` — ad-hoc semantic diff
First-class two-argument semantic diff for any two files or git refs, without needing a
saved snapshot. Reuses `diffTrees` and honors `--ignore`, `--array-id-key`,
`--mask-secrets`, and all output formats.

**Acceptance:** `flecto diff old.yaml new.yaml` and `flecto diff HEAD~1:config.yaml config.yaml`
both work and share exit-code semantics with `ci`.

---

### Should-have features

#### 4. Native chat alert adapters
Built-in Slack / Microsoft Teams / Discord formatters layered on the existing
`alerter.js` webhook path, so users don't hand-craft payloads.

- `--webhook-format slack|teams|discord|raw` (default `raw`, preserving today's behavior).
- Rich message includes change summary + policy severity badges.

#### 5. Structured watch output (`--json` / `--ndjson`)
Emit machine-readable change envelopes from `watch` (not just `ci`) for piping into
log processors and dashboards, reusing `createEnvelope`.

#### 6. TypeScript type definitions
Ship `.d.ts` types for the envelope (`schema_version: "2.0"`) and the plugin
`evaluate(changes, ctx)` contract, so plugin authors get autocomplete and type safety.

---

### Could-have features

#### 7. Live TUI dashboard
`flecto watch --ui` renders a live terminal dashboard summarizing changes and policy
findings across many watched files at once.

#### 8. Remote config sources
Watch/diff configs fetched over HTTP(S) or object storage (e.g. `s3://`) on an
interval, for centrally-managed config.

#### 9. Schema-aware diffs
Optionally validate parsed config against a user-provided JSON Schema and flag
type/shape violations as policy findings.

---

## Improvements to the current v2.0 release

These are hardening and quality-of-life items that ride along with v2.1.

**Performance & correctness**
- Debounce/coalesce rapid multi-file saves to avoid duplicate change batches in `watcher.js`.
- Large-file handling: bound memory and skip re-parsing unchanged files.
- Expand INI/TOML edge-case coverage (comments, quoted keys, nested tables).

**Portability**
- Add Windows + macOS to the CI test matrix (currently Linux Node 18/20/22).
- Windows path-normalization tests for snapshot ids and `git show` refs.

**Reliability**
- `flecto queue` to inspect/drain the at-least-once webhook retry queue (`.flecto-queue/`).
- Exponential backoff with jitter for webhook retries; document dead-letter behavior.

**Developer experience**
- `--quiet` / `--no-color` flags and documented, stable exit codes for scripting.
- Profile inheritance (`extends`) in `.flectorc`.
- Add ESLint + Prettier config and a `lint` script; wire into CI.
- Add test coverage reporting.

**Docs**
- Recipes for GitHub Actions, GitLab CI, and pre-commit gates.
- A "policy authoring" guide for local ESM plugins and custom `policies/<id>.json` packs.

---

## Compatibility & versioning

- v2.1 is **additive and backward compatible**. Existing `.flectorc`, snapshots,
  webhook headers (`X-Flecto-*`), and envelope `schema_version: "2.0"` continue to work.
- New envelope fields (if any) are additive and optional; no breaking schema bump.
- **Default-on array identity matching** and any other breaking changes are deferred to
  a future **v3.0** milestone to keep v2.1 non-breaking.

## Out of scope for v2.1

- A hosted/SaaS backend or persistent server component (Flecto stays a local CLI).
- Editing/rewriting config files (Flecto observes and reports; it does not mutate).
- A v3.0 breaking-change bundle (tracked separately).

## How to contribute to this milestone

Pick an unchecked item, open an issue referencing this milestone, and send a focused PR
with tests (`npm test`) and updated docs. Small, single-feature PRs are preferred over
large bundles.
