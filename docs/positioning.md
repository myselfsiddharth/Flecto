# Positioning

**Status: CONFIRMED by the maintainer, 2026-09-28.** The primary pitch below is
the one to use. Downstream surfaces (npm `description` and `keywords`, repo
About, Marketplace listing, launch copy) are now unblocked; npm metadata is
updated, the repo About and README H1 follow in Phase 3.

Last updated 2026-09-28.

---

## The problem this fixes

Flecto currently presents itself as a watcher, a CI gate, a Terraform reviewer, a
Kubernetes policy tool, a SOPS auditor, a notifier, a report generator, an MCP
server, and an LSP. Every one of those is real and works. Together they tell a
visitor nothing, because a tool that does nine things is a tool with no occasion
to reach for.

The current tagline — "semantic config watcher" — leads with `flecto watch`,
which is the least valuable of the nine. A local file watcher is a nice
development affordance. It is not why anyone adopts a tool, it is not where the
pain is felt, and "semantic config watcher" is a phrase nobody searches for.

---

## Proposed wedge

**Plain-English risk review of infrastructure changes on every pull request**,
specifically Terraform plans and rendered Kubernetes manifests, with the risky
ones blocked.

### Proposed one-line pitch

> Flecto reads your Terraform plan and Kubernetes changes and posts a
> plain-English risk summary on every pull request, blocking the dangerous ones.

### Alternative A — problem-led

> Your Terraform plan is 800 lines and nobody reads it. Flecto posts the three
> changes that actually matter as a pull request comment, and fails the build on
> the ones that shouldn't merge.

Concrete and it earns a nod, because the reader has skimmed that plan. Longer
than one line, and the specific numbers make it awkward to reuse verbatim in an
npm `description` field or a Marketplace blurb.

### Alternative B — category-led

> Plain-English risk review for infrastructure pull requests. Flecto turns a
> Terraform plan or a Kubernetes diff into a summary a reviewer can act on, and
> blocks the changes that shouldn't merge.

Reads like an established category, which helps in a listing next to competitors.
Weaker on the specific moment of pain, and "risk review" is vaguer than naming
the plan file.

### Decision

**Confirmed: the primary pitch.** It names the two inputs a searcher actually types
(Terraform, Kubernetes), it names the artifact (a pull request comment), and it
names the consequence (blocking). Keep Alternative A as the opening line of the
launch blog post and the Show HN body, where there is room for a story.

---

## Why this wedge

- **The pain is widely felt.** Reading `terraform plan` output and Helm diffs in
  review is a daily annoyance for anyone with infrastructure in git.
- **The pull request is the moment of pain.** It is when someone must decide to
  approve, with the least context and the most consequence. `flecto watch` is
  active at a moment when nobody is anxious.
- **It needs packaging, not features.** `flecto plan`, the `terraform` and
  `kubernetes` packs, `--format pr-comment`, and the `flecto-pr-risk` Action all
  already exist and work. This is a sequencing and front-door decision.
- **It is searchable.** "terraform plan review", "terraform pr comment",
  "kubernetes manifest diff ci" are things people type. "semantic config watcher"
  is not.

## What this wedge does not claim

Stated here so it does not get overstated in copy later. Verified against the
packs in `src/packs/` on 2026-09-28:

- **The `terraform` pack has 10 rules; the `kubernetes` pack has 10.** Checkov
  ships on the order of a thousand. Flecto is **not** a deep policy library and
  must never be marketed as one. It catches a small set of changes that are
  nearly always worth a second look — open ingress, a destroyed stateful
  resource, an IAM wildcard, a privileged container, an unpinned image, limits
  removed — and it explains them in a sentence.
- **The differentiator is the diff, not the rule count.** Checkov and tfsec scan
  a state; Flecto reports a *change*, in review, in prose. "This destroys
  `aws_db_instance.main`" is a different product from "this resource violates
  CKV_AWS_17", even where both fire. Claims like these belong in
  `docs/comparison.md` with the competitor's current docs cited (Phase 3).
- **It never runs `terraform`, `helm`, `kustomize`, `sops`, or `age`,** and never
  decrypts. That is a genuine differentiator for CI and should stay in the pitch
  area, because it is also the honest answer to "what does it not do".

## What happens to the other eight features

Nothing is removed or deprecated. They move out of the headline and into docs:
watch mode, webhooks and commands, HTML reports, `flecto explain`, MCP, LSP,
SOPS/age, `flecto-drift`, and compare. The README gets a single
"Also works as" section with one line each, linking out (Phase 3).

`flecto explain` is worth a note: it is the feature that most directly delivers
"plain-English", and the pitch's phrasing is deliberately true **without** it —
the packs and the semantic diff already produce prose. `explain` is opt-in,
bring-your-own-key, and advisory, so it must not become load-bearing in the
pitch or the pitch stops being true for the default install.

---

## Where the pitch has to be changed once confirmed

| Surface | Current | Blocked on |
|---|---|---|
| `package.json` `description` | "semantic config watcher that reports meaningful changes in plain English" | confirmation |
| `package.json` `keywords` | no `terraform`, `kubernetes`, `pull-request`, or `code-review` | confirmation |
| Repo About | "Semantic config watcher — plain-English diffs, policy packs, CI gates, and webhooks" | confirmation |
| Repo topics | has the right ones, but `watchers`/`diff` lead | confirmation |
| README H1 area | "Know what your config actually changed — and whether it's risky" | Phase 3 |
| Marketplace listing | does not exist | Phase 2 |

The README's current subtitle is already closer to the wedge than the npm
description is, so the npm and About fields are the widest gap.

## Open question for the maintainer

Terraform and Kubernetes are named together in the pitch, which is two wedges
wearing one coat. If adoption data later shows one of them is doing all the work,
the pitch should narrow to it. Revisit at Phase 6's quarterly check with real
usage rather than guessing now.
