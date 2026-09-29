# v5 proposals

Hard rule 4: no breaking changes. Anything that would require a 5.0 is parked
here instead of shipped.

This file is intentionally near-empty. Flecto went 1.x to 4.0 in four months, and
[`stability.md`](stability.md) now promises minor releases only. A long list here
would mean that promise is already being negotiated away.

Adding an entry is not a commitment to ship it. A 5.0 needs a reason as strong as
4.0's, which was a security review finding real bypasses — not an accumulation of
things that would be tidier.

---

## Parked

### P-001 — `--format json` as the default for non-TTY output

**Would break:** anything parsing human output in a pipe. Which, per
`stability.md`, was never supported — but it would still break in the field.

**Case for:** a gate whose piped output is presentational by default invites the
parsing the docs forbid.

**Why it waits:** a minor release can add an explicit opt-in
(`FLECTO_FORMAT=json`, say) and get most of the benefit with none of the break.
Try that first; if adoption of the opt-in is high, the default change has
evidence behind it.

---

## Not parked here

Two things that look like v5 material and are not:

- **New pack rules.** Additive by design; `stability.md` says a pack finding
  something new is not a breaking change. Minor releases.
- **Removing a `FLECTO_*` escape hatch.** Explicitly outside the stability
  contract, so a minor release can drop one once the situation it unblocks has a
  better answer.
