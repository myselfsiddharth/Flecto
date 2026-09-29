# Stability

Flecto sits in the path of a merge. If it changes shape without warning, it
either breaks your pipeline or — worse — stops gating something it used to gate.
This page states what you can build against and what you cannot.

Flecto follows [Semantic Versioning](https://semver.org/).

---

## What is covered

These are the public contract. A breaking change to any of them requires a major
version, and is preceded by a deprecation warning in a minor release (see
[Deprecation](#deprecation) below).

### 1. The output envelope

`--format json` emits a versioned envelope carrying `schema_version: "2.0"`.
Within a major version of that schema:

- **Existing fields keep their name, type, and meaning.** `pool_size` will not
  become `poolSize`, and a string will not become an array.
- **New fields may be added.** Parse permissively: treat an unknown key as
  something to ignore, not an error.
- **`schema_version` is bumped for anything else.** It is independent of
  Flecto's own version — it went to `"2.0"` in 3.0 and did not move in 4.0.

The schemas are published in [`schemas/`](../schemas) and are the normative
reference. Validate against them in CI if you consume the JSON.

### 2. Exit codes

| Code | Meaning |
|---|---|
| `0` | Ran to completion and nothing matched a fail trigger |
| `1` | Something matched a fail trigger, or the run could not complete |

That is the whole set, and it is deliberately narrow: a gate that a script has
to pattern-match on stderr to interpret is not a gate. Every command's exit
codes are listed in the [CLI reference](cli-reference.md).

New codes are additive within a major version only if `0` and `1` keep their
current meaning. **Flecto fails closed**: when a baseline cannot be resolved, a
pack cannot be compiled, or a target cannot be parsed, it exits `1` rather than
reporting a clean run.

### 3. `.flectorc`

- **Every documented key keeps its name and meaning.** Documented defaults do
  not change under you within a major version.
- **An unknown key is an error, not a warning.** That is intentional — a typo in
  a security control should not be silently ignored — and it is why new keys are
  a minor-version, not a patch-version, change.
- **Profiles and `extends` resolution order is stable.**

One asymmetry worth knowing, because it is a security boundary rather than a
style choice: **`.flectorc` may not set anything that decides the verdict.**
`snapshotRef`, `snapshotFile`, and the `explain*` options are refused there, and
plugins are refused unless explicitly opted into. Whoever picks the baseline
picks the result, and a file inside a pull request does not get to pick. Moving
an option *into* that refused set is a breaking change and follows the same
rules as anything else here.

### 4. CLI surface

Command names, flag names, and flag semantics are covered. A flag will not
quietly change what it accepts — when `--snapshot-ref` narrowed from "a revision
or a file" to "a revision only" in 4.0, that was a major version with a
[migration guide](migrating-to-4.md), not a patch.

---

## What is not covered

Being explicit here is the point; treating these as stable will hurt you.

- **Human-readable output.** The terminal format, colours, wording, table
  layout, and `--format pr-comment` markdown are presentation, and they change
  in minor releases. **Do not parse them.** Use `--format json`.
- **Warning and error message text.** The conditions are contractual; the
  prose is not.
- **The built-in packs' findings.** New rules are added, and existing rules get
  more accurate, in minor releases — that is the product working. A pack finding
  something new is not a breaking change, so if you need a fixed rule set, pin
  the exact version and pass `--policies` explicitly. Rule *IDs* are stable:
  an ID is not reused for a different rule, and `severityRemap` and inline
  suppressions keyed to one keep working.
- **Anything in `src/`.** Flecto is a CLI, not a library. There is no supported
  programmatic API; `import`ing internals is at your own risk.
- **Snapshot file internals.** Written and read by Flecto, across versions.
  Not an interchange format.
- **`FLECTO_*` escape hatches.** `FLECTO_ALLOW_RC_BASELINE`,
  `FLECTO_ALLOW_RC_PLUGINS`, and similar opt-outs exist to unblock a specific
  situation. They can be removed in a minor release once the situation they
  unblock has a better answer.
- **Experimental features**, marked as such where they are documented.

---

## Deprecation

No breaking change to a covered surface ships without this sequence:

1. **A minor release** adds the replacement and emits a deprecation warning on
   stderr when the old form is used. The old form keeps working, unchanged.
   Warnings go to stderr, never stdout, so they cannot corrupt piped JSON.
2. **The CHANGELOG entry** names the old form, the new form, and the version it
   is scheduled for removal in.
3. **The next major release** removes it, with an entry in a migration guide
   saying how to tell whether it affects you — as
   [`migrating-to-4.md`](migrating-to-4.md) does for 4.0's five changes.

There is at least one minor release carrying the warning before any removal.

**The one exception is a security fix.** If a surface can be used to make Flecto
report a clean run on a change that is not clean, it is closed in the next
release, and the advisory explains the change instead of a deprecation cycle.
4.0 was entirely this: five breaking changes, all of them bypasses. A gate that
stays compatible while failing to gate is worth nothing.

---

## Track record, stated plainly

Flecto reached 4.0 in four months. That is fast, and if you are evaluating
whether to put it in your merge path, you should weigh it rather than take a
promise on faith. What the history actually shows:

| Version | Date | Breaking changes | Why |
|---|---|---|---|
| 1.0.0 | 2026-07 | — | Initial release |
| 2.0.0 | 2026-07 | Envelope reshaped | Pre-adoption schema work |
| 3.0.0 | 2026-08 | Envelope to `schema_version: "2.0"` | Packs and CI became first-class |
| 4.0.0 | 2026-09 | 5, every one a bypass | [Security review](security-review.md) ([#121]) |

The churn was front-loaded into a period with no real users, and 4.0's changes
were forced by a security review finding real bypasses, not by taste. Going
forward the intent is **minor releases only**, and anything that would require a
5.0 is collected in [`v5-proposals.md`](v5-proposals.md) rather than shipped.

If a covered surface breaks without the deprecation sequence above, that is a
bug — [please report it](https://github.com/myselfsiddharth/Flecto/issues), and
it will be treated as a regression rather than argued about.

## Supported versions

Security fixes land on the current major. See [SECURITY.md](../SECURITY.md) for
the reporting process and the supported range.

[#121]: https://github.com/myselfsiddharth/Flecto/issues/121
