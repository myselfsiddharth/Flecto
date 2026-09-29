# Growth log

Append-only. Every completed task, with its date and any decision made.

---

## 2026-09-28 — Baseline

Recorded at the start of the growth plan, verified against the live sources
rather than copied from the plan document.

| Metric | Value | Source |
|---|---|---|
| Stars | 7 | `gh repo view` |
| Forks | 1 | `gh repo view` |
| Commits | 125 | `git rev-list --count HEAD` |
| Maintainers | 1 | — |
| npm latest | 4.0.0 | `npm view flecto dist-tags` |
| npm downloads, last 30 days | 281 | `api.npmjs.org` (2026-08-29 to 2026-09-27) |
| Open issues | 6 | all authored by the maintainer |
| Open PRs | 1 | #192, dependabot, dotenv 18.0.1 |
| GitHub Releases | 9, v1.0.1 through v4.0.0 | `gh release list` |
| Estimated real active users | ~0 | 281/month with a release-day spike is mirrors and scanners |

**Corrections to the plan's stated baseline** (section 0 was slightly stale):

- The plan says "about 290 downloads"; the actual last-30-day figure is **281**.
- The plan says the **Releases page is empty** and that this "makes the project
  look abandoned". It is **not empty** — all 9 tags have published releases with
  notes, including "v4.0.0 — Security release". The Phase 1 task to publish
  releases was already done before the plan was written. No work needed.
- The plan says there are **10 items in the Security tab**. Actual: **2**
  Dependabot alerts, both already `fixed`; **0** code-scanning alerts (no
  analysis is configured at all, which is itself worth noting); **1** open
  secret-scanning alert. So one real open item, not ten.

---

## 2026-09-28 — Phase 1

### Done

- **Fixed a live security bug in both bundled Actions** (the highest-value item
  found; not in the plan). `flecto-ci` hardcoded `npx --yes flecto@3` and
  `flecto-pr-risk` defaulted `flecto-version: "3"`, so **both shipped Actions
  installed the pre-4.0 vulnerable CLI line** even though 4.0.0 had been
  released. Two consequences, both verified:
  1. `flecto-ci` advertises a `snapshot-file:` input and passes
     `--snapshot-file`, but that flag **does not exist in 3.x** — confirmed by
     unpacking `flecto@3.1.0`, which contains zero occurrences of the string.
     Anyone using the documented input got a hard commander error.
  2. Worse, `flecto-ci`'s default `snapshot-ref: HEAD~1` against a 3.x CLI **is
     the documented baseline-shadowing bypass** 4.0 closed: a pull request
     commits a file named `HEAD~1`, it is read instead of the revision, the diff
     is empty and the gate passes. The shipped Actions were vulnerable by
     default in the release that fixed the vulnerability.

  Fix: `flecto-ci` gains a `flecto-version` input defaulting to `"4"` (mirroring
  `flecto-pr-risk`, so pinning needs no fork), `flecto-pr-risk`'s default moves
  `"3"` to `"4"`, and both input descriptions say why it must not go below 4.
  See `docs/decisions.md`, D-004.

- **Pinned the Actions.** Every `@main` reference to Flecto's own Actions is now
  `@v4.0.0`, in `README.md`, `docs/ci.md`, and
  `examples/github-action/flecto-pr-risk.yml`. Chose the **existing immutable
  `v4.0.0` tag over a moving `v4` tag** so every copy-pasted example works
  today; a moving `v4` tag needs a tag push, which is the maintainer's call
  (D-003). The one remaining `@main` in the repo is
  `examples/fixtures/policies/github-actions/current.yml`, which is the fixture
  that *demonstrates* the unpinned-action finding and must stay.

- **Rewrote the pinning docs** (`docs/ci.md`) with three explicit levels — tag,
  exact `flecto-version`, and SHA — recommending SHA pinning for
  security-sensitive users, with the `git ls-remote` command to resolve one, plus
  the warning about not setting `flecto-version` below 4.

- **Fixed version drift.** All 7 `npx --yes flecto@3` occurrences are now `@4`,
  across `README.md`, `docs/ci.md` (5), and `docs/terraform.md`. Repo-wide greps
  for `flecto@3` and `actions/flecto-*@main` now come back empty.

- **Added a stability promise.** New `docs/stability.md` (151 lines) and a
  README `## Stability` section. Covers the JSON envelope
  (`schema_version: "2.0"`), the exit codes — verified as **only `0` and `1`**,
  not a wider set — `.flectorc`, and the CLI surface; and states plainly what is
  *not* covered (terminal output, message text, `src/` internals, snapshot
  internals, `FLECTO_*` escape hatches). Documents the deprecation sequence and
  its one exception, security fixes. Includes an honest "track record" table
  about 4.0 in four months rather than asking for trust on a promise.

- **Triaged the Security tab.** Both Dependabot alerts (js-yaml quadratic-CPU
  DoS, high and medium) are already `fixed`. The open secret-scanning alert is a
  **synthetic test fixture, not a live credential**: the literal
  `AIzaSy` + `1234567890abcdefghijklmnopqrstuv` in the historical
  `test/classify.test.js`, asserting `detectSecretKind()` classifies the
  `google-api-key` shape, sitting next to AWS's own documented
  `AKIAIOSFODNN7EXAMPLE` and `hunter2`. Nothing to revoke. HEAD no longer
  contains it — the test moved to `test/secrets.test.js`, where the same
  coverage is kept with the literal split as `token('AIza', ...)` so scanners
  do not match it. **The fix is already in the code; only the historical alert
  needs dismissing**, and that write was blocked by the sandbox. See "Blocked".

- Created `docs/positioning.md` (the wedge, two alternatives, a recommendation,
  and an explicit list of what the wedge must not claim), `docs/decisions.md`,
  `docs/v5-proposals.md`, `growth/metrics.md`, and this log.

### Blocked, needs the maintainer

- **Dismissing secret-scanning alert 1.** The `PATCH` to
  `/secret-scanning/alerts/1` (`resolution: used_in_tests`) was denied by the
  sandbox as an external write. One click, or re-run with permission.
- **Issue and PR triage.** Labelling and commenting are external writes, so the
  six issues and PR #192 have drafted responses in [`triage.md`](triage.md)
  rather than posted ones. All six issues are maintainer-authored,
  so hard rule 6 (do not close issues opened by others) does not bind — but
  posting still needs permission.
- **Confirming the wedge** in `docs/positioning.md`. Phase 2 is gated on it, and
  so are the `package.json` `description`/`keywords` and the repo About, which
  are deliberately left untouched because changing the pitch needs sign-off.
- **A moving `v4` tag**, if wanted (D-003).

### Not done, deliberately

- `package.json` metadata. `homepage`, `repository`, and `bugs` are all correct
  already; `description` and `keywords` are pitch-dependent and held for
  confirmation.
