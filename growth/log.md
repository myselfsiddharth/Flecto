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

### Maintainer decisions taken, 2026-09-28

- **Wedge CONFIRMED** — the primary pitch. `docs/positioning.md` marked
  confirmed; `package.json` `description` and `keywords` updated; repo About and
  topics updated.
- **`@v4.0.0` only** — no moving `v4` tag. Trade-off accepted knowingly
  (D-003): users bump manually, which is unusual for Actions, in exchange for an
  immutable reference. Revisit for the standalone action repo if Phase 2 creates
  one.
- **Ship as one PR** — [#195](https://github.com/myselfsiddharth/Flecto/pull/195).
- **External writes granted**, plus CodeQL and the #192 merge.

### Then done

- **Applied the confirmed pitch.** `package.json` `description` replaced
  ("semantic config watcher that reports meaningful changes in plain English" to
  the wedge pitch, 138 chars). `keywords` re-cut to lead with `terraform`,
  `terraform-plan`, `kubernetes`, `helm`, `pull-request`, `code-review`,
  `policy-as-code`, `github-actions`. Repo About replaced. Topics: dropped
  `cicd`, `diff`, `nodejs`, `drift-detection` (redundant or secondary-feature)
  to make room for `pull-request`, `code-review`, `github-actions`,
  `terraform-plan`, holding at the 20-topic cap.

  Note for Phase 3: GitHub renders topics alphabetically, so "lead with" is
  about which topics exist, not their order. Nothing to tune there.

- **Enabled CodeQL** (`.github/workflows/codeql.yml`), `security-extended`,
  least-privilege permissions, weekly schedule off the hour. Verified
  `github/codeql-action@v4` is a real major tag before using it, and bumped the
  one-major-behind `upload-sarif@v3` in `docs/ci.md` to `@v4` while there.

- **Secret-scanning alert 1 resolved** as `used_in_tests`. The API caps
  `resolution_comment` at 280 characters, which took two attempts to fit.

- **All 6 issues labelled and answered.** Created two labels that did not exist:
  `security` (merge-gate correctness) and `noise` (false positives). Applied
  `security` to #186 and #188, `noise` + `good first issue` to #191,
  `good first issue` to #185. Posted a roll-up on #121 so the security review
  reads as worked rather than stalled, and triage notes on the rest. **#186 got
  an explicit note that #195 does not fix it** — #195 closes a route to an empty
  baseline, not the amplifier.

  `good first issue` count went 0 to 2, against Phase 6's target of 5 to 10.

- **PR #192 (dotenv 18.0.1) verified and commented, not merged.** See
  [`triage.md`](triage.md) for the full check: the only API used is `parse()`,
  and the line regex `src/positions.js` mirrors is byte-identical between 17.4.2
  and 18.0.1, so LSP positions still agree with the parser.

### Still open for the maintainer

- **Approve and merge #192.** All 5 required status checks are green and it is
  `MERGEABLE`, but `main` requires **1 code-owner approving review**. Not
  self-approved: posting an approval as the maintainer is a judgment that is not
  an agent's to fabricate. Repo-wide auto-merge is disabled
  (`enablePullRequestAutoMerge` refused), so `--auto` could not stage it either.
  Two clicks.
- **Review and merge #195.**
- **Decide whether `growth/` belongs in a public repo.** It states "estimated
  real active users: ~0". The plan directs these files into the repo and the
  honesty is consistent with the trust strategy, but it is a judgment call, and
  it is flagged in #195. Phase 4's `targets.md` and `outreach.md` will name
  specific external repos and should almost certainly be gitignored.

### Not done, deliberately

- `package.json` `homepage`, `repository`, and `bugs` were already correct.
- **#186's underlying fix.** Adding `added` to the bundled Action's default
  `fail-on` changes what passes for every existing user. That is a
  security/noise trade-off for the maintainer, not a Phase 1 packaging fix.
- **Phase 2.** Gated on verifying GitHub's current Marketplace requirement that
  a listed action's metadata file sit at a public repo's root. No web lookups
  were made this session, so that claim is unverified and no repo was created.
  See `docs/decisions.md`, "Verifications still owed".
- **Phase 3's README restructure.** The README is 594 lines against a target of
  ~120. Its own gate is maintainer approval of the new structure.
