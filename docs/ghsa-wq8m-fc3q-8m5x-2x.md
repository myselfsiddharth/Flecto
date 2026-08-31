# GHSA-wq8m-fc3q-8m5x — 2.x assessment and backport

[GHSA-wq8m-fc3q-8m5x] is the arbitrary-code-execution vulnerability fixed in
3.0.1: a pull request adds a `.flectorc` declaring a `plugins` entry, and
`flecto ci` — the command teams run on pull requests — loads and executes it on
the CI runner with whatever the workflow exposes.

The advisory recorded the affected range as `<= 3.0.0` pending a check of the 2.x
line, because the `plugins` option and its `.flectorc` resolution predate 3.0.0.
This is that check ([#125]).

## What was tested

The proof-of-concept from the advisory, run unchanged against a clean `npm ci`
install of each released version. A `.flectorc` declaring
`plugins: ["./evil-plugin.js"]`, a plugin that writes a marker file, and
`flecto ci config.json --snapshot-ref snap.json` with **no** attacker-controlled
flags. "Vulnerable" means the marker was written.

| Version | `plugins` option exists | Exploit | Notes |
|---|---|---|---|
| 1.0.1 | no | **not exploited** | predates the option |
| 1.0.2 | no | **not exploited** | predates the option |
| 2.0.0 | yes | **VULNERABLE** | rc-declared plugin executes |
| 2.1.0 | yes | **VULNERABLE** | rc-declared plugin executes |
| 3.0.0 | yes | **VULNERABLE** | rc-declared plugin executes |
| 3.0.1 | yes | not exploited | fixed — rc plugins refused |
| `release/2.x` head (2.1.1, unreleased) | yes | not exploited | backport effective |

So the 2.x line **is** affected, from its first release. The suspicion the
advisory recorded is confirmed by a working exploit, which is worth more than the
hypothesis: it also rules 1.x out, since the option did not exist there.

## The fix on 2.x

The backport is already merged on `release/2.x` (commit `3e2bf90`, "fix: refuse
rc-declared policy plugins on 2.x", which raised the branch to **2.1.1**). Tested
on that branch head:

- the exploit above is refused with the same message 3.x gives — plugins are not
  honoured from `.flectorc` without `FLECTO_ALLOW_RC_PLUGINS=1`;
- the path-traversal variant (`plugins: ["../../../../tmp/x.mjs"]`, with the env
  opt-in set) is refused for being outside the project.

**2.1.1 was never tagged or published to npm.** The npm `flecto` versions are
`1.0.0–1.0.2, 2.0.0, 2.1.0, 3.0.0, 3.0.1`; the highest 2.x a user can install is
the still-vulnerable **2.1.0**. The fix exists in git and reaches nobody until it
is released.

## Recommendation

`SECURITY.md` lists 2.x as best-effort — "security fixes may be backported when
practical" — and a critical RCE is the case that policy exists for. The fix is
small, self-contained, and already written. Two maintainer actions remain, both
outside what a pull request to `main` can do:

1. **Tag and publish `flecto@2.1.1`** from `release/2.x`, so 2.x users have a
   fixed version to install rather than only an upgrade to 3.x.
2. **Correct the advisory's affected range and patched versions** (see below).

npm download data informs how much this matters: the whole package saw ~373
downloads in the last month, and the 2.x line specifically registered
essentially none. The exposure is real but small — which argues for publishing
the already-written fix rather than against it, since the cost is a release, not
new engineering.

## Advisory correction

The recorded range `<= 3.0.0` is wrong at the bottom: it includes 1.0.x, which
never had the `plugins` option and are not affected. The tested-true range is:

- **Affected:** `>= 2.0.0, <= 3.0.0`
- **Patched:** `2.1.1` (once published) and `3.0.1`

The advisory is still a draft, so this is an edit, not a re-disclosure. Whether
2.1.1 is published or not, the advisory should say so explicitly, so a 2.x user
reading it knows whether to wait for a 2.x fix or upgrade to 3.x — the issue's
point 4.

[GHSA-wq8m-fc3q-8m5x]: https://github.com/myselfsiddharth/Flecto/security/advisories/GHSA-wq8m-fc3q-8m5x
[#125]: https://github.com/myselfsiddharth/Flecto/issues/125
