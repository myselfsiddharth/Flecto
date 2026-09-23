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

### Symlinked targets read files outside the repository — fixed

Recorded here previously as unhardened with "limited" impact, on the reasoning
that an attacker who controls the repo can already commit content. **That reads
the vector backwards.** The attacker does not control the file the link points
*at*, and that is the whole point of following it: on a CI runner, `~/.npmrc`,
`~/.docker/config.json`, `~/.git-credentials`, and `~/.aws/credentials` (which
is INI, and parses perfectly) are all outside the repository and all readable by
the job.

Confirmed: a pull request adding `leaked.yaml` as a symlink to a file outside
the checkout had that file parsed and its **values** emitted — in the JSON
envelope, in the job log, and in the `--format pr-comment` markdown, which
`--pr-comment-post` writes to a comment on the pull request. Opening a pull
request is the entire attack.

**Fixed** with a containment check on every resolved target, and on
`.flecto-snapshots/` before a snapshot is written. The rule is about *escape*,
not location, so the legitimate cases keep working:

| Given | Resolves to | Result |
|---|---|---|
| inside the project | inside | allowed — in-repo links still work |
| inside the project | outside | **refused** — the shape a pull request can author |
| outside the project | anywhere | allowed — `flecto compare /a.yaml /b.yaml` is operator intent |

`FLECTO_ALLOW_SYMLINK_TARGETS=1` opts out for a checkout that genuinely links
config in from a sibling directory. It refuses loudly rather than skipping the
file, for the same reason rc-declared plugins do: a target that stops being
scanned without saying so weakens a gate the operator believes is in place.

The *write* paths this paragraph left open — `--output` and `--baseline` — are
covered now; see the write-destination finding below.

### Prototype pollution in the INI parser — fixed

`parseIni` nested a section's keys under `out[section]`. A section named
`__proto__` resolved that to `Object.prototype` — which passes `isPlainObject`,
because its *own* prototype is `null` — and every key in the section was then
written onto the prototype of every object in the process. In this threat model
that is a pull request adding one `.ini` file to a repository whose CI runs
`flecto ci`.

The impact was not limited to the attacker's own file. `severityRemap[rule.id]`
is a plain-object lookup, so `[__proto__]` with `dangerous-toggle-enabled=off`
answered `'off'` for **every file in the same run** and the rule stopped firing:
a `flecto ci --fail-on error` that exited `1` on a real finding exited `0` with
the hostile file present. That is a merge-gate bypass, not only a denial of
service — though `toString=` was that too, since it replaces
`Object.prototype.toString` for the rest of the process.

**Fixed** by reading the section with `Object.hasOwn` and writing every key with
`Object.defineProperty`: a reserved name becomes an ordinary own key holding
ordinary data, which is what a config file's `[__proto__]` section is. It stays
*visible* in the diff rather than being dropped — silently discarding it would
hide a change, which is its own kind of wrong.

Two same-class sites were hardened alongside it, neither exploitable: the
masking walk in `src/renderer.js` and the copy loops in `src/encrypted.js` used
`out[key] = value`, which moves a `__proto__` subtree onto the *result's*
prototype. No value leaked — the key vanished from the output entirely — but a
change under such a key would have been invisible in masked output. Both now
rebuild with `Object.fromEntries`, as `normalizeParsedValue` already did.

Found by the fuzz harness ([#150]) on its first full-length run, at
`parse-ini` case 280 of seed 20260830. Regression tests in
`test/security.test.js`, including the end-to-end gate bypass, plus the
minimized input in `test/fixtures/fuzz/parse-ini-proto-section.json`.

### The merge gate could be turned green from `.flectorc` — fixed

`--update-baseline` rewrites the baseline file from **every finding of the
current run**, which accepts all of them: nothing is new relative to what was
just written, so the policy gate passes. The CLI help says "explicit, never
automatic", and it was neither — `updateBaseline` resolved through the ordinary
options merge, so `.flectorc` could set it, and on an untrusted pull request
`.flectorc` is a file the attacker wrote.

Confirmed end to end: a repository where `flecto ci --fail-on error` exits `1` on
a real finding exits `0` once a pull request adds four lines of `.flectorc`. A
profile reaches it too. Note what this overrides — the `--fail-on` in that
command is on the **command line**, chosen by the workflow author, and rc-declared
`updateBaseline` defeats it anyway. That is the property that separates this from
an rc file merely configuring `failOn`, which is the operator delegating the gate
to the repository and is working as designed.

**Fixed** by refusing `updateBaseline` from `.flectorc` entirely — no opt-out
environment variable, because unlike a plugin path or a write destination there
is no legitimate reason to declare an action in a settings file. It refuses
loudly rather than ignoring the key, so a repository that meant it finds out.
`--update-baseline` on the command line is unchanged. Regression tests in
`test/security.test.js`, including the profile route and the still-working CLI
path.

### Write destinations could be redirected out of the repository — fixed

The previous record left this open: "`--output` (`flecto report`) and `--baseline`
are *write* paths, and a symlinked destination redirects the write rather than a
read." Attacked, and it is worse than the symlink half alone — **both options can
be declared in `.flectorc`**, so the destination need not involve a link at all.

Three shapes confirmed against a real repository, each writing outside the
checkout with exit code `0`:

| Given in `.flectorc` | Result |
|---|---|
| `"output": "../home/.bashrc"` | the HTML report overwrote a file outside the project |
| `"output": "link.html"` (a symlink out) | the write followed the link |
| `"baseline": "../home/x.json"` + `updateBaseline` | a JSON file written outside the project |

Neither file is inert content. The report embeds config values and file names,
and a baseline embeds rule ids, file paths, and messages — all of which the pull
request authored. On a runner, the reachable destinations include shell profiles,
workflow files, and SSH config.

**Fixed** with a containment rule that follows the provenance, in
`assertWriteDestinationContained`:

- **Declared in `.flectorc`** — must resolve inside the project.
  `FLECTO_ALLOW_RC_WRITES=1` opts out, for a repository that genuinely configures
  a destination elsewhere.
- **Any source** — must not leave the project through a symlink, checked on the
  destination itself and on the directory it lands in.
  `FLECTO_ALLOW_SYMLINK_TARGETS=1` opts out of this half, as it does for reads.

The link check resolves the chain by hand rather than asking whether the
destination exists. `existsSync` follows links, so a link whose target is *not
there yet* reports as absent and would skip the check — and that is the sharper
half of the attack, not the weaker one: overwriting needs the file to already be
there, while a link to one the runner lacks has Flecto **create** it.
`~/.ssh/authorized_keys` is the example that stings, because sshd skips lines it
cannot parse, so a report wrapped around one attacker-authored line still works
as a key file. Not every absent file is reachable — the write lands at mode
`644`, so a git hook, which git will not run unless it is executable, is not.

A destination named on the **command line** is operator intent and is untouched,
the same distinction the read rule already draws: `flecto report --output
/tmp/drift.html` still works.

### The GitLab token followed redirects — fixed

`fetch` removes `Authorization` when a redirect crosses origins, and it removes
**only that header**. GitLab authenticates with `PRIVATE-TOKEN`, which is not
covered: verified against a local server, a `302` from the API host forwarded
`PRIVATE-TOKEN: glpat-…` to the redirect target in full. GitHub and Bitbucket use
`Authorization` and are stripped by the platform.

The API host comes from runner environment (`CI_API_V4_URL`), not from pull
request content, so this is not reachable from the primary threat model — it needs
a hostile or compromised API host, or a self-hosted instance redirecting
somewhere unexpected. It is still a credential leaving for a host nobody chose,
and the fix costs nothing: requests are issued with `redirect: 'manual'` and a
3xx is refused with a message naming the origin it pointed at. These endpoints do
not legitimately redirect, and one that does is worth seeing rather than
following.

### `watch --command`/`--webhook`/`--webhook-header` could be turned into an action from `.flectorc` — fixed

The previous record's "checked, solid" list said the command string itself is
"operator intent", on the reasoning that `--command` exists only in `watch`, not
in the `ci` path a pull request triggers. That reasoning stopped at the CLI flag
and never asked where `effective.command` actually comes from: `watch` merges
`.flectorc`/profile options with CLI overrides the same way every other command
does, through `resolveEffectiveOptions`, and unlike `--plugins` /
`--output` / `--baseline` / `--update-baseline`, nothing gated `command` or
`webhook` at that merge. A `.flectorc` naming either one is honored exactly as if
it had been passed on the command line.

That makes the "operator intent" premise false for the one path that matters: a
pull request that adds `.flectorc` and nothing else. `--command` spawns a shell
command (`spawn(command, { shell: true })`) on every change `watch` detects,
with diff data injected as `FLECTO_*` environment variables — env var *names*
are fixed and the values are never interpolated into the shell, which is the
half the previous entry checked, but the **command string** was never attacker
data before, so that check never had reason to look at where the string itself
comes from. `webhook` is the same shape one step down: it POSTs the change
payload to a URL `.flectorc` names.

Confirmed end to end: a repository with no `--command` flag anywhere, only a
`.flectorc` `{"defaults": {"command": "..."}}}`, ran that command — writing a
marker file — the moment `flecto watch <file>` observed a change. No pull
request needs a workflow change or a CLI flag; the existing `flecto watch`
invocation the repository already runs is enough.

Fixing only the two flags named in the old entry would repeat its own mistake
— checking the option that was asked about rather than the merge it goes
through. `--webhook-header` merges exactly the same way and is reachable even
when `command`/`webhook` themselves are the operator's own CLI flags: an
rc-declared header rides along on that already-approved request and can
override it, including `Content-Type` and the `X-Flecto-*` headers a receiver
might dedupe on.

**Fixed** the same way the merge-gate and write-destination findings above
were: `command`, `webhook`, and `webhookHeader` declared in `.flectorc` (or a
profile) are refused unless `FLECTO_ALLOW_RC_ALERTS=1` opts in, in
`assertAlertActionsFromCli`. Any of the three named on the **command line** is
operator intent and untouched: `flecto watch config.yaml --command
'./notify.sh'` still works exactly as before. Regression tests in
`test/security.test.js`, including the profile route, the opt-out variable,
and an end-to-end run proving the CLI path still fires a real command on a
real change.

`onAlertFailure` and `deliveryMode` merge through the identical path and are
**deliberately not gated**: `flecto init` writes both into the `.flectorc` it
generates (`docs/configuration.md`), and both only tune how an alert *already
chosen by the operator* responds to failure — the same "operator delegates a
setting" shape `failOn` already has, not "a settings file grants itself a
capability it didn't have." An rc-declared `onAlertFailure: exit` can make
`watch` quit on a transient delivery failure, which is a real availability
concern for whatever the process was monitoring, but it is a narrower,
different-shaped problem than command execution or exfiltration, and closing
it would mean refusing a key `flecto init` writes by default. Left open,
named here rather than silently excluded.

### The alert path leaked, misrouted, and left behind what it carried — fixed

Three findings in `src/alerter.js`, reached by a route worth recording: they
were already written up as **draft advisories** against 2.x
(GHSA-7m3q-8mvc-465r, GHSA-5wmr-3v28-p7q2, GHSA-pppr-9966-2hm6), each marked
`patched_versions: null`, and never revisited. Reading the current file rather
than the advisory metadata showed all three behaviours still present on `main`.
The affected range on those drafts (`<= 2.1.0`) was simply wrong — nothing had
fixed them, so every release since is affected too.

**The webhook URL was printed whole on failure.** A webhook URL is routinely
*itself* the credential — a Slack incoming webhook carries its secret in the
path — and `postWebhook` interpolated the full URL into both the HTTP-status
warning and the exhausted-retries warning. A transient 500 copied the secret
into the terminal and, in CI, into a log that is often world readable and
retained far longer than the run. Fixed with `redactWebhookUrl`: origin only,
plus a marker that a path was elided. Enough to tell *which* endpoint failed,
not enough to call it.

**The persistent queue was not bound to a destination.** `enqueuePersistent`
stored the envelope alone, and `flushPersistentQueue` delivered it with
whatever options the *current* `fireAlerts` call carried. An event queued while
`watch` pointed at one endpoint was posted to whichever endpoint ran next — a
different channel, a different vendor, a URL from a different profile — carrying
configuration data the operator had deliberately directed elsewhere. This is not
hypothetical; it reproduces in a dozen lines against `main`. Fixed by keying
`.flecto-queue/` by a hash of URL, headers, and format, so a flush only ever
reads its own backlog. Hashing rather than storing keeps the URL and any auth
header out of the queue file. Events queued by an earlier version have no
recorded destination: they are left undelivered and named once, because
delivering them is the bug and deleting them discards an event that was promised
at-least-once.

**The oversized-payload spill file outlived its command.** A change set over
16,000 characters is written to `.flecto-tmp/changes-<ts>-<id>.json` — the
complete, *unmasked* change set, including values `--mask-secrets` hides on
screen — with the process umask (`0644` typically) and no cleanup. It sat in the
workspace for whatever ran next: a later build step, an artifact upload, a cache
action. Now `0600` inside a `0700` directory, removed on every exit path of
`runCommand` including the throw.

Regression tests in `test/alerter.test.js` cover each, and the two that are
behavioural were first confirmed to reproduce against pre-fix `main`: a test
that only passes after a fix proves less than one watched to fail before it.

### The baseline ref could be chosen, and weaponized, from `.flectorc` — fixed

Found by asking of `snapshotRef` the question the `watch --command` entry above
should have been asked of `command`: not "what does this option do" but "where
does its value come from". It comes from `resolveEffectiveOptions`, like every
other option, and nothing gated it.

Two defects, of quite different cost to exploit.

The **cheap one needs no crafted value at all.** `snapshotRef` names the
baseline every change is measured against, so whoever sets it defines what
"changed" means. A committed `.flectorc` carrying `{"defaults": {"snapshotRef":
"HEAD"}}` points the baseline at the pull request's own tip: every file is
compared against itself, every diff is empty, and `flecto ci` exits 0 whatever
the change did. Confirmed end to end on a repo whose tip disables TLS and
raises a pool size 100x — exit 1 against the operator's ref, exit 0 with the rc
file present. This is the same shape as the `updateBaseline` finding above and
strictly cheaper: no second option, no write, one key.

The **second is argv injection.** The ref is interpolated into `git show
<rev>:<path>` and passed through `execFileSync`, so no shell is involved — but
argv is not the same boundary as a shell, and a ref beginning with `-` is still
parsed by *git* as one of its options. `snapshotRef: "--output=pwned"` turns
the baseline read into a file write (`pwned:app.yaml`, attacker-chosen prefix,
forced `:<rel>` suffix). Because the read then returns nothing, the baseline
parses as an empty document, every key reads as `added` rather than `changed`,
and the default `--fail-on changed,policy,error` never fires. One string, an
arbitrary write and a silent pass.

**Fixed** in the two places the review's own pattern already points at.
`assertSnapshotRefFromCli` refuses an rc-declared or profile-declared
`snapshotRef` unless `FLECTO_ALLOW_RC_BASELINE=1` opts in — a ref named on the
command line is operator intent and untouched, so `flecto ci config.yaml
--snapshot-ref origin/main` is unchanged, and every documented use of the flag
is the CLI form. `assertSafeGitRef` refuses a leading `-`, a newline, or a NUL
in any ref whatever its provenance, and both call sites now pass
`--end-of-options` so git refuses to read the operand as an option on its own
account. The guard is kept *in addition to* `--end-of-options` because the
latter needs git 2.24, and because a refusal that names the problem beats
`fatal: option ... must come before non-option arguments`.

Review of that first fix found **two more ways to the same property**, both
confirmed, both now closed in the same change.

A ref was resolved as a *filesystem path* before it was tried as a revision,
and the path resolved against the checkout root -- whose file names an
untrusted pull request controls. Committing a file named `HEAD~1`, which is
exactly what the shipped GitHub Action passes by default, replaced the
operator's baseline with one the attacker wrote: exit 0 on a config that
disables TLS. No `.flectorc` needed, so it worked in repositories where that
file is CODEOWNERS-protected. Resolution is now revision-first, and a ref-shaped
value that does not resolve -- the shallow-clone case, where `HEAD~1` is real
but unreachable -- is an error rather than a fallback to a file of that name. A
file that is *also* a revision is reported rather than silently preferred.

A ref could also be a commit *range*. `git show A..B` succeeds and prints
nothing, so `HEAD:..` or `base..` produced an empty baseline, every key read as
`added`, and the default `--fail-on changed,policy,error` never fired -- the
same silent pass as the injection, with no dash involved, and reachable even
through the `FLECTO_ALLOW_RC_BASELINE` opt-out. Refs now resolve through
`git rev-parse --verify --end-of-options <ref>^{commit}`, which refuses anything
that is not exactly one commit, and `git show` is handed the resolved SHA rather
than any string the attacker wrote. `assertSafeGitRef` refuses `..` by name too,
because "Needed a single revision" explains less.

A **third** review round found that the shadow fix was still wrong, and the
way it was wrong is the most useful thing in this entry. It asked "does this
value look like a revision?" and allowed the file branch when it did not --
a denylist over a value space *identical* to the one it was excluding, because
branch and tag names are ordinary words. `origin/main`, `main`, `v1.2.3`, and
`develop` all fell straight through it. Reproduced in a byte-faithful
`actions/checkout` pull-request checkout: `--snapshot-ref origin/main`, the
form this project's own `docs/explain.md` puts in a workflow, exited 0 on a
config disabling TLS. On a `pull_request` event no `origin/<base>` ref exists
unless it is fetched deliberately, so that was the *default* configuration,
not an edge case. And because the shadow file is written to match the hostile
tip, the diff is genuinely empty -- no `--fail-on` value catches it.

**Fixed by removing the ambiguity instead of enumerating it again.** The
polarity is inverted: the *file* branch must prove itself, and everything else
must resolve as a revision or the run fails. `--snapshot-file` is added as the
unambiguous form and is gated from `.flectorc` exactly as `snapshotRef` is,
since it picks the baseline just as directly. `resolveGitCommit` also stopped
collapsing "git is missing", "not a repository", and "git is too old" into "not
a revision" -- not knowing whether a revision exists is precisely when reading a
same-named file is most dangerous, so those now fail closed.

A **fourth** round found the first version of that inversion still wrong, in the
same way one more time. It accepted a `.json`/`.yaml` suffix as proof of
path-ness -- but git only forbids `..`, a trailing `.`, and a `.lock` suffix in
a ref name, so `release/v1.json` is a perfectly legal ref. A pull request
committing a file of that name beat a **resolvable tag** of the same name, in a
full clone, with no shallow checkout involved. An extension is a convention; the
ref grammar is a grammar. Only an absolute path or an explicit `./` or `../`
now short-circuits to a file, because those are the shapes git's own ref format
cannot produce. The suffix arm was also pure surface with no benefit:
`readSnapshotStateFromFile` is `JSON.parse`, so a real `.yaml` snapshot never
worked anyway.

The same round found the file branch had **no containment at all**, which is a
different bug in the same function. A baseline named as a path was `resolve`d
and read with no `assertTargetContained` -- so where an operator names an
in-repo baseline such as `.flecto/baseline.json`, a pull request replaces it
with a symlink and the contents of any JSON file on the runner become the
"baseline", printed as `removed` changes. Flecto already enforced exactly this
rule for targets, for the snapshot store root, and in `src/mcp.js` for a ref
naming a file; the CLI baseline read was the one surface that had been missed,
and this change had been about to add a second flag to it. Both branches now go
through one `readSnapshotFile` that contains, refuses an empty value, and reads.

The lesson worth recording is that three rounds of this finding were all the
same mistake: patching the syntax that was demonstrated rather than the
property underneath. *Whoever picks the baseline picks the verdict.* Anything
that lets the change under review choose, or emptily answer, what it is
compared against is this vulnerability wearing different syntax.

`src/lsp-analysis.js` reads a ref the same way and is hardened identically. The
MCP server was already safe from the dash shape -- `assertSafeRef` refuses a
leading `-` before anything spawns -- and reaches the range and path fixes
through the CLI it spawns.

This is a **breaking change**, and deliberately shipped in 4.0 rather than a
patch: a repository that legitimately keeps `snapshotRef` in `.flectorc` must
now either move it to the command line or set `FLECTO_ALLOW_RC_BASELINE=1`.
That cost is real but small — the flag is what every example and every doc page
already uses — and the alternative is a merge gate a pull request can silence
with one line.

### A symlinked target redirected the baseline itself — fixed

The fourth and most severe route to the same property, and the one that
survived three rounds of fixes because it is not in the ref at all — it is in
the **path**.

`gitRepoRelativePath` canonicalized the *file*, which resolves its final
symlink, so the path handed to `git show <sha>:<rel>` was the link's
destination rather than the path the operator gated. A pull request that
replaces the gated file with a link to any other file unchanged in the baseline
gets `before == after`: a genuinely empty diff that **no `--fail-on` value
catches**, because there is nothing to catch.

The whole exploit is a one-line diff, plausibly titled *"chore: dedupe
prod/staging config"*:

```
rm config/prod.yaml && ln -s staging.yaml config/prod.yaml
```

`config/prod.yaml` now effectively carries staging's `tls: false`, and
`flecto ci --snapshot-ref HEAD~1` — the shipped Action's default — reports
`"changes": []` and exits 0. Pre-existing on `main`, not introduced by the
baseline work, and it would have shipped under a review record claiming the
property it breaks.

**Fixed** by canonicalizing the *directory* and keeping the name as written.
Every reason the original comment gives for canonicalizing (Windows 8.3 names
and case, the macOS `/tmp` and `/var` links) is a property of directories, so
nothing is lost. A baseline entry that is itself a symlink is now refused
rather than diffed against a filename — git stores a link as mode 120000 whose
blob is the target *path*, which is not a configuration.
`src/lsp-analysis.js` had the identical line and the identical fix.

Found alongside it: `assertTargetContained`'s escape hatch for "named from
outside the project" was decided on `canonical(dirname(given))` — a component
an untrusted pull request controls. With a **directory** symlink
(`repo/b -> /outside`), that already pointed outside, so the function returned
without checking anything and `repo/b/baseline.json` read straight out of the
project. Replacing the *file* with a link was refused; replacing its
*directory* was the same effort and was not. The judgement is now made on the
path as given as well.

That second judgement is deliberately **lexical** — `resolve(cwd)` against
`resolve(file)`, neither canonicalized. The first attempt compared an as-given
path against a *canonicalized* root, which is a no-op on POSIX and silently
wrong on Windows: `process.cwd()` reports the 8.3 short form
(`C:\Users\RUNNER~1\…`) while `canonical()` returns the long one, so the two
never shared a prefix, the check decided the path was named from outside, and
returned without checking. The Windows CI leg caught it leaking a file from
outside the project; the POSIX legs were green. Both sides of the lexical
comparison now derive from the same `process.cwd()` spelling, so there is
nothing left to normalize.

### Bitbucket path segments were interpolated unencoded — hardened

`BITBUCKET_WORKSPACE` and `BITBUCKET_REPO_SLUG` went into the request path raw,
while GitLab's project id was already encoded. Not exploitable — both come from
runner environment, and a path segment cannot move the request to another host —
but a value carrying `/`, `?`, or `#` restructures the URL rather than naming a
repository. Both are `encodeURIComponent`d now, matching GitLab.

## Checked — no change needed

- **Token handling (`src/pr-comment.js`).** The token is read from
  `GITHUB_TOKEN`, sent only as a `Bearer` header to `GITHUB_API_URL` (default
  `api.github.com`), and stripped from every error string surfaced to the user.
  `apiUrl`, `repo`, and `prNumber` come from runner env, not PR files, so PR
  content cannot redirect the token or induce SSRF. Posting is opt-in and needs a
  complete PR context.
- **Prototype pollution in JSON, YAML, TOML, and dotenv.** A `__proto__` /
  `constructor.prototype` key becomes an ordinary own property (the parser's
  `isPlainObject` checks the prototype and normalization rebuilds via
  `Object.fromEntries`); it does not reach `Object.prototype`. The differ and
  pack loading were exercised with such keys and stayed clean, and the fuzz
  targets now exercise all of it continuously. **INI was not covered by this
  claim and was vulnerable** — see the finding above. The lesson is the narrow
  one: this list is per code path, and "the parser" is five of them.
- **`policies add` package safety.** Resolves the target with `require.resolve`
  (path only, never evaluated) and reads the pack JSON off disk; it never
  `import()`s the package, so it runs no package code. (`npm install`-time
  `postinstall` is outside Flecto's control and is an npm concern.) The pack id
  becomes a filename under `policies/`, and it is constrained to a single plain
  segment before it gets there: `../../evil`, `flecto-pack-../../evil`, and their
  percent-encoded forms are all refused by `normalizePackPackageName`, so the
  write cannot leave the directory.
- **Deeply nested YAML.** js-yaml's default schema caps nesting depth (~100), so
  a deep-nesting document is rejected at parse rather than overflowing the stack.
- **GitLab and Bitbucket token handling** ([#147], the surface [#138] added). Tokens
  are read from environment only, sent as a single auth header to the API URL from
  runner environment, and stripped from every error string by the same `redact`
  the GitHub path uses — including the failure and timeout paths. Neither token
  is honored from `.flectorc` or from any file the repository can contain.
  Detection is by CI variables, and posting still requires `--pr-comment-post`
  plus a complete merge request context. Two things did change: see the redirect
  finding and the segment-encoding note above.
- **An API URL over plain `http`.** `CI_API_V4_URL` / `GITHUB_API_URL` /
  `BITBUCKET_API_URL` are runner environment, so a plaintext API URL is the
  operator describing their own network, not an attacker redirecting anything.
  Not refused, deliberately — a self-hosted instance on an internal `http` host is
  a real deployment, and refusing it would break a legitimate setup to prevent a
  configuration the operator already controls.
- **Enormous files.** Measured rather than reasoned about: 9.3 MB of YAML parses,
  diffs, and gates in 1.6 s; 44 MB in 9.0 s. Cost is linear, with no quadratic
  or exponential shape to trip, and the practical ceiling is the git host's own
  file-size limit. A file large enough to exhaust the heap aborts the process
  non-zero, which fails the build closed rather than passing it.
- **The shared snapshot store** ([#141], `src/snapshot-store.js`). The shared
  store lives at `.flecto/snapshots/` and is *committed*, so on an untrusted pull
  request its files are attacker-controlled exactly as a config file is — and
  `flecto ci --snapshot-store shared` reads that baseline **directly**, without
  passing it through the parser's `normalizeParsedValue`. So it is its own
  untrusted-input boundary, and the same four questions were put to it:
  - **Prototype pollution.** A committed baseline whose `state` carries a
    `__proto__` / `constructor.prototype` key does not reach `Object.prototype`:
    `JSON.parse` makes `__proto__` an ordinary own property, the differ walks it
    without lifting it onto a prototype, and `stableStringify` writes every key
    through `Object.defineProperty` — the same guarantee the parser and differ
    already give. Verified end to end through `ci`.
  - **Write containment.** The shared store keys a snapshot by the config file's
    repo-relative path (`keyFor`), and a path that escapes the project root has
    no such key, so the write is *refused* rather than redirected — a snapshot
    write cannot leave `.flecto/snapshots/`. This is the same escape-not-location
    rule as the target and write-destination findings above. One hardening came
    out of it, found by the Windows CI leg: `keyFor` recognised "outside" only as
    a `..`-prefixed relative path, but on Windows `relative` cannot reach another
    drive or a UNC share and returns the target *absolute*. Such a key was
    accepted — never an escape, since `join` keeps it under the store root, but a
    cross-drive write failed on a raw `ENOENT` and a UNC one was written under a
    meaningless `server/share/…` key. An absolute relative path is now refused
    like any other outside target.
  - **`stored.file` is a label, not a read.** A committed baseline can name any
    `"file"` it likes, including an absolute path outside the checkout, but the
    baseline compared against is the store's own `state`; `readLatest` (the path
    `ci` takes) never opens the labeled file, so a crafted `"file"` cannot induce
    an arbitrary read.
  - **Malformed or pathological store JSON** fails the run **closed**:
    `readStoreFile` rethrows a clean error on invalid JSON, and a deeply-nested
    document exhausts the stack and exits non-zero rather than hanging or passing
    the gate — the same shape as deeply nested config above.
  - **`resolveProjectRoot`** shells to git through `execFileSync('git', [...])`
    with an argument array and no shell, over the operator's own `cwd`, so no
    config content reaches a command line. Regression tests in
    `test/security.test.js` (“the shared snapshot store trusts nothing a pull
    request commits”), alongside the store's functional suite in
    `test/snapshot-store.test.js`.

### Pack-supplied regexes could hang the merge gate (ReDoS) -- fixed

The last item this review left open, held back because the fix is a dependency
decision and those belong in a major version.

A policy pack is attacker input in this threat model: `policies/*.json` is a
committed file and `.flectorc` selects which packs run. Re-confirmed live from a
pull request -- a committed `policies/evil.json` with `afterMatches: "^(a+)+$"`
pinned `flecto ci` past 15 seconds on a 44-character value, exponential from
there. Measured here at **97 seconds**. No in-process timeout addresses it: the
backtracking happens inside one uninterruptible call into the engine, which is
also why the LSP's worker timeout only ever contained it rather than fixed it.

**Fixed** by compiling pack-supplied patterns with RE2 (`re2js`, a pure-JS port
-- 870 KB, no native build, so the "nothing extra has to exist on the CI runner"
promise survives; the native `re2` binding is 13 MB and needs a toolchain or a
prebuild). Matching is linear in the input length, and the same pattern now
answers in 3 ms.

The split is **provenance, not content**: packs Flecto ships in `src/packs/`
keep the native engine, because they are reviewed, change only in a release, and
are not reachable by a pull request -- and `github-actions.json` legitimately
uses a negative lookahead to mean "not pinned to a full SHA". A local pack that
*overrides* a built-in id is still local, and still untrusted.

The cost is real and is why this is 4.0: RE2 omits lookaround, backreferences,
and `v`-flag set subtraction, so a pack using them now fails to load with a
message naming the rule and the construct.

## Not yet closed

Nothing from the original "not yet reviewed" list remains open. The last item —
attacker-supplied regexes in custom packs — is closed above, in 4.0, once the
dependency decision it was waiting on was taken.

Two findings raised during this review were split out rather than patched here,
because neither is a `#121` attack-surface item:

- **[#186]** — an empty baseline reads as all-`added`, and neither `ci`'s
  default `--fail-on` nor the bundled Action's includes `added`. This was the
  *amplifier* behind three separate baseline defects; the routes are closed, the
  amplifier is a product decision.
- **[#185]** — `runCommand` treats a signal-killed command as success, so
  `--on-alert-failure` does not fire for an OOM-killed alert handler.

## Fuzzing the same boundary

Everything above is manual review, and manual review finds what someone thought
to look for. `npm run fuzz` ([#150], [`test/fuzz/README.md`](../test/fuzz/README.md))
keeps looking at the same boundary after the reviewer has moved on: structure-aware
targets over `parseContent` per format, `diffTrees`, `expandChangeSubtrees`, the
regexes in `secrets.js` and `encrypted.js`, and pack loading and evaluation.

The invariant is the one this record has been assuming: **it either succeeds or
throws a clean `Error` — never hangs, never exhausts memory, never returns a
prototype-polluted object** — with a per-case time budget, because a target that
takes seconds is a denial of service on a CI runner whether or not it returns.

Two scoping notes, so the target list is read for what it is:

- **Pack-supplied regexes are fuzzed with bounded quantifiers.** A pack author
  can already hang the process, which is the known limitation in
  [`SECURITY.md`](../SECURITY.md); generating that class would re-report it every
  night rather than find anything. What is fuzzed is everything around it —
  compilation, flags, and evaluation.
- **A cyclic tree reaching `diffTrees` throws rather than returning.** That
  satisfies the contract, and the parser's circular sentinel means a cycle cannot
  arrive from a parsed file in the first place.

Fuzzing runs nightly, not on pull requests, and files nothing automatically:
findings on this boundary may be exploitable rather than merely a hang, and those
are reported privately per [`SECURITY.md`](../SECURITY.md).

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
[#138]: https://github.com/myselfsiddharth/Flecto/issues/138
[#141]: https://github.com/myselfsiddharth/Flecto/issues/141
[#147]: https://github.com/myselfsiddharth/Flecto/pull/147
[#150]: https://github.com/myselfsiddharth/Flecto/issues/150

[#185]: https://github.com/myselfsiddharth/Flecto/issues/185
[#186]: https://github.com/myselfsiddharth/Flecto/issues/186
