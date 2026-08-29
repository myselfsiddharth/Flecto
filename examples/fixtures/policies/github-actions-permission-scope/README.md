# GitHub Actions fixture — per-scope write, list `runs-on`

- `github-actions-permission-write-scope` — one scope is widened to `write`
  while the rest stay `read`, which is the shape a least-privilege block
  actually regresses in. `contents: read` is unchanged and produces nothing.
- `github-actions-self-hosted-runner` — `runs-on` is a **list**. A list is
  diffed element by element, so `self-hosted` arrives as its own leaf at
  `jobs.publish.runs-on[0]`; `linux` at `[1]` matches nothing.

The fourth `runs-on` shape — a scalar widened to a list in one edit — lives in
`../github-actions-runs-on-widened/`.
