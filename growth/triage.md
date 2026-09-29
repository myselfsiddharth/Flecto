# Triage — 2026-09-28

Phase 1 asks for every issue and PR to be labelled, answered, closed, or merged.
Posting comments and labels is an external write and was denied by the sandbox,
so these are **drafts for the maintainer to post**, not posted responses.

All six open issues are maintainer-authored, so hard rule 6 ("ask before closing
issues opened by others") does not bind. None of them should be closed anyway —
see below.

## Summary

| # | Title | Verdict | Suggested labels |
|---|---|---|---|
| 192 | bump dotenv 17.4.2 → 18.0.1 | **Merge.** Verified safe, see below | `dependencies` |
| 185 | runCommand treats a signal-killed command as success | Keep open. Smallest real fix here; good first issue | `bug`, `good first issue` |
| 186 | Empty baseline reads as all-`added` | Keep open. **Highest severity open item** | `core`, `security` |
| 188 | `.flectorc` `ignore` silences the merge gate | Keep open. Security, same family as #186 | `core`, `security` |
| 191 | Entropy gate false positives | Keep open. Noise — matters for Phase 4 | `core`, `noise` |
| 194 | Concurrent `watch` double-delivery | Keep open. Lowest priority for the wedge | `core` |
| 121 | Finish the security review | Keep open as the tracking issue | `help wanted`, `core` |

Phase 4 says fix false positives and noise first, because a noisy gate gets
uninstalled. By that rule the order is **#186, #188** (they are correctness of
the gate itself, and the wedge is the gate), then **#191** (noise), then #185,
then #194.

---

## PR #192 — dotenv 17.4.2 → 18.0.1: merge

A major bump on a dependency of a security tool deserves more than a green
checkmark, so this was checked rather than assumed.

**Checks:** green on all six combinations — ubuntu Node 20/22/24, windows Node
24, macos Node 24, plus the security-relevant coverage gate. `mergeable`, state
`BLOCKED` only because `main` is protected.

**API surface actually used:** exactly one call, `dotenv.parse(raw)` in
[`src/parser.js:461`](../src/parser.js#L461). Nothing else imports dotenv.

**The real risk, and why it is clear.** `src/positions.js` deliberately
*mirrors dotenv's internal line regex* so that LSP positions agree with the
parser — its own comment says "verification catches a future dotenv that changes
it". A dotenv major bump is exactly the event that could break that silently.
Extracted both:

```
17.4.2  node_modules/dotenv/lib/main.js
18.0.1  package/dist/index.cjs (minified)
        /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg
```

**Byte-identical**, and identical to `DOTENV_LINE` in `positions.js` apart from
the `d` flag it adds for match indices. The mirror still holds.

**One thing to know, not a blocker.** dotenv 18 restructured to a bundled
`dist/index.cjs` and its `exports` map has **no `import` condition** — only
`require` and `default`, both pointing at CJS. Flecto is `type: module` and does
`import dotenv from 'dotenv'`, which works through Node's CJS interop; the green
tests on Node 20, 22, and 24 confirm it in practice rather than in theory.

**Follow-up after merge:** the comment at
[`src/positions.js:658`](../src/positions.js#L658) cites `dotenv/lib/main.js` as
the source of the mirrored pattern. That path does not exist in 18 — it is
`dist/index.cjs`, minified. Update the reference so the next person can still
find what the mirror is mirroring. Left unedited here because the PR is not
merged yet.

**Suggested comment:**

> Merging. Verified beyond CI, since this is a major bump: the only dotenv API
> Flecto uses is `parse()`, and the line regex that `src/positions.js`
> deliberately mirrors is byte-identical between 17.4.2 and 18.0.1, so LSP
> positions still agree with the parser. Note that 18 moved to a bundled
> `dist/index.cjs` with no `import` condition in `exports` — the ESM import works
> via CJS interop, which the Node 20/22/24 runs confirm. Filing a follow-up to
> fix the `dotenv/lib/main.js` path in the `positions.js` comment, which no
> longer exists upstream.

---

## Issue #186 — empty baseline reads as all-`added`

**This is the most important open issue, and it overlaps work done today.**

The issue notes that the bundled Action defaults to `fail-on: policy,error` —
neither `changed` nor `added` — so under the shipped Action an empty baseline
produces findings and **exit 0** by default.

Today's Phase 1 work changed the same file, `.github/actions/flecto-ci/action.yml`,
to stop installing the pre-4.0 CLI (`docs/decisions.md` D-004). That closes the
*route* where a committed file named `HEAD~1` shadows the revision. **It does not
close this amplifier**, which needs no shadowing at all — a legitimately empty
file at the baseline ref reaches it.

Deliberately not fixed here. Adding `added` to the Action's default `fail-on`
changes what passes for every existing user, which is a judgment call about a
security/noise trade-off that belongs with the maintainer, not a Phase 1
packaging fix. Worth resolving before Phase 4 outreach: it is the one open issue
that makes the wedge's central claim — "blocking the dangerous ones" — not
strictly true in the shipped default configuration.

**Suggested comment:**

> Note for whoever picks this up: #183 and the Action version fix (installing 4.x
> rather than 3.x) close the routes that *reach* an empty baseline by shadowing a
> ref. This amplifier is still open and needs no shadowing — a legitimately empty
> file at the baseline ref is enough. The Action's default `fail-on:
> policy,error` remains the exposed surface.

---

## Issue #188 — `.flectorc` `ignore` silences the merge gate

Same family as #186 and as the 4.0 `snapshotRef` fix: a file inside the pull
request influencing the verdict on that pull request. 4.0 established the
principle — `.flectorc` may not choose the baseline — and `ignore` is the same
principle not yet applied. `docs/stability.md` now states that boundary
explicitly, which makes the inconsistency easier to argue.

Worth noting the fix has a real cost: `ignore` is also the legitimate mechanism
for cutting noise, so refusing it outright trades a bypass for false positives.
Likely answer is to keep `ignore` for presentation but stop it suppressing
`policy`/`error` findings — sizing that is the work.

## Issue #191 — entropy gate false positives

Directly relevant to Phase 4: this is a false-positive class, and Phase 4 says
fix noise first. Google Place IDs and IPFS CIDs are not exotic — they appear in
ordinary app config, which is Flecto's home turf.

It also reads as a **good first issue** if scoped to an allow-list of known
public identifier shapes rather than a rework of the entropy heuristic.

Separately: the docstring in `src/secrets.js` claiming "0 false positives" should
be softened to name its corpus regardless of when the code is fixed. An
overstated measurement in a security tool's own comments is a small trust leak,
and it is a one-line edit.

## Issue #185 — signal-killed command reported as success

Smallest well-specified fix in the list: take the `signal` argument `close`
already provides and treat non-null as failure. The issue includes a measured
reproduction (`kill -9 $$` yields `ok === true`) and names the fix. Strong
**`good first issue`** candidate — label it and it becomes a contribution path,
which Phase 6 wants anyway.

## Issue #194 — concurrent watch double-delivery

Real, well-diagnosed, and the correct fix (a claim step before delivery) is
clear. Lowest priority of the six **for the chosen wedge**: it affects
`flecto watch`'s at-least-once queue, and the wedge is the PR gate. Keep open,
do not spend Phase 1 time on it.

## Issue #121 — finish the security review

The tracking issue the other five descend from. Keep open until #186 and #188
close. Add a checklist comment linking all five so a visitor can see the review
is being worked rather than stalled — this is the issue an evaluator is most
likely to read, and right now it looks open-ended.

---

## Also worth doing

- **Enable CodeQL.** `GET /code-scanning/alerts` returns `404 no analysis found`
  (`docs/decisions.md` D-006). An empty Security tab on a security tool reads as
  "not checked", not "clean".
- **Label `good first issue`.** Phase 6 wants 5–10 at all times; there are
  currently 0. #185 qualifies as-is, #191 does if scoped. That is 2 — the rest
  will have to come from noise reduction found in Phase 4.
