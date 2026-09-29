# How Flecto compares

An honest comparison with the tools people already use. Every claim about another
tool was checked against that tool's current documentation on 2026-09-29, and the
sources are listed at the bottom.

**The short version: Flecto is not a replacement for Checkov or Trivy.** It
answers a different question, and the sensible setup runs both. If you are
choosing only one tool and you need rule depth, choose theirs.

---

## The one real difference

Almost every tool here evaluates **a state**: it reads a configuration and asks
"is this configuration acceptable?"

Flecto evaluates **a change**: it reads two configurations and asks "what is
different, and is the difference dangerous?"

That sounds like a small distinction and it changes the output completely:

| | Question answered | Typical finding |
|---|---|---|
| Checkov / Trivy / conftest | Is this state acceptable? | "This security group violates CKV_AWS_24" |
| Flecto | What changed, and is it dangerous? | "Ingress on `aws_security_group.web` widened from `10.0.0.0/8` to `0.0.0.0/0`" |

Both are useful and they are not substitutes. A state scanner fires on the
hundredth run for a rule you have already decided to accept; the finding is true
and the reviewer has learned to scroll past it. A diff reporter is silent until
something moves, which is the thing a reviewer actually has to judge.

The flip side, stated plainly: **a diff reporter says nothing about pre-existing
problems.** If your infrastructure was already wrong before this pull request,
Flecto will not tell you. Checkov will. That is a real gap and it is why the
answer is "run both".

---

## Tool by tool

### Checkov

**What it is:** static analysis for infrastructure as code, with **more than 750
predefined policies** covering Terraform, CloudFormation and SAM, Azure ARM,
Serverless, Helm, Kubernetes, and Docker. It scans both HCL and Terraform plan
JSON.

**Where Checkov is better:**

- **Rule depth, by roughly two orders of magnitude.** Flecto's `terraform` pack
  has **10** rules and its `kubernetes` pack has **10**. Checkov has 750+. If
  you want broad misconfiguration coverage, this is not a close call.
- **Breadth of frameworks.** CloudFormation, ARM, and Serverless are not
  formats Flecto reads at all.
- **Maturity and ecosystem.** Large maintainer team, commercial backing behind
  it, and an established place in people's pipelines.

**Where Flecto is better:**

- It reports the change rather than the state, as above.
- It runs on Node with no Python toolchain, and installs from npm.
- Its output is a sentence a reviewer can act on rather than a rule ID.

**Use both.** Checkov for coverage, Flecto for what this pull request did.

### Trivy (and tfsec)

**What it is:** a scanner covering IaC misconfiguration, container images,
dependencies, and secrets. For Terraform it "recursively searches directories and
scans all found Terraform files", supports **HCL, plan JSON, and plan snapshots**,
and "evaluates variables, imports, and other elements".

**On tfsec:** tfsec is **not deprecated or archived**, but it is in transition.
Aqua's notice says they "have been consolidating all of our scanning-related
efforts in one place, and that is Trivy" — tfsec remains available while
engineering attention goes to Trivy, and a migration guide is provided. **No
sunset date is given.** If you are comparing against tfsec today, compare against
Trivy instead.

**Where Trivy is better:** everything said about Checkov's rule depth, plus a
much wider remit — container and dependency scanning are things Flecto does not
attempt.

**Where Flecto is better:** the change-versus-state difference, and that it needs
no binary on the runner.

### conftest (and Open Policy Agent)

**What it is:** "a utility to help you write tests against structured
configuration data", using **Rego**, OPA's policy language. It reads a long list
of formats — YAML, JSON, HCL/HCL2, Terraform, Dockerfile, TOML, XML, CUE,
Jsonnet, and more — and looks for `deny`, `violation`, and `warn` rules.

**Where conftest is better:**

- **Expressiveness, without limit.** Rego is a real policy language. Flecto's
  packs are declarative JSON, and its plugins are ESM modules; neither is a
  general policy engine, and there are rules you can express in Rego that Flecto
  simply cannot.
- **It is the standard** where an organisation has already committed to OPA.

**Where Flecto is better:**

- **You do not write anything to get value.** conftest ships no policies — the
  rules are yours to author and maintain. Flecto's packs work out of the box.
- It evaluates a diff. conftest "evaluates individual configurations against
  policies rather than comparing two configs or generating diffs".
- conftest has a `github` output format for Actions annotations, but no sticky
  pull request comment.

### tf-summarize

**What it is:** "a command-line utility to print the summary of the terraform
plan" — which resources are added, deleted, changed, or recreated. Table, tree,
JSON, HTML, and Markdown output.

This is the closest tool to Flecto's `flecto plan`, and the honest comparison is
narrow:

- **tf-summarize has nicer plan presentation.** Tree and 2D-tree views, HTML
  output. Flecto has one table.
- **tf-summarize makes no judgement.** It does not evaluate policies, assess
  risk, or provide exit codes based on risk. It tells you *what* changed; it does
  not tell you *which change should worry you*.
- **Flecto gates.** `--fail-on` and a meaningful exit code are the point.

If you want a readable plan summary and your reviewers supply the judgement,
tf-summarize is a lighter tool and a reasonable choice.

### dyff

**What it is:** "A diff tool for YAML files, and sometimes JSON." A structural
diff that reports changes by path, in Spruce dot-style or go-patch syntax.

**Where dyff is better:**

- **It is a focused, excellent diff**, and its path syntax is more precise than
  Flecto's for hand-navigating a large document.
- Format conversion and pretty-printing, which Flecto does not do.

**Where Flecto is better:**

- **dyff is purely a diff** — no policy evaluation, no risk reporting, no CI
  gating, no pull request comments. Its `kubectl diff` and git integrations are
  user-configured workflows, not built-in features.
- Flecto reads TOML, INI, and dotenv as well as YAML and JSON, and reads
  Terraform plan JSON and SOPS/age structure.

---

## What Flecto genuinely does that none of these do

Stated narrowly, because the list is short:

1. **One engine across YAML, JSON, TOML, INI, dotenv, Terraform plan JSON, and
   rendered Kubernetes manifests** — with SOPS and age files read for structure
   and recipients and **never decrypted**. dyff is YAML/JSON. The scanners are
   IaC-shaped and do not read your `.env`.
2. **A sticky pull request comment, out of the box.** One comment kept up to date
   across pushes, with secrets masked by default in that mode. The others need
   wiring, or post a new comment per push.
3. **No binary and no toolchain on the runner.** Flecto never invokes
   `terraform`, `helm`, `kustomize`, `sops`, or `age`. It is Node 20.19+ with 8
   runtime dependencies, installable with `npx`.
4. **A stated stability contract** for the output envelope, exit codes, and
   `.flectorc` — see [stability.md](stability.md).

## Where Flecto is weakest

Worth being direct, since a comparison page that only flatters its subject is
not worth reading:

- **Rule depth.** 10 Terraform rules and 10 Kubernetes rules. Checkov has 750+.
- **It cannot see pre-existing problems**, only changes.
- **Young, and a solo maintainer.** 1.x to 4.0 in four months, though
  [stability.md](stability.md) sets out what that churn was and what the
  commitment is now.
- **No CloudFormation, ARM, or Serverless**, and no container or dependency
  scanning.
- **Not a general policy engine.** If you need arbitrary logic, you need Rego.

## Recommended setup

```yaml
# Broad coverage: does this infrastructure have known misconfigurations?
- uses: bridgecrewio/checkov-action@v12      # or aquasecurity/trivy-action

# Change review: what did this pull request do, and is it dangerous?
- uses: myselfsiddharth/Flecto/.github/actions/flecto-pr-risk@v4.1.0
  with:
    terraform-plan: plan.json
```

They answer different questions and the findings barely overlap.

---

## Sources

Checked 2026-09-29. If any of this has gone out of date, it is a bug —
[please open an issue](https://github.com/myselfsiddharth/Flecto/issues).

- Checkov — [What is Checkov](https://www.checkov.io/1.Welcome/What%20is%20Checkov.html)
- Trivy — [Terraform coverage](https://trivy.dev/latest/docs/coverage/iac/terraform/)
- tfsec — [repository notice](https://github.com/aquasecurity/tfsec)
- conftest — [conftest.dev](https://www.conftest.dev/)
- tf-summarize — [repository](https://github.com/dineshba/tf-summarize)
- dyff — [repository](https://github.com/homeport/dyff)

Flecto's own rule counts are from `src/packs/` at 4.1.0 and can be checked with
`flecto policies list`.
