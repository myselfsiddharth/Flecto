# Contributing to Flecto

Thanks for helping make Flecto better. This project is open source under the MIT license.

## Quick start (dev)

```bash
git clone https://github.com/myselfsiddharth/Flecto.git
cd Flecto
npm ci
npm test
node index.js doctor
```

Node.js **20.19.0+** is required.

## How we work

1. **Open an issue first** for larger features or breaking changes (check [milestones](https://github.com/myselfsiddharth/Flecto/milestones)).
2. **Fork** and create a branch from `main`: `feat/...`, `fix/...`, `docs/...`, or `chore/...`.
3. Keep PRs focused — one concern per PR when possible.
4. Run `npm test` and `npm run pack:check` locally before pushing.
5. Fill out the PR template. PRs without a clear description may be marked draft or closed.
6. Automated checks and a review bot must pass. A maintainer review is required before merge.

## Commit & PR style

- Prefer clear, imperative commit messages (`Fix secret-on-add policy`, `Add INI parser`).
- PR titles should be concise and descriptive (conventional style encouraged: `feat:`, `fix:`, `docs:`, `ci:`, `chore:`).
- Do not force-push to `main`. Force-pushes on shared PR branches are discouraged after review has started — prefer new commits or a coordinated rebase.

## Coverage

`npm run coverage` runs the suite with Node's built-in coverage and prints a
focused report for the modules where an untested branch is a security question —
plugin resolution, pack loading, secret detection, encrypted files, and token
handling (including GitLab/Bitbucket). CI runs it on every pull request and prints it in the job log.

**No threshold gates it**, deliberately. Use it to decide where a test is worth
writing, not as a number to move. How to read it, and how to change which modules
are on the focused list, is in
[docs/security-review.md](docs/security-review.md#knowing-what-has-been-exercised).

## Fuzzing

`npm run fuzz` runs structure-aware fuzz targets over the boundary an untrusted
pull request controls — the parsers, the differ, and the regex surface in
`secrets.js`, `encrypted.js`, and policy packs. Every case is `(target, seed,
index)` and every generator is a pure function of a seeded PRNG, so a finding
replays with one command. There is no fuzzing dependency; the generators are
in `test/fuzz/`.

It never runs as part of `npm test`, and its workflow is **scheduled rather than
triggered by a pull request** — a fuzz run is a wall-clock budget against a
random seed, and gating a merge on one is a flaky merge gate.

A finding becomes a permanent regression test by moving the minimized input from
`test/fuzz/findings/` into `test/fixtures/fuzz/`; `test/fuzz-regressions.test.js`
replays everything there on every commit. How to read a finding, and why the time
budget is enforced from a parent process, is in
[test/fuzz/README.md](test/fuzz/README.md).

If a finding turns out to be exploitable rather than merely a hang, report it
privately per [SECURITY.md](SECURITY.md) — not as a public issue.

## Benchmarks

`npm run bench` generates a synthetic repo in a temp directory and reports where
`flecto ci` spends its time. It never runs as part of `npm test` or CI, and it
is not published to npm. Findings and methodology live in
[docs/performance.md](docs/performance.md) — update that page if a change moves
the numbers.

## Code guidelines

- Match existing style in `src/` and `test/` (ESM, `node:test`).
- Add or update tests for behavior changes (especially policy packs, differ, CI).
- Avoid unrelated refactors in the same PR.
- Do not commit secrets, local `.env` files, or personal tooling config.
- Do not add heavy dependencies without discussion.

## Review expectations

- CI (`.github/workflows/ci.yml`) must be green.
- Automated PR review workflow must complete.
- At least **one approving review** from a maintainer / CODEOWNER.
- Conversations should be resolved before merge.

## Security

Do **not** open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## Community

Be respectful — [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).  
Questions and ideas: GitHub Issues / Discussions.

## License

By contributing, you agree that your contributions are licensed under the MIT License.
