# GitHub Actions fixture — permissions removed, reusable trigger

Covers the two rules the trigger fixture cannot reach, because both need a
baseline the main fixture does not have.

- `github-actions-permissions-removed` — the workflow drops its explicit
  `permissions:` block, so GitHub restores the broader default token scope.
  Subtree expansion also emits a `removed` leaf per scope; the rule is anchored
  with `pathEquals` so it reports the block once, not once per scope.
- `github-actions-workflow-call-exposed` — `workflow_call` is added, making the
  workflow reachable from callers that supply their own permissions and secrets.
