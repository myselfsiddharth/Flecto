# Troubleshooting

Start here:

```bash
flecto doctor
```

It reports which config file resolved, how many files its patterns match, and
whether your Node.js version is supported.

---

## "No files matched"

```
No files matched. Provide files or configure .flectorc files/include.
```

Either pass files explicitly or add patterns to `.flectorc`. Check what your
patterns currently resolve to with `flecto doctor` — a `files` pattern that
matches nothing is the usual cause.

Quote your globs so the shell doesn't expand them first:

```bash
flecto watch "config/**/*.yaml"   # correct
flecto watch config/**/*.yaml     # shell may expand or mangle this
```

---

## Changes aren't detected while watching

Native filesystem events don't fire reliably on some network drives, containers
with bind mounts, and editors that write via atomic replace. Force polling:

```bash
flecto watch config/prod.yaml --polling --interval 500
```

---

## CI passes when it shouldn't

Two common causes:

**A shallow checkout.** `--snapshot-ref HEAD~1` needs a parent commit. GitHub's
default checkout is depth 1, which has none:

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 2
```

**Fail triggers too narrow.** `--fail-on` defaults to `changed,policy,error` on
the CLI, but the bundled Action defaults to `policy,error`. If you expect a
plain value change to fail the build, say so explicitly.

An unresolved `--snapshot-ref` and a run where every target is missing both fail
closed already, so neither can cause a false pass.

---

## Everything shows as changed after upgrading to 2.1

Array identity matching became default-on in 2.1, so array diff paths moved from
index-based (`services[0].…`) to identity-based (`services["api"].…`).

To restore 2.0 behavior:

```bash
flecto watch config/services.yaml --no-array-id
```

Or set `"arrayId": false` in `.flectorc`. Re-taking your snapshots after
upgrading also resolves it. See the [changelog](../CHANGELOG.md).

---

## A reordered list reports changes that didn't happen

Flecto matches array items by `id`, falling back to `name`. If your items use a
different identity field, point at it:

```bash
flecto watch config/services.yaml --array-id-key serviceKey
```

For arrays of scalars where position carries no meaning, use
`--array-ignore-order`.

---

## My `.flectorc` profile settings are being ignored

Only flags you explicitly type override a profile. If a setting still isn't
applying, confirm the profile is actually selected — `--profile` beats
`FLECTO_PROFILE`, which beats no profile — and check the resolved config path in
`flecto doctor`.

Note that keys are camelCase in `.flectorc`: `failOn`, not `fail-on`.

---

## A policy rule never fires

Check the rule is loaded at all:

```bash
flecto policies list
```

Then confirm its `when` clause covers the event type you're producing. A rule
with `"when": ["changed"]` will not fire on a key that was *added* — a common
surprise when a config gains a flag rather than flipping one.

Pack loading fails closed on unknown fields, invalid regexes, and malformed
predicates, so a misspelled predicate raises an error rather than silently
disabling the rule. Watch mode exits non-zero on pack or plugin load errors.

To test a rule against fixtures, see
[`flecto policies test`](cli-reference.md#flecto-policies-test-fixturedir).

---

## A secret wasn't masked

Masking matches on the *key name* — `secret`, `token`, `password`, `api_key`,
`private_key`, `credential` — and, independently, on the *value*: known token
formats (AWS, GitHub, Slack, Google, Stripe, JWT, PEM private-key blocks, URL
credentials) plus a high-entropy fallback for opaque strings. See
[secret masking](configuration.md#secret-masking) for the exact rules.

A value can still slip through, by design. The entropy fallback ignores strings
under 24 characters, strings containing `.` `/` `:` or whitespace, strings that
are not a mix of upper, lower, and digits, and anything word-shaped — the gates
are tuned so a hostname or file path is never masked, which costs some recall.
An all-lowercase API key, or a standard-base64 secret containing `/`, is missed
unless its format is one of the known ones. Rename the key to something
`api_key`-shaped, or put the value behind an env reference, to get it covered.

Also check scope: `--mask-secrets` covers terminal output only. Add
`--mask-secrets-webhooks` for webhook payloads. And masking is opt-in: without
`--mask-secrets`, nothing is redacted regardless of how the value looks.

---

## A YAML anchor that points back at itself shows up as `<circular>`

```yaml
a: &x
  b: *x
```

A YAML anchor can alias a container that contains itself, which parses to a
genuinely cyclic object — `parsed.a.b` and `parsed.a` are the same object, not
a copy. That can't be written to a snapshot or diffed as-is (nothing can
serialize a cycle to JSON), so Flecto substitutes the fixed string
`"<circular>"` at the back-reference and normalizes the rest of the file as
usual. The file above snapshots as `{"a": {"b": "<circular>"}}`.

The substitution is deliberately just a marker, not a path back to the anchor:
two files with the same cycle shape always normalize to the same tree and
diff clean against each other, and a genuine change elsewhere in the file
still reads as a normal, stable diff path.

This is unrelated to merge keys (`<<: *base`): those resolve to a normal,
non-cyclic tree at parse time and are unaffected.

---

## Behavior reference

| Situation | What Flecto does |
|---|---|
| File not found | Error, exit 1 |
| Unsupported format | Lists supported extensions, exit 1 |
| Parse error while watching | Warning; keeps the last valid state |
| A YAML anchor that references its own container | Back-reference becomes `"<circular>"`; the rest of the file parses normally |
| Command or webhook fails | Warning, unless `--on-alert-failure exit` |
| Policy pack fails to load in watch | Exits non-zero |
| Ctrl+C | Clean shutdown |

---

## Still stuck?

- [GitHub Issues](https://github.com/myselfsiddharth/Flecto/issues) — bugs and feature requests
- [Discussions](https://github.com/myselfsiddharth/Flecto/discussions) — questions and ideas
- [SECURITY.md](../SECURITY.md) — security reports, private disclosure only
