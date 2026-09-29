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

Not done here: adding a workflow that runs on every push is a change to CI
behaviour and belongs in its own PR with the maintainer's agreement, and the
plan's Phase 1 scope is fixing trust signals rather than adding pipelines.

---

## Verifications still owed

Recorded so Phase 2 does not proceed on assumption. Hard rule 5 applies to each.

- **Marketplace metadata location.** Phase 2 assumes a listed action needs
  `action.yml` at the root of a public repo, which is why a standalone
  `flecto-action` repo is proposed. **Not yet verified against GitHub's current
  docs** — this session did no web lookups. Verify before creating any repo,
  because if subfolder actions can now be listed, the whole standalone-repo step
  is unnecessary and the Actions stay where they are.
- **Marketplace category list.** The plan proposes "Code review" or "Security".
  Confirm both exist as categories before writing the listing.
- **Competitor claims** for `comparison.md` (Phase 3): every statement about
  Checkov, Trivy/tfsec, conftest/OPA, tf-summarize, and dyff gets checked against
  that tool's current docs, with the source recorded here.
