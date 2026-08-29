# Performance

Where Flecto spends its time on a large repo, measured rather than guessed.

This page exists to answer one question from the v3.0 milestone: **is a compiled
or native differ core justified?** The short answer is no — see
[The recommendation](#the-recommendation). Everything below is the evidence.

---

## Running the benchmark

```bash
npm run bench                          # 50 / 250 / 1000 files, 11 runs each
npm run bench -- --runs 15             # more samples
npm run bench -- --quick               # fast smoke run
npm run bench -- --scales 2000         # one scale
npm run bench -- --json results.json   # keep the raw samples
npm run bench -- --keep                # leave the generated repo on disk
```

The harness lives in [`bench/`](../bench). It uses `node:perf_hooks` and no
benchmarking dependency, it does **not** run during `npm test` or in CI, and
`bench/` is excluded from the published npm package.

---

## Methodology

The harness generates a synthetic repo in a temp directory and deletes it
afterwards — no fixtures are committed. At each scale it writes N config files
across a nested `config/**` tree, discovered through a glob-heavy `.flectorc`:

- a weighted mix of YAML, JSON, TOML, INI, and `.env` files;
- every 10th file (offset 3) carries a **15-level-deep** nested branch;
- every 50th file carries a **5,000-entry array** of objects with `id` and
  `name` keys — the shape array identity matching has to work hardest on;
- every 10th file is **mutated** after the baseline snapshot: a scalar change, a
  key added, a key removed, a `pool_size` tripled, `debug` flipped on, an
  `API_KEY` rotated, small arrays reordered, and in the large-array files one
  entry changed, one removed, one appended, and the whole array rotated by one.

Then it measures, in this order:

1. **`flecto watch --snapshot`** — cold (empty snapshot dir) and warm (a prior
   run's snapshots and history already on disk). Directory resets happen outside
   the timer.
2. **`flecto ci --format json`** end to end, as a real subprocess, with stdout
   discarded.
3. **The same pipeline in-process**, calling the same exported functions in the
   same order, with a `performance.now()` bracket around each phase. This is the
   attribution deliverable.
4. **Microbenchmarks** isolating array diffing across sizes and policy
   evaluation.

Each measurement discards one warmup run and reports the median and p95 of the
rest. **p95 from 15 samples is effectively "worst observed"** — read it as a
stability indicator, not a real tail estimate. Run-to-run variance on repeated
full runs of the unchanged pipeline was within roughly ±10%, so differences
smaller than that mean nothing.

### The machine

| | |
| --- | --- |
| Node | v24.18.1 |
| Platform | darwin arm64 |
| CPU | Apple M1 Pro, 10 logical cores |
| Memory | 32 GB |
| Runs | 15 per measurement (+1 discarded warmup); 5 per snapshot measurement |

**Results are machine-dependent.** A CI runner with slower I/O will produce
larger absolute numbers. The ratios and the phase shares are the transferable
part; the milliseconds are not.

---

## The numbers

### End-to-end wall time

| files | config on disk | change events | policy findings | `flecto ci` median | p95 | `watch --snapshot` cold | `watch --snapshot` warm |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 50 | 1.2 MB | 53 | 15 | **128 ms** | 161 ms | 120 ms | 120 ms |
| 250 | 6.0 MB | 265 | 75 | **236 ms** | 254 ms | 219 ms | 213 ms |
| 1000 | 24.0 MB | 1060 | 300 | **550 ms** | 567 ms | 533 ms | 565 ms |

For reference, the floor under any run: a bare `node -e 0` takes 37.8 ms and
`flecto --version` takes 77.0 ms. That 77 ms is process start plus Flecto's
module graph, and it is paid before any config is read.

So **at 50 files, 60% of the wall time is process startup.** At 1000 files it is
14%. The pipeline itself costs roughly 0.4 ms per file at every scale.

### Phase attribution

Medians of 15 in-process runs. Shares barely move across scales, which is the
main result: nothing here is superlinear.

| phase | 50 files | 250 files | 1000 files | share @1000 |
| --- | --- | --- | --- | --- |
| glob discovery | 1.9 ms | 2.4 ms | 4.3 ms | 1.1% |
| snapshot (baseline) load | 5.2 ms | 24.6 ms | 99.0 ms | 24.9% |
| **parse** | 6.2 ms | 27.8 ms | 110.5 ms | **27.8%** |
| **diff** | 8.2 ms | 35.5 ms | 139.4 ms | **35.1%** |
| policy evaluation | 2.2 ms | 9.0 ms | 35.3 ms | 8.9% |
| serialize output | 0.1 ms | 0.4 ms | 1.2 ms | 0.3% |
| other (fs checks, envelope) | 0.3 ms | 2.5 ms | 7.2 ms | 1.8% |
| **pipeline total** | **24 ms** | **102 ms** | **397 ms** | 100% |

Read together: **diff is the largest single phase at ~35%, but reading and
decoding input — snapshot load plus parse — is ~53%.** Policy evaluation, the
part with the most user-visible surface area, is under 9%.

The "snapshot load" phase is `JSON.parse` of the pretty-printed baseline files.
It is roughly as expensive as parsing the config itself, because the baselines
are the same trees written back out as JSON.

### Array diffing

The most plausible place for an accidental O(n²) is array identity matching.
It is not there. `growth` is median(size) / median(size/2); ~2.0 is linear.

| strategy | 1k | 2k | 4k | 8k | 16k | 32k | growth (last step) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| identity, auto-detected `id` | 1.17 | 2.27 | 4.58 | 9.92 | 20.97 | 44.28 ms | 2.11x |
| identity, array rotated | 1.11 | 2.31 | 4.58 | 9.64 | 20.59 | 44.39 ms | 2.16x |
| by index (`--no-array-id`) | 0.75 | 1.54 | 3.07 | 6.17 | 12.30 | 25.00 ms | 2.03x |
| `--array-ignore-order`, no id | 2.56 | 5.04 | 10.95 | 22.07 | 45.25 | 93.04 ms | 2.06x |

Every strategy doubles when the input doubles, at every step, up to 32,000
items. Identity matching costs about 1.8x index diffing (it builds hash maps and
compares JSON-quoted keys); `--array-ignore-order` costs about 3.7x index
diffing because it canonicalizes and stringifies each element to form a multiset
signature. Both are constant factors, not complexity problems.

Rotating the array — the case identity matching exists for — costs nothing
extra, and correctly produces no change events for the reordering itself.

### Policy evaluation

This table is the original spike measurement — the state before the fix
described in
[Policy pack caching and regex hoisting](#policy-pack-caching-and-regex-hoisting-fixed)
below. It is kept as the historical baseline that motivated that fix.

| measurement | median |
| --- | --- |
| `evaluatePack` over 20,000 events, 4-rule `default` pack | 10.8 ms |
| per change event | 0.54 µs |
| `evaluatePolicies()` with 12 events — the shape `ci` calls per file | 39 µs |
| — of which `loadPack()` re-resolve + re-validate | **28 µs** |
| 20,000 path tests, regex built per event (as today) | 2.96 ms |
| 20,000 path tests, regex built once | 0.67 ms |
| — per-event cost of building the regex inside the loop | 115 ns |

Two things fell out of this, both answering questions the spike was asked to
check — and both are now fixed:

**Policy pack regexes were recompiled per change event, not once per rule.**
[`matchClause()`](../src/policy.js) built `new RegExp(match.path, …)` inside
the per-change loop. It was measurably wasteful — the same test is 4.4x slower
than with a hoisted regex — but the absolute cost was 115 ns per event per
rule: at the largest measured scale (1,060 change events, two path-matching
rules in the `default` pack) about **0.2 ms out of 397 ms**. Real, but not
worth a standalone behavior change on its own — it was folded into the
pack-loading refactor below instead, per its issue's own recommendation.

**The policy pack was re-resolved and re-validated once per file.** `ci` calls
`evaluatePolicies()` per file, and that entry point calls `loadPack()`, which
did three `existsSync` probes, a `readFileSync`, a `JSON.parse`, and a full
schema validation — every time. At 1,000 files that was **~28 ms of the
35.3 ms policy phase**: about 79% of policy time, 7% of the pipeline, 5% of
end-to-end wall time — the largest remaining piece of avoidable work outside
the differ.

Both are fixed by caching loaded packs across a run. See
[Policy pack caching and regex hoisting](#policy-pack-caching-and-regex-hoisting-fixed).

---

## The one real hot spot found (and fixed)

`flecto watch --snapshot` was quadratic in the number of tracked files — but
only on the second and later runs against the same repo.

Deciding whether a file already had snapshot history listed the entire
`.flecto-snapshots/` directory *once per file*, and compiled a fresh regular
expression *once per directory entry*. With N tracked files the directory holds
about 2N entries, so re-snapshotting cost N listings of O(N) entries each.

Measured with the same harness, before and after:

| files | `watch --snapshot` warm, before | after | |
| --- | --- | --- | --- |
| 50 | 117 ms | 120 ms | unchanged |
| 250 | 313 ms | 213 ms | 1.5x faster |
| 1000 | **2229 ms** | **565 ms** | **3.9x faster** |

The quadratic term is the gap between warm and cold runs. Before the fix it was
6 ms / 105 ms / 1691 ms at 50 / 250 / 1000 files: a 4x increase in file count
grew it 16x, textbook O(n²). After the fix, warm and cold runs are the same
speed at every scale.

An isolated probe over a directory of 2,000 entries showed where the cost
actually sat: 1,000 lookups took 1268 ms as written, 1116 ms with the regex
hoisted out of the callback, and 1089 ms doing the directory listings and no
matching at all. The regex was the small half of the problem; **the repeated
`readdirSync` was the real one.** So the fix lists the directory once per run
and threads the resulting id set through the loop, rather than just hoisting the
regex.

The first snapshot of a repo never took this path (it returns early when no
baseline file exists) and is unchanged. `flecto ci` never took this path at all.

---

## Policy pack caching and regex hoisting (fixed)

Addresses [#92](https://github.com/myselfsiddharth/Flecto/issues/92) and
[#93](https://github.com/myselfsiddharth/Flecto/issues/93) together, in one
change — #93 explicitly recommended folding the regex hoisting into whichever
refactor next touched rule compilation, rather than doing it standalone, and
#92 is exactly that refactor.

**The fix.** `loadPack()` now caches the loaded, validated, regex-compiled
pack object across a run. The cache key is `(cwd, resolvedPath, mtimeMs)`:

- `resolvedPath` comes from `resolvePackPath()`, which still runs on *every*
  call — it is a handful of `existsSync` probes, not the expensive part — so a
  local `policies/<id>.json` that starts or stops shadowing a built-in pack
  mid-run changes the resolved path and is picked up immediately, cache or no
  cache.
- `mtimeMs` is `statSync(resolvedPath).mtimeMs`. Editing the pack file changes
  the key, so the very next `loadPack()` call — the next file in `ci`, or the
  next change event in `watch` — re-reads and re-validates it. A pack that
  fails to parse or fails schema validation still throws exactly as before;
  nothing in the cache catches that and falls back to serving the last-good
  pack, which is precisely the silent-staleness regression #92 warned against.
- `cwd` is included so two different working directories never share a slot
  merely because they resolved a same-named local pack.
- `severityRemap` is **not** part of the key. It is applied downstream, per
  profile, inside `evaluatePack()` — a plain lookup against the cached pack's
  rules that never mutates the cached object. Caching sits below remapping,
  so two calls with different `severityRemap` values against the same cached
  pack get independently correct severities, and one profile's remap can never
  leak into another's findings.

`matchClause()`'s regex construction (#93) moves to the same place: a new
`compilePackRegexes()` step, run once per pack load (cache miss only), walks
every rule — including `allOf`/`anyOf` clauses — and attaches a pre-compiled
`RegExp` for `match.path` and `afterMatches` as a non-enumerable property on
the rule/clause object. `matchClause()` reads it instead of constructing a new
one per change event. `pathFlags` still applies (it is part of what gets
compiled), and because compilation only runs after `validatePack()` has
already proven the pattern constructs a valid `RegExp`, an invalid
`match.path` or `afterMatches` still fails at load time with the same message
as before — nothing about *when* the regex is built changes what makes it
invalid.

**Measured, honestly.** Two independent `npm run bench -- --runs 15` sessions
were run back-to-back on this machine, each alternating a `git stash` to the
pre-change code (before) and the change applied (after), so both states were
measured under the same ambient load. Numbers below are the average of the
two sessions' medians (30 samples total per state at each scale). This
session's absolute milliseconds run higher than the rest of this document —
same reported CPU, different ambient load in this environment — so read the
ratios here, not the absolute numbers, against the rest of the page.

| files | policy phase, before | policy phase, after | change |
| --- | --- | --- | --- |
| 50 | 2.45 ms | 1.00 ms | ~59% faster |
| 250 | 9.70 ms | 4.05 ms | ~58% faster |
| 1000 | 37.85 ms | 14.80 ms | ~61% faster |

| measurement | before | after | change |
| --- | --- | --- | --- |
| `evaluatePolicies()` with 12 events | 0.0425 ms | 0.016 ms | ~62% faster |
| — of which `loadPack()` | 0.0295 ms | 0.008 ms | ~73% faster |

The policy-phase and `loadPack()` numbers are large, consistent in direction
across both sessions, and land exactly where the mechanism predicts — a cache
hit skips a `readFileSync`, a `JSON.parse`, and a full schema walk, keeping
only a `statSync` and a Map lookup. That part is a real, reproducible win.

End-to-end `flecto ci` wall time also improved, but more modestly and closer
to this document's own documented ±10% run-to-run noise band for full
subprocess runs:

| files | `ci` median, before | `ci` median, after | change |
| --- | --- | --- | --- |
| 50 | 136.5 ms | 130.5 ms | ~4% faster |
| 250 | 278 ms | 275 ms | ~1% faster, within noise (one session alone showed 273→287 ms, i.e. slower) |
| 1000 | 712 ms | 660 ms | ~7% faster |

At 1,000 files — where the pipeline does the most real work relative to
process-startup overhead — both sessions agreed the change is faster, never
reversed. At 250 files the two sessions disagreed on direction, which is
exactly what "within noise" looks like. Policy evaluation was ~5% of
end-to-end wall time before this fix (per the original spike, above), so an
end-to-end improvement in the low single digits to high single digits,
rather than a dramatic one, is what the mechanism predicts — this fix removes
avoidable work from a phase that was never the bottleneck.

---

## What was not changed

Reported in the original spike as deliberately not acted on at the time — the
first two have since been fixed; see
[Policy pack caching and regex hoisting](#policy-pack-caching-and-regex-hoisting-fixed):

- ~~**Per-file policy pack reload**~~ Fixed: `loadPack()` now caches by
  `(cwd, resolvedPath, mtime)` across a run.
- ~~**Regex construction inside `matchClause()`**~~ Fixed, folded into the same
  change: compiled once per rule at pack-load time instead of once per change
  event.
- **Baseline snapshot format.** Snapshots are pretty-printed JSON and re-reading
  them is 25% of the pipeline. A more compact encoding would help, but it is a
  file-format change with migration cost, and it is I/O and `JSON.parse` — both
  already native. Still the next-largest piece of avoidable work.

---

## The recommendation

**A compiled or native differ core is not justified.** The data does not support
it:

1. **The differ is not the bottleneck.** It is 35% of the in-process pipeline
   and 25% of end-to-end wall time at 1,000 files. Even an infinitely fast
   differ would take `flecto ci` on a 1,000-file, 24 MB repo from 550 ms to
   about 410 ms. That is not a problem anyone has.
2. **The differ is already linear.** Every array strategy, including identity
   matching and `--array-ignore-order`, scales at ~2.0x per doubling up to
   32,000 items. There is no complexity bug for a rewrite to fix — only constant
   factors.
3. **Most of the time is already in native code.** Parsing (27.8%) is inside
   `js-yaml`, `JSON.parse`, and `@iarna/toml`; snapshot loading (24.9%) is
   `readFileSync` plus `JSON.parse`. A native differ would not touch either.
4. **At realistic repo sizes, process startup rivals the work.** 77 ms of
   Flecto's 128 ms at 50 files is boot and module loading. Below a few hundred
   files, a faster differ is invisible.
5. **The cost is real.** A native core means a build toolchain, prebuilt
   binaries per platform and per Node ABI, an install-time fallback path, and a
   second implementation of semantics — array identity, ignore patterns,
   multi-document YAML keys — that currently exist once and are covered by the
   test suite.

If large-repo performance becomes a complaint, the measured order of attack was
the per-file policy pack reload (5%, now fixed — see
[Policy pack caching and regex hoisting](#policy-pack-caching-and-regex-hoisting-fixed)),
then the snapshot format (25% of the pipeline, unchanged since it is already
native I/O), then parser choice — not a differ rewrite.

---

## Context savings

Flecto is often described as a cheaper way to find out what changed than reading
the config itself — relevant when the reader is paying by the byte, as an agent
reading into a context window does. Section 5 of the harness measures that claim
instead of asserting it. The measurement is in bytes, which are exact; tokenizers
disagree with each other and would date the number.

### One key changed, in a file that grows

This is the shape the claim is actually about.

| keys in file | file | one-file `ci` payload | payload vs file |
| --- | --- | --- | --- |
| 10 | 1.4 KB | 0.6 KB | 2.4x |
| 50 | 7.0 KB | 0.6 KB | 12.4x |
| 200 | 28.3 KB | 0.6 KB | 49.9x |
| 1000 | 142.4 KB | 0.6 KB | 250.9x |
| 5000 | 720.5 KB | 0.6 KB | 1269.8x |

A change event plus its envelope costs a fixed ~600 bytes. The payload does not
grow with the file, so the advantage compounds: past a kilobyte or so of config,
reading the diff is dramatically cheaper, and by a 1,000-key file it is two
orders of magnitude cheaper.

**The floor is real.** Below ~600 bytes of config there is nothing to save, and
a tiny file plus a tiny change is cheaper to read whole.

### Across a repo, at three mutation rates

250 synthetic service configs, `--format json`:

| change | files | changes | corpus | changed files | `ci` output | payload only | payload vs changed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| one file changed | 1 | 10 | 227.8 KB | 0.9 KB | 156.5 KB | 3.4 KB | 0.3x |
| every 10th file changed | 25 | 250 | 229.4 KB | 22.9 KB | 223.3 KB | 85.0 KB | 0.3x |
| every file changed | 250 | 2400 | 242.5 KB | 242.5 KB | 810.9 KB | 810.9 KB | 0.3x |

Two things this says, both worth stating plainly.

**A dense change is not cheaper as a diff.** These fixture files are ~900 bytes
and each mutated one takes ten edits — roughly a quarter of its keys. At that
density a change event costs more bytes than the value it describes, and the
payload runs about 3x the size of the files it covers. The advantage in the
first table comes from *sparsity*, not from the diff format.

**`ci --format json` emits an envelope per scanned file, changed or not.** Each
carries a schema version, two UUIDs, a timestamp, and an absolute path. With one
file changed out of 250, the output is 156 KB of which 3.4 KB is semantic
content: the boilerplate is ~98% of the payload, and it scales with repo size
rather than with the size of the change. Anything quoting a context-savings
number from `ci` output today is mostly measuring envelope overhead.

### What this means for the claim

The claim holds, with its conditions attached: **a sparse change in a large file
is one to three orders of magnitude cheaper to read as a semantic diff than as
the file.** It does not hold for dense changes, it does not hold for small files,
and it is currently obscured in `ci --format json` by per-file envelopes for
files that did not change.

The corpus here excludes the 5,000-item array fixtures used by the timing
sections. They are a differ stress test and would be ~90% of the corpus by byte
count, which would flatter the ratio without describing any real repository.

## What this benchmark does not tell you

Being explicit about the limits of a synthetic harness:

- **It is one machine.** Apple M1 Pro with a fast SSD and a warm page cache.
  A cold cache, network storage, or a shared CI runner will shift the I/O-bound
  phases (snapshot load, parse, discovery) far more than the CPU-bound ones.
- **The fixtures are synthetic.** Real config files vary in comment density,
  anchors and aliases, string-heavy vs numeric content, and how deeply the
  *changes* nest. YAML parse cost in particular is sensitive to features the
  generator does not emit (anchors, merge keys, block scalars, multi-document
  streams).
- **The mutation pattern is fixed.** 10% of files change, each in the same
  handful of ways. A run where every file changes shifts weight toward diff,
  policy, and output; a run where nothing changes shifts it toward parse.
- **Live `watch` was not measured end to end.** Chokidar's event latency,
  debouncing, and the OS file-watch layer are outside the harness. What is
  measured is the per-change work `watch` performs, which is the same
  parse/diff/policy path `ci` uses, plus `watch --snapshot` as a batch path.
- **`--ignore` patterns were not measured.** The ignore matcher scans its
  pattern list per emitted change event; with a handful of patterns that is
  trivial, but a config with hundreds of ignore patterns was not tested.
- **Plugins were not measured.** A policy plugin is arbitrary user code and its
  cost is unbounded by anything Flecto controls.
- **p95 comes from 15 samples**, so it is closer to "worst of 15" than a real
  95th percentile, and GC pauses land in it unevenly.
- **Only `--format json` was measured.** `pr-comment` and `github-annotations`
  do more per-change formatting work, which the 0.3% serialize figure does not
  cover.
