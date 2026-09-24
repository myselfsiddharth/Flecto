# Migrating to Flecto 4.0

4.0 is a security release. Five things change behaviour, and every one of them
exists because a pull request could otherwise make `flecto ci` report a clean
run on a change that was not clean.

Most upgrades need no change at all. Work down the list; each item says how to
tell whether it affects you.

---

## 1. `snapshotRef` is refused in `.flectorc`

**Affects you if** your `.flectorc` — or a profile in it — sets `snapshotRef`.

```console
$ flecto ci config/prod.yaml
[error] Refusing "snapshotRef" declared in .flectorc: it chooses the baseline
every change is measured against ...
```

The baseline decides what counts as a change, so whoever sets it decides the
verdict. A committed `.flectorc` carrying `{"defaults": {"snapshotRef":
"HEAD"}}` compared every file against the pull request's own tip — every diff
empty, exit 0, on a change that disabled TLS.

**Move it to the command line**, which is what every example and both bundled
Actions already do:

```bash
flecto ci config/prod.yaml --snapshot-ref origin/main
```

**Or opt back in**, if `.flectorc` is trusted where you run it — a private repo
with no outside contributors, say:

```bash
FLECTO_ALLOW_RC_BASELINE=1 flecto ci config/prod.yaml
```

`snapshotFile` is gated the same way, for the same reason.

---

## 2. `--snapshot-ref` takes a revision; a snapshot file needs `--snapshot-file`

**Affects you if** you pass a bare filename, like `--snapshot-ref snap.json`.

```console
$ flecto ci app.yaml --snapshot-ref snapshots/base.json
[error] "snapshots/base.json" does not resolve to a git revision here ...
Pass --snapshot-file <path> if you meant a snapshot file.
```

One flag accepting both is what let a pull request shadow the baseline: commit a
file named after the operator's ref — `HEAD~1`, the bundled Action's default —
and it was read instead of the revision. Because the file can be written to
match the hostile tip exactly, the diff was genuinely empty and **no `--fail-on`
value caught it**.

| Before | After |
|---|---|
| `--snapshot-ref snap.json` | `--snapshot-file snap.json` |
| `--snapshot-ref origin/main` | unchanged |
| `--snapshot-ref HEAD~1` | unchanged |
| `--snapshot-ref ./snap.json` | unchanged |

A value that is unambiguously a path — absolute, or starting `./` or `../` — is
still read as a file, because git's ref format cannot produce those shapes.

**Using the bundled Action?** It gained a `snapshot-file:` input:

```yaml
- uses: myselfsiddharth/Flecto/.github/actions/flecto-ci@v4
  with:
    snapshot-file: snapshots/base.json   # instead of snapshot-ref:
```

**Also**: Flecto now needs **git 2.24 or newer** (2019) for `--end-of-options`,
and refuses rather than guessing when git is missing, too old, or not looking at
a repository.

---

## 3. Policy pack regular expressions use RE2

**Affects you if** you wrote or installed a pack outside `src/packs/` that uses
lookaround, backreferences, `\uXXXX` escapes, or `v`-flag set subtraction.

```console
[error] Invalid policy pack at policies/custom.json: rule "x".afterMatches is
not a valid regular expression (... RE2 ... does not support lookahead ...)
```

A pack is attacker input on an untrusted pull request, and JavaScript's engine
backtracks: `^(a+)+$` against a 44-character value took **97 seconds** here and
grows exponentially. A CI job that never finishes is a denial of service against
the merge gate itself, and no in-process timeout helps — the backtracking is
inside one uninterruptible call into the engine.

Packs **Flecto ships** keep the native engine and are unaffected.

| Construct | Status |
|---|---|
| Lookahead / lookbehind `(?=x)` `(?!x)` `(?<=x)` | not supported |
| Backreferences `(a)\1` | not supported |
| `\uXXXX`, `\cX` escapes | not supported — RE2 spells it `\x{41}` |
| Unicode set subtraction `[a--b]` | not supported |
| Named groups, `\p{L}`, `(?i)`, `i`/`m`/`s` | supported |

A few constructs also **match differently** without failing, which is the more
dangerous kind. RE2's `\s` is ASCII-only, so a rule like `^\s*$` stops firing on
a value padded with a non-breaking space. The full table is in
[policy-packs.md](policy-packs.md#regular-expressions-in-packs) — check any pack
that uses `\s`, `.`, or `\p{L}` without `u`.

Negative lookahead is usually expressible as a separate rule with the positive
form, or by inverting which side of the diff the rule matches.

---

## 4. `.flecto-queue/` is keyed by destination

**Affects you if** you use `--delivery-mode at-least-once` and have an
undelivered backlog when you upgrade.

Queued events used to be delivered with whatever options the *current* run
carried, so an event queued for one endpoint was posted to whichever endpoint
ran next — a different team's channel, a different vendor. The queue is now one
directory per destination.

Nothing is deleted. A 3.x backlog is **not** auto-delivered, because nothing
recorded where it was headed, and Flecto names it once:

```
[warn] .flecto-queue/ holds undelivered events this run will not send: 3
event(s) queued by Flecto 3.x, which recorded no destination at all.
```

Inspect and re-send or remove them. Each file is a Flecto envelope, so
re-sending one is a `curl` with the body of the file.

**Rotating a webhook token also strands the backlog** — the queued events were
addressed to the old credential. That is the likeliest way to meet this warning
in practice.

---

## 5. The `--command` spill file is removed when the command exits

**Affects you if** a `watch --command` script reads `FLECTO_CHANGES_FILE`
*after* the command returns — a background job, or a later build step.

The file holds the complete, **unmasked** change set. It used to be written with
the process umask (`0644` typically) and left in the workspace for whatever ran
next. It is now `0600` inside a `0700` directory and deleted on every exit path.

Read it inside the command:

```bash
payload="${FLECTO_CHANGES}"
if [ -n "${FLECTO_CHANGES_FILE}" ]; then
  payload="$(cat "${FLECTO_CHANGES_FILE}")"   # while the command is still running
fi
```

---

## New in 4.0

- **`flecto-drift`** — compare a declared config against what is actually
  running in Kubernetes, SSM, or Terraform state. A **separate binary**: it
  holds no credentials, delegates to `kubectl`/`aws`, and compares secret-store
  values by shape rather than value. Nothing changes for you unless you run it.
  See [drift.md](drift.md).
- **`snapshot-file:`** input on the bundled `flecto-ci` Action.
- **`FLECTO_ALLOW_RC_BASELINE`** to opt back in to an rc-declared baseline.

## Security advisories

4.0 fixes issues covered by advisories published alongside this release. If you
run Flecto on untrusted pull requests, upgrading is not optional — see the
[security advisories](https://github.com/myselfsiddharth/Flecto/security/advisories)
and [SECURITY.md](../SECURITY.md).
