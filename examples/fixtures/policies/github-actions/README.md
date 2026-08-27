# GitHub Actions policy fixture — triggering changes

The current workflow adds a `pull_request_target` trigger, broadens the token to
`write-all`, moves a job to a self-hosted runner, unpins an action, checks out
the pull-request head SHA, interpolates a secret into `run`, exposes scheduled
and manual triggers, and adds a whole new `deploy` job.

The `deploy` job is what proves the pack sees **newly added** workflow code, not
only edits to code that was already there. Because it arrives whole, subtree
expansion is the only reason its `uses`, its list `runs-on`, and its `with.ref`
are visible at all:

| Path | Rule | Shape it pins |
|---|---|---|
| `jobs.test.steps[0].with.ref` | `pull-request-head-checkout` | the wrapped `${{ … }}` expression real workflows write |
| `jobs.deploy.steps[0].with.ref` | `pull-request-head-checkout` | the bare, unwrapped value |
| `jobs.deploy.steps[0].uses` | `unpinned-action` | an unpinned action on an **added** step |
| `jobs.deploy.runs-on[0]` | `self-hosted-runner` | `self-hosted` as an element of a list `runs-on` |

The pack is changed-file oriented. It is not a workflow linter, it does not
replace `actionlint` or `zizmor`, and it does not infer privilege from every
possible workflow graph — `docs/policy-packs.md` records the specific cases it
cannot express.

Sibling fixtures cover the rest of the pack:

- `../github-actions-permissions-removed/` — the `permissions` block removed, and `workflow_call` added
- `../github-actions-permission-scope/` — one scope widened to `write`, and a list `runs-on`
- `../github-actions-benign/` — non-triggering near misses, asserting zero findings

Run any of them with:

```sh
node ../../../index.js policies test .
```
