# Fuzzing the untrusted boundary

Everything `flecto ci` reads on a pull request is attacker-controlled: the config
files, their names, `.flectorc`, and the regexes inside a policy pack the same
pull request can add. [GHSA-wq8m-fc3q-8m5x] came out of that surface, and two
DoS vectors were found by hand afterwards ([`docs/security-review.md`]).

Manual review finds what someone thought to look for. This finds the next one,
and keeps finding it after the reviewer has moved on ([#150]).

```bash
npm run fuzz                                   # every target, 30s each, random seed
npm run fuzz -- --target parse-yaml --time 120 # one target, longer
npm run fuzz -- --list                         # what the targets are
npm run fuzz -- --help
```

It is **not** part of `npm test`, and the workflow that runs it is scheduled
rather than triggered by a pull request. A fuzz run is a wall-clock budget
against a random seed; gating a merge on one is a flaky merge gate.

## Targets

| Target | What it exercises |
|---|---|
| `parse-yaml` `parse-json` `parse-toml` `parse-ini` `parse-dotenv` | `parseContent()` per format — well-formed, damaged, deeply nested, oversized, and anchor/alias-heavy documents |
| `diff-trees` | `diffTrees()` over generated tree pairs, including `__proto__` / `constructor` / `prototype` keys, cycles, and deep nesting |
| `expand-subtrees` | `expandChangeSubtrees()` over generated change events |
| `secret-scan` | Flecto's **own** regexes in `src/secrets.js` against adversarial values |
| `encrypted-scan` | Flecto's **own** SOPS/age detection in `src/encrypted.js` |
| `pack-load` | `loadPack()` on malformed, oversized, and deeply nested pack JSON, and on hostile pack ids |
| `pack-eval` | `evaluatePack()` with pack-supplied regexes |

The invariant, shared by all of them: **it either succeeds or throws a clean
`Error` — never hangs, never exhausts memory, never returns a prototype-polluted
object.** Each case is also held to a time budget, because a target that takes
seconds is a denial of service on a CI runner whether or not it eventually
returns.

## Reproducing a finding

A case is `(target, seed, index)` and every generator is a pure function of a
seeded PRNG, so nothing about a finding is unrepeatable:

```
  parse-yaml — hung on case 88123 (no progress for 2000ms)
    reproduce: npm run fuzz -- --target parse-yaml --seed 3344556677 --case 88123
    replay:    npm run fuzz -- --replay test/fuzz/findings/parse-yaml-3344556677-88123.json
```

The driver shrinks the input first, so what lands in `test/fuzz/findings/` is
the smallest version it could still reproduce. That directory is not committed.

## Turning a finding into a regression test

Move the file into `test/fixtures/fuzz/`. That is the whole procedure:
`test/fuzz-regressions.test.js` replays every fixture there through the target it
names, as part of the ordinary `npm test`. No code is added per finding.

This matters because fuzzing is scheduled and probabilistic: it will not
rediscover a regression on the pull request that reintroduces it. The fuzzer's
job ends at finding an input; the suite's job is that the input runs on every
commit.

The corpus ships seeded with the vectors from the security review record — the
YAML alias bomb, the two `secrets.js` ReDoS shapes, a recursive anchor,
prototype-shaped keys, and a deeply nested pack. All of those are fixed. If one
starts failing, a fix regressed.

## Reporting

If a finding turns out to be **exploitable** rather than merely a hang, report it
privately per [`SECURITY.md`] — not as a public issue. That is also why the
scheduled workflow files nothing automatically: it uploads the minimized inputs
as an artifact and goes red, and a human decides where it goes.

## Why no fuzzing library

The project runs seven small dependencies and no test framework, so adding one
here is a real decision. The inputs are trees, config text, and regex sources —
structured, not binary protocols — and a hand-written generator over a seeded
PRNG is deterministic by construction, which is what makes `--case N` replay a
single case without walking the N-1 before it. A coverage-guided engine would
buy more on a binary parser; it buys little here.

## How the time budget is enforced

From outside the process. A hang cannot be observed from inside the process that
hung — no timer fires and no promise settles — so cases run in a child process
that writes the case index *before* running the case, and the driver kills the
child when that heartbeat stops. Shrinking runs each candidate in its own child
for the same reason: a candidate that hangs has to shrink like any other failure.

[GHSA-wq8m-fc3q-8m5x]: https://github.com/myselfsiddharth/Flecto/security/advisories/GHSA-wq8m-fc3q-8m5x
[#150]: https://github.com/myselfsiddharth/Flecto/issues/150
[`docs/security-review.md`]: ../../docs/security-review.md
[`SECURITY.md`]: ../../SECURITY.md
