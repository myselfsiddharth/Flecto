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

| measurement | median |
| --- | --- |
| `evaluatePack` over 20,000 events, 4-rule `default` pack | 10.8 ms |
| per change event | 0.54 µs |
| `evaluatePolicies()` with 12 events — the shape `ci` calls per file | 39 µs |
| — of which `loadPack()` re-resolve + re-validate | **28 µs** |
| 20,000 path tests, regex built per event (as today) | 2.96 ms |
| 20,000 path tests, regex built once | 0.67 ms |
| — per-event cost of building the regex inside the loop | 115 ns |

Two things fall out of this, both answering questions the spike was asked to
check:

**Policy pack regexes are recompiled per change event, not once per rule.**
[`matchClause()`](../src/policy.js) builds `new RegExp(match.path, …)` inside
the per-change loop. It is measurably wasteful — the same test is 4.4x slower
than with a hoisted regex — but the absolute cost is 115 ns per event per rule.
At the largest measured scale (1,060 change events, two path-matching rules in
the `default` pack) that is about **0.2 ms out of 397 ms**. Real, and not worth
changing behavior for.

**The policy pack is re-resolved and re-validated once per file.** `ci` calls
`evaluatePolicies()` per file, and that entry point calls `loadPack()`, which
does three `existsSync` probes, a `readFileSync`, a `JSON.parse`, and a full
schema validation — every time. At 1,000 files that is **~28 ms of the 35.3 ms
policy phase**: about 79% of policy time, 7% of the pipeline, 5% of end-to-end
wall time. This is the largest remaining piece of avoidable work, and it is
*not* in the differ.

It is left unfixed deliberately. The obvious fix is caching packs by resolved
path, which introduces a staleness question in a long-lived `watch` process that
this spike is not the right place to answer. See
[What was not changed](#what-was-not-changed).

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

## What was not changed

Reported, deliberately not acted on in this spike:

- **Per-file policy pack reload** (~28 µs per file, ~5% of end-to-end at 1,000
  files). Fixing it means either caching pack loads — which needs an invalidation
  story for long-running `watch` sessions — or hoisting pack loading out of the
  per-file loop in `ci`, which changes the `evaluatePolicies()` signature. Both
  are real changes needing their own tests and their own issue.
- **Regex construction inside `matchClause()`** (~0.2 ms at the largest measured
  scale). Worth tidying if that code is touched for another reason; not worth a
  behavior change on its own.
- **Baseline snapshot format.** Snapshots are pretty-printed JSON and re-reading
  them is 25% of the pipeline. A more compact encoding would help, but it is a
  file-format change with migration cost, and it is I/O and `JSON.parse` — both
  already native.

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

If large-repo performance becomes a complaint, the measured order of attack is:
the per-file policy pack reload (5%), then the snapshot format (25% of the
pipeline, unchanged since it is already native I/O), then parser choice — not a
differ rewrite.

---

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
