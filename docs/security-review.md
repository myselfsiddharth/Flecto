# Security review record

The pre-3.0.0 review terminated after verifying only that YAML parsing uses a
safe schema, and a critical RCE shipped anyway ([GHSA-wq8m-fc3q-8m5x], fixed in
3.0.1). This record picks the review back up ([#121]) and states plainly what has
been examined — findings *and* the "checked, solid" list — so the unexamined
surface stays visible instead of assumed safe.

## Related: is 2.x affected by GHSA-wq8m-fc3q-8m5x?

Yes, from its first release — confirmed with the advisory's own proof-of-concept
against a clean install of every published version ([#125]). 2.0.0, 2.1.0, and
3.0.0 execute the rc-declared plugin; 1.0.x predate the `plugins` option and 3.0.1
refuses it. The backport is merged on `release/2.x` (2.1.1) and effective, but was
never published — the highest installable 2.x is the still-vulnerable 2.1.0. The
full test matrix, the advisory range correction (`>= 2.0.0, <= 3.0.0`), and the
publish recommendation are in
[`ghsa-wq8m-fc3q-8m5x-2x.md`](ghsa-wq8m-fc3q-8m5x-2x.md).

## Threat model

Flecto runs in CI with repository access and often a `GITHUB_TOKEN`. The primary
attacker is a **malicious pull request**: they control config file contents, file
names, and `.flectorc`, and CI runs Flecto over all of it. Runner-set
environment (`GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_REF`, `GITHUB_API_URL`)
is **not** attacker-controlled from PR content.

## Findings (fixed)

### Regular-expression denial of service in secret detection — fixed

`src/secrets.js` ran on every changed string value under the `default` pack, so a
single crafted value in a pull request reached it. Two of its own patterns were
`O(n²)`:

- the PEM private-key pattern spanned `BEGIN…END` with a lazy `[\s\S]*?…$`,
  quadratic on a long `BEGIN`-prefixed value with no `END`;
- the URL-credentials pattern had an unbounded scheme run before the required
  `://`, quadratic on a long value that never contains `://`.

A few hundred kilobytes of a single value hung the CI job. **Fixed** by finding
the private-key markers with anchored, non-spanning regexes paired by position,
and by length-bounding the URL scheme. 1 MB now scans in well under a second;
detection of real (including unterminated) keys is unchanged. Regression tests in
`test/security.test.js`.

### YAML alias-expansion denial of service ("billion laughs") — fixed

YAML aliases resolve to shared object *references*, so a few hundred bytes of
nested aliases parse to a small DAG that `normalizeParsedValue` (in `src/parser.js`)
expands into an exponentially large tree — the expansion is deliberate so two
files with the same shape compare equal, but it was unbounded. `flecto ci` on a
tiny crafted file hung. **Fixed** with a node budget (5,000,000, far above any
real config) that fails fast with a clear error. Regression test in
`test/security.test.js`.

## Checked — no change needed

- **Command execution (`--command`, `src/alerter.js`).** Env var *names* are
  fixed (`FLECTO_*`); attacker config content lands only as the *value* of
  `FLECTO_CHANGES`, passed via the child's environment, never interpolated into
  the shell. The command string itself is operator intent, and `--command` exists
  only in `watch`, not in the `ci` path a PR triggers. No injection from config
  content.
- **Token handling (`src/pr-comment.js`).** The token is read from
  `GITHUB_TOKEN`, sent only as a `Bearer` header to `GITHUB_API_URL` (default
  `api.github.com`), and stripped from every error string surfaced to the user.
  `apiUrl`, `repo`, and `prNumber` come from runner env, not PR files, so PR
  content cannot redirect the token or induce SSRF. Posting is opt-in and needs a
  complete PR context.
- **Prototype pollution.** A `__proto__` / `constructor.prototype` key in JSON or
  YAML becomes an ordinary own property (the parser's `isPlainObject` checks the
  prototype and normalization rebuilds via `Object.fromEntries`); it does not
  reach `Object.prototype`. The differ and pack loading were exercised with such
  keys and stayed clean.
- **`policies add` package safety.** Resolves the target with `require.resolve`
  (path only, never evaluated) and reads the pack JSON off disk; it never
  `import()`s the package, so it runs no package code. (`npm install`-time
  `postinstall` is outside Flecto's control and is an npm concern.)
- **Deeply nested YAML.** js-yaml's default schema caps nesting depth (~100), so
  a deep-nesting document is rejected at parse rather than overflowing the stack.

## Not yet closed

- **Attacker-supplied regexes in custom packs.** A `.flectorc`-selected local
  pack can carry a catastrophic `match.path` / `afterMatches`. Node has no regex
  timeout, so a full fix means a timeout-capable engine (e.g. `re2`) — a
  dependency decision left to the maintainer. Documented as a known limitation in
  [`SECURITY.md`](../SECURITY.md).
- **Symlinked targets.** A glob can follow a symlink out of the repo; the impact
  is limited (an attacker who controls the repo can already commit content), but
  it has not been hardened.

## Knowing what has been exercised

"Checked — no change needed" above is a claim about what a reader looked at.
Coverage is the mechanical half of the same question: which branches of these
modules has **no test ever executed**?

```sh
npm run coverage
```

That runs the suite under `node --test --experimental-test-coverage` and prints a
focused report — the modules where an untested branch is a security question
rather than a style one, worst branch coverage first, with the count of branches
that never ran:

```
Security-relevant modules (worst branch coverage first)
  file                         lines  branch   funcs  missed
  ----------------------------------------------------------
  src/config.js                97.4%   84.3%  100.0%      19
  src/policy.js                95.5%   88.4%  100.0%      44
  ...
```

It runs in CI on every pull request and prints in the job log, so it needs no
artifact download to read. **No threshold gates it** ([#149]): a number chosen
before anyone has read the report is arbitrary, and the usual outcome is tests
written to satisfy the gate rather than to find defects. The list is a place to
start a review, and a way to know when one is finished — not a score.

The focused list, and the reason each module is on it, lives at the top of
[`scripts/coverage-report.js`](../scripts/coverage-report.js). It is meant to be
argued with and edited rather than grown until it is the whole repository again.

Coverage says a branch ran, not that it ran with the input an attacker would
choose. It narrows where to look; it does not replace looking.

[GHSA-wq8m-fc3q-8m5x]: https://github.com/myselfsiddharth/Flecto/security/advisories/GHSA-wq8m-fc3q-8m5x
[#121]: https://github.com/myselfsiddharth/Flecto/issues/121
[#125]: https://github.com/myselfsiddharth/Flecto/issues/125
[#149]: https://github.com/myselfsiddharth/Flecto/issues/149
