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
