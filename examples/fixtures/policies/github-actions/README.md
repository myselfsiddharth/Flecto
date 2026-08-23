# GitHub Actions policy fixture

This fixture covers the first vertical slice of the built-in `github-actions` pack. The current
workflow adds a `pull_request_target` trigger, broadens the token to `write-all`, moves the job to a
self-hosted runner, unpins an action, checks out the pull-request head SHA, interpolates a secret in
`run`, and exposes scheduled/manual triggers.

The pack is intentionally changed-file oriented. It does not claim to be a complete workflow
linter, and it does not infer whether a job is privileged from every possible GitHub Actions
combination. Conditional blast-radius reasoning remains a later extension.

Run it with:

```sh
node ../../../index.js policies test .
```
