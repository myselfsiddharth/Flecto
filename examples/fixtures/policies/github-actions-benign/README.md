# GitHub Actions fixture — non-triggering changes

Every change here is a near miss for a rule in the pack, and the expected
finding set is empty. A security pack that cannot stay quiet gets suppressed,
so each rule needs a case that proves the remediation actually clears it.

| Change | Rule it must not trigger |
|---|---|
| `permissions:` **added**, read-scoped | `permissions-removed`, `permissions-write-all`, `permission-write-scope` |
| `pull_request` unchanged | `pull-request-target` |
| `uses` moved from one 40-char SHA to another | `unpinned-action` |
| a local `./.github/actions/setup` step added | `unpinned-action` (no ref to pin) |
| a new `lint` job pinned to a SHA | `unpinned-action` on the `added` path |
| `with.ref` set to `${{ github.base_ref }}` | `pull-request-head-checkout` |
| `run` interpolating `${{ env.BUILD_ID }}` | `secrets-in-run` |
| `runs-on: [ubuntu-latest]` on a new job | `self-hosted-runner` on the list path |
