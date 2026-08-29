# GitHub Actions fixture — `runs-on` widened from a scalar to a list

Adding a second label while converting `runs-on` to a list is one edit, and the
differ reports it as one `changed` event whose `after` is an **array** — not as
per-element leaves, because a type change is not descended into:

```
~ jobs.build.runs-on: ubuntu-latest → [self-hosted, linux]
```

Every scalar value predicate is blind to that shape, so the rule pairs
`afterMatches` with `afterAnyMatches`, which applies the same expression to the
elements of an array value.

| Job | Change | Expected |
|---|---|---|
| `build` | `ubuntu-latest` → `[self-hosted, linux]` | `github-actions-self-hosted-runner` at `jobs.build.runs-on` |
| `lint` | `ubuntu-latest` → `[ubuntu-latest, x64]` | nothing — same shape, no `self-hosted` element |

The `lint` job is the half that matters. `afterAnyMatches` matches when *any*
element matches, so a fixture that only widened to a self-hosted runner would
pass just as well against a predicate that matched every list.

Sibling fixtures cover the `runs-on` shapes that were already handled:
`../github-actions/` (a plain string, and a list on an added job) and
`../github-actions-permission-scope/` (an element changed inside a list that
was already a list).

Run it with:

```sh
node ../../../index.js policies test .
```
