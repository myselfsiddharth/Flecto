# Decisions

Decisions taken while working the growth plan, with the evidence behind each.
Hard rule 5: any claim about GitHub Marketplace rules, competitor tools, or
platform policy is checked against current official docs, and the source is
recorded here.

---

## D-001 — The wedge is Terraform and Kubernetes risk review on pull requests

**Date:** 2026-09-28 · **Status:** CONFIRMED by the maintainer

See [`positioning.md`](positioning.md) for the pitch, two alternatives, and the
reasoning. The primary pitch was chosen. `package.json` `description` and
`keywords` are updated; repo About and the README H1 follow in Phase 3.

---

## D-002 — Actions are pinned to `v4.0.0`, not `@main`

**Date:** 2026-09-28 · **Status:** done

`@main` is whatever was pushed last. For a step that decides whether a build
passes, that is an unacceptable contract, and Flecto's own `github-actions` pack
flags exactly this pattern in other people's workflows — the README was
recommending what the product warns about.

Docs now show three levels: the `v4.0.0` tag (default), an exact
`flecto-version`, and a commit SHA for security-sensitive users.

---

## D-003 — Prefer the immutable `v4.0.0` tag over a moving `v4` tag

**Date:** 2026-09-28 · **Status:** DECIDED by the maintainer — `@v4.0.0` only

The plan suggested `@v4`. **No `v4` tag exists** — `git tag` lists only
`v1.0.1`, `v1.0.2`, `v2.0.0`, `v2.1.0`, `v3.0.0`, `v3.0.1`, `v3.0.2`, `v3.1.0`,
`v4.0.0`. Writing `@v4` into the README would have shipped a **broken example**,
which is worse for trust than a verbose one, and creating the tag is a tagging
action that hard rule 6 reserves for the maintainer.

`@v4.0.0` works today, is immutable, and is the better security posture anyway.

**Trade-off, accepted knowingly:** the Actions ecosystem convention is a moving
major tag, and users expect `@v4` to keep receiving fixes without a PR. With
`@v4.0.0` they must bump manually. The maintainer chose the immutable tag anyway,
which is the right call for a tool whose job is gating merges — and it is
consistent with the SHA-pinning advice the docs now give.

If Phase 2 creates a standalone action repo, moving tags become the norm there
and this should be revisited for that repo specifically.

### Consequence found after 4.1.0 shipped

Pinning the docs to `@v4.0.0` was right at the time — it was the only tag, and it
beat `@main`. But **the Action fix shipped in 4.1.0, after that tag**, so between
#195 merging and 4.1.0 releasing, every documented example pointed at a tag whose
bundled Actions install `flecto@3`. Tags are immutable, so `@v4.0.0` carries the
vulnerable Action metadata permanently.

Docs now pin `@v4.1.0`, `ci.md` carries a warning against `@v4.0.0`, and
`RELEASE.md` gained a step that bumps the documented Action pins as part of every
release. That step is the actual fix: the bug was not the pin, it was that
nothing tied the documented pin to the release that fixed what it pointed at.

The general shape is the one this project keeps meeting — a fix that lands in the
code but not in what users are told to run. It is the same failure as D-004
itself, one level up.

---

## D-004 — Both bundled Actions must install Flecto 4 or newer

**Date:** 2026-09-28 · **Status:** done — this was a live security bug

`flecto-ci` hardcoded `npx --yes flecto@3`; `flecto-pr-risk` defaulted
`flecto-version: "3"`. Both were shipping the pre-4.0 CLI after 4.0.0 released.

**Verified, not assumed.** `npm pack flecto@3` resolves to `3.1.0`, and
`grep -c "snapshot-file" package/index.js` on the unpacked tarball returns `0`.
So:

1. `flecto-ci`'s advertised `snapshot-file:` input passed a flag that does not
   exist in the CLI it installed — a hard failure for anyone using it.
2. `flecto-ci`'s default `snapshot-ref: HEAD~1` against a 3.x CLI reproduces the
   bypass described in [`migrating-to-4.md`](migrating-to-4.md) §2: a pull
   request commits a file named `HEAD~1`, the CLI reads the file instead of the
   revision, the file is written to match the hostile tip, the diff is genuinely
   empty, and — quoting the migration guide — "**no `--fail-on` value caught
   it**". The Actions were vulnerable by default in the release that fixed the
   vulnerability.

The version floor is therefore a security control, not a compatibility
preference, and both input descriptions now say so. `flecto-ci` gained a
`flecto-version` input so it can be pinned without forking, matching
`flecto-pr-risk`.

**Follow-up for the maintainer:** users who copied the previous README are
running `@main` against a 3.x CLI right now. This is worth a line in the next
release's notes, and possibly a `4.0.1`. It is not a new advisory — the CLI
vulnerability is already covered — but the shipped Action's exposure to it was
not called out anywhere.

---

## D-005 — Secret-scanning alert 1 is a test fixture, resolved as such

**Date:** 2026-09-28 · **Status:** code already correct; alert dismissal blocked

The alert flags `AIzaSy` + `1234567890abcdefghijklmnopqrstuv` at
`test/classify.test.js:45`, commit `e9aa6c5`, and is marked publicly leaked.

Read the historical blob before judging it. It is a fixture in a test named
"it may only add detections, never remove one", asserting that
`detectSecretKind()` returns `google-api-key` for that shape — listed alongside
`AKIAIOSFODNN7EXAMPLE` (AWS's own documented example key) and
`postgres://user:hunter2@...`. It was never a credential, and there is nothing
to revoke.

The source-level fix is **already in HEAD**: the test consolidated into
`test/secrets.test.js`, where the same coverage is kept as
`token('AIza', 'SyB1cD3fG7hJ9kL2mN4pQ6rS8tU0vW1xY2z')` — the literal split so
scanners cannot match it. Coverage was verified retained
(`src/secrets.js` still carries the `google-api-key` pattern).

Only the historical alert remains, and `used_in_tests` is the correct
resolution. The API write was denied by the sandbox; the maintainer can dismiss
it in one click with that reason.

---

## D-006 — No code-scanning analysis is configured

**Date:** 2026-09-28 · **Status:** observation, recommend acting in Phase 6

`GET /code-scanning/alerts` returns `404 no analysis found`. The plan read the
Security tab as having unresolved alerts; the more useful finding is that **one
of its three columns is not switched on**.

Zero alerts because nothing ran is not the same as zero alerts because the code
is clean, and for a security tool the distinction is the whole point. Enabling
CodeQL for JavaScript is a few lines of workflow and turns the Security tab into
a trust signal instead of an empty room.

**Done**, in #195: `.github/workflows/codeql.yml`, `security-extended` rather
than the default pack (Flecto parses untrusted config from pull requests, so the
extra path-traversal, injection, and regex queries are the ones most likely to
say something real), least-privilege permissions — `security-events: write`,
`contents: read`, no write to contents, because a query pack is third-party code
— and a weekly schedule set off the hour.

Verified `github/codeql-action@v4` is a real major tag before using it
(`git ls-remote --tags` shows v1 through v4), and bumped the one-major-behind
`upload-sarif@v3` in `ci.md` to `@v4` while there.

**First run: 0 alerts**, in 56s on the #195 merge ref. That is now a meaningful
zero rather than an absent one, which was the entire point.

---

## D-007 — Marketplace requirements, verified

**Date:** 2026-09-28 · **Status:** verified against GitHub's current docs

Hard rule 5. Source:
[Publishing actions in GitHub Marketplace](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace)
and
[Metadata syntax for GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax).

**The plan's core assumption is correct.** Quoting the docs:

> Each repository must contain a single action metadata file (`action.yml` or
> `action.yaml`) at the root. Repositories may include other actions metadata
> files in sub-folders, but **they will not be automatically listed in the
> marketplace**.

So Flecto's Actions, living at `.github/actions/flecto-ci/` and
`.github/actions/flecto-pr-risk/`, **cannot be listed as they are**. That
confirms the diagnosis in the plan's section 0 and means a root-level
`action.yml` is genuinely required. Also confirmed:

- The action must be in a **public** repository.
- Publishing requires **two-factor authentication** on the account.
- The `name` in the metadata file must be **globally unique** across
  Marketplace, and cannot collide with a username, organization, or reserved
  GitHub feature name. `Flecto PR risk` and `Flecto CI` both need checking
  against live Marketplace before a listing attempt.
- A listing takes a **primary category** and an optional second one. The docs
  do not enumerate the categories, so the actual list has to be read off the
  listing form rather than promised in advance.

**One plan claim is wrong.** The plan says a branding icon and colour are
"required for Marketplace". They are not — `branding` is documented as
**Optional**: "You can use a color and Feather icon to create a badge to
personalize and distinguish your action." Badges show next to the action name in
Marketplace, so branding is worth adding for presentation, but it is not a
publishing requirement and nothing is blocked on choosing one. Valid colours are
`white`, `black`, `yellow`, `blue`, `green`, `orange`, `red`, `purple`,
`gray-dark`; the icon must be a Feather icon (v4.28.0 set).

### Found at publish time: the description has a 125-character limit

**Not in the metadata-syntax docs**, and nothing in the repo checked it. v4.1.0
shipped a 194-character description and the Marketplace publish form refused the
listing, which cost a patch release.

The limit is **under 125 characters**. The description is now 119, and a test
pins it — the failure is otherwise invisible until someone tries to publish, and
by then the release is already cut.

The longer half of the pitch ("never runs terraform, helm, or sops, and never
decrypts") moved to the README, which has room for it.

This is a third instance of the pattern this project keeps meeting: a constraint
that only bites at the boundary, with nothing in CI standing in for the boundary.
The fix is the same each time — encode the constraint as a test.

**Still open: which repository hosts the root `action.yml`.** Two viable shapes,
and this needs the maintainer because creating a repository is hard rule 6.
Recorded in the growth log; not decided here.

---

## D-008 — `terraform-plan` is an input on the existing Action, not a new one

**Date:** 2026-09-28 · **Status:** done

Phase 2 asks for Terraform to be a first-class input so the setup fits in about
ten lines. Implemented on `flecto-pr-risk` rather than as a separate Action,
because the posting, masking, token, and fork-detection logic is already there
and worth reusing rather than duplicating.

The wiring is not a thin pass-through, for two reasons found by reading the CLI:

1. **`flecto plan` is a different subcommand from `flecto ci`**, and takes the
   plan file directly. It has no `--snapshot-ref` at all: a plan JSON already
   contains before and after, so there is nothing to diff against.
2. **The baseline step fails hard when there is no pull request base commit** —
   deliberately, because an unresolvable baseline would report "no changes" and
   pass. That requirement does not apply in plan mode, so the step short-circuits
   when `terraform-plan` is set.

That second point is the risk in this change: a skip that is slightly too broad
silently disables the gate for config mode. Mitigations, both tested:

- The early exit is guarded on `terraform-plan` alone, and a test asserts it sits
  *before* the base-commit check while that check still exists. Verified by
  making the skip unconditional and watching the test fail.
- A missing plan file fails the step rather than letting `flecto plan` read
  nothing, because a gate that passes because it read no input is not a gate.

Verified end to end against `test/fixtures/terraform/destructive.json`: the
Action's own script, with the real CLI substituted for the `npx` install, exits 1
and reports the destroyed `aws_db_instance.main`. Config mode's argv is
byte-for-byte what it was, and config mode with no PR context still exits 1.

`fail-on` keeps this Action's default of `policy,error`, which is stricter than
the CLI's `plan` default of `error`.

---

## D-009 — The root `action.yml` lives in the Flecto repo, not a new one

**Date:** 2026-09-28 · **Status:** DECIDED by the maintainer — Flecto repo root

The plan specified a separate `myselfsiddharth/flecto-action` repository. D-007
verified the actual requirement, which is narrower: the metadata file must be at
**a** public repository's root. Flecto's own repository satisfies that, so the
new repo is unnecessary.

Why this is the better shape:

- **Marketplace traffic lands on the main repository** rather than a satellite.
  For a project with 7 stars, splitting discovery across two repos is a real
  cost and there is nothing to gain from it.
- **`README.md` and `LICENSE` already exist**, which the plan listed as work.
- **The `uses:` line gets shorter** — `myselfsiddharth/Flecto@vX.Y.Z` instead of
  `myselfsiddharth/Flecto/.github/actions/flecto-pr-risk@vX.Y.Z`.
- One repository, one release process, one set of tags.

**The cost, stated plainly:** only one action per repository can be listed, so
`flecto-ci` will not appear on Marketplace. That is the right trade — `pr-risk`
is the wedge, and `flecto-ci` is the lower-level tool for people who have already
decided to adopt.

### Why the logic is duplicated rather than shared

`.github/actions/flecto-pr-risk/action.yml` stays, so nobody referencing that
path breaks (hard rule 4). Its `runs:` block is byte-identical to the root one,
enforced by a test, so a fix applied to one file and not the other is a CI
failure rather than a silent divergence between the listed action and the
documented one.

Three ways to avoid the duplication were considered and rejected:

1. **`uses: ./.github/actions/flecto-pr-risk`** — a relative `uses:` inside a
   composite action resolves against the *consumer's* workspace, not the action's
   repository, so this does not work.
2. **`uses: $/.github/actions/flecto-pr-risk`** — the self-repository syntax.
   It is real and documented, but **"The `$/` syntax is not available in GitHub
   Enterprise Server"**, and the docs do not confirm it inside composite actions.
   Not a bet worth taking on a step whose job is deciding whether a merge is
   safe.
3. **Self-reference by pinned tag** (`myselfsiddharth/Flecto@vX.Y.Z`) — works for
   released tags but not on `main` before the tag exists, and adds a bump ritual
   at every release.

**The follow-up worth doing later:** move the shell into a script invoked through
`$GITHUB_ACTION_PATH`, which both files can share and which works on GHES. It
was not done here because it restructures baseline resolution — the part that
decides whether a risky change is caught — and that does not belong in the same
change as a Marketplace listing.

---

## Verifications still owed

- **Marketplace category list** — read off the listing form when creating it.
  The docs do not enumerate them.
- **`name` uniqueness** — check `Flecto PR risk` / `Flecto CI` against live
  Marketplace before attempting a listing.
## D-010 — Competitor claims in `comparison.md`, verified

**Date:** 2026-09-29 · **Status:** verified; sources listed in the page itself

Hard rule 5 discharged for Phase 3's comparison page. Each tool was read at its
own current documentation, not from memory, and
[`comparison.md`](comparison.md) carries the source links inline.

What the reading changed about the page:

- **Checkov ships "more than 750 predefined policies."** Flecto's `terraform` and
  `kubernetes` packs have **10 each** — confirmed with `flecto policies list`.
  That is roughly two orders of magnitude, and the page says so in those words
  rather than hedging. Flecto must never be marketed as a policy library.
- **tfsec is *not* deprecated or archived**, which is the common assumption and
  would have been wrong to write. Aqua's notice says efforts are consolidating
  into Trivy and tfsec "will continue to remain available", with a migration
  guide and **no sunset date**. The page says to compare against Trivy instead,
  without claiming tfsec is dead.
- **Trivy does support plan JSON** (HCL, plan snapshot, and plan JSON), so
  "Flecto reads plans and Trivy doesn't" would have been false. The distinction
  is state versus change, not format support.
- **conftest ships no policies** — Rego is unlimited but you write it. That is
  the honest axis: expressiveness versus working out of the box.
- **tf-summarize has *better* plan presentation** than Flecto (tree, 2D-tree,
  HTML; Flecto has one table) and makes no risk judgement. Both halves are in
  the page.
- **dyff is purely a diff** with no policy, gating, or PR comment, and its
  `kubectl diff` integration is a user-configured workflow rather than a feature.

The page opens by saying Flecto is **not** a replacement for Checkov or Trivy and
recommends running both, because that is true and because a comparison page that
only flatters its subject does not get believed. It also lists where Flecto is
weakest, including that a diff reporter is blind to pre-existing problems.

`bridgecrewio/checkov-action@v12` in the recommended-setup snippet was checked
against the action's tags rather than guessed.

---

## Verifications still owed

- Nothing outstanding for Phase 3's comparison page.
