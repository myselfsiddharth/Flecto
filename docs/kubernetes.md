# Kubernetes manifests

ArgoCD, Flux, and `helm diff` all answer the same question: *how does the
cluster differ from the repository, right now?* That question can only be asked
after something has been applied.

Flecto answers a different one: **how does this pull request change what will be
applied?** You render the manifests the PR would produce, render the ones `main`
produces, and diff the two — at review time, with no cluster, no credentials,
and no admission webhook involved.

---

## The primary path: diff rendered manifests

**Flecto does not run `helm` or `kustomize`.** You render; Flecto diffs. Two
commands, no plugins, and nothing in Flecto to configure:

```bash
# Render the merge target, from a throwaway worktree so your tree is untouched.
git worktree add /tmp/base origin/main
helm template api /tmp/base/charts/api -f /tmp/base/values/prod.yaml > /tmp/base.yaml

# Render the proposed change.
helm template api ./charts/api -f values/prod.yaml > /tmp/head.yaml

# Diff the two through the differ and the kubernetes policy pack.
flecto compare /tmp/base.yaml /tmp/head.yaml --policies kubernetes --fail-on error

git worktree remove /tmp/base
```

Kustomize is the same shape:

```bash
kustomize build overlays/prod > /tmp/head.yaml   # or: kubectl kustomize overlays/prod
flecto compare /tmp/base.yaml /tmp/head.yaml --policies kubernetes --fail-on error
```

So is anything else that prints YAML — `jsonnet`, `cdk8s synth`, `kpt fn render`,
`helmfile template`, a shell script. Flecto's input is a rendered manifest file,
so the renderer is entirely your choice and never Flecto's dependency.

Multi-document YAML lands as a tree keyed by `kind/namespace/name`, so a change
reads as the resource it belongs to:

```
~ Service/prod/api.spec.type: "ClusterIP" → "LoadBalancer"
~ Deployment/prod/api.spec.replicas: 3 → 12
+ Deployment/prod/api.spec.template.spec.hostNetwork: true
- Deployment/prod/api.spec.template.spec.containers["api"].resources.limits.memory: "512Mi"
```

Containers, ports, and env vars are matched by `name` rather than by position,
so inserting a sidecar does not re-report every container after it.

### In GitHub Actions

```yaml
name: Manifest review
on: pull_request

jobs:
  rendered-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: azure/setup-helm@v4

      - name: Render base
        run: |
          git worktree add /tmp/base "${{ github.event.pull_request.base.sha }}"
          helm template api /tmp/base/charts/api -f /tmp/base/values/prod.yaml > /tmp/base.yaml

      - name: Render head
        run: helm template api ./charts/api -f values/prod.yaml > /tmp/head.yaml

      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npx flecto compare /tmp/base.yaml /tmp/head.yaml
             --policies kubernetes --fail-on error --format github-annotations
```

`--format github-annotations` puts each finding on the PR's Files-changed tab.
For a single sticky summary comment instead, see the
[`pr-comment` format](ci.md#pr-comment).

### The committed-render variant

If you commit the rendered manifests — common with Kustomize and with GitOps
repositories that hold post-render output — you do not need to render twice.
`flecto ci` reads the baseline straight out of git:

```bash
kustomize build overlays/prod > manifests/prod.yaml
flecto ci manifests/prod.yaml --snapshot-ref origin/main --policies kubernetes --fail-on error
```

This is the cheapest possible setup: one render, one command, and the baseline
is whatever the merge target holds.

---

## The `kubernetes` policy pack

```bash
flecto compare base.yaml head.yaml --policies kubernetes
flecto compare base.yaml head.yaml --policies kubernetes,default   # add secret detection
```

| Rule | Severity | Fires when |
|---|---|---|
| `k8s-privileged-container` | error | `securityContext.privileged` turns on |
| `k8s-host-namespace-shared` | error | `hostNetwork`, `hostPID`, or `hostIPC` turns on |
| `k8s-run-as-non-root-weakened` | error | `runAsNonRoot` is set to `false`, or an enforced `true` is dropped |
| `k8s-allow-privilege-escalation` | error | `allowPrivilegeEscalation` turns on, or an explicit `false` is dropped |
| `k8s-dangerous-capability-added` | error | `capabilities.add` gains `SYS_ADMIN`, `NET_ADMIN`, or `ALL` |
| `k8s-image-tag-unpinned` | error | A container image resolves to `:latest` — an explicit `:latest` tag, or no tag at all |
| `k8s-image-pull-policy-always` | warn | `imagePullPolicy` moves to `Always`, so a restart can pull different bits behind one tag |
| `k8s-replica-count-jump` | warn | `spec.replicas` grows at least 3× *and* by at least 3 |
| `k8s-resource-limits-removed` | warn | A `resources.limits.*` entry is removed |
| `k8s-service-externally-exposed` | error | A Service becomes `LoadBalancer` or `NodePort` |

The thresholds are deliberately loose where routine work would otherwise trip
them. `k8s-replica-count-jump` needs both a 3× multiple and an absolute increase
of 3, so `1 → 2` for HA and `4 → 6` for headroom stay quiet while `3 → 12` does
not. `k8s-image-pull-policy-always` only fires on a *change*, because a new
workload declaring `Always` has not moved off anything.

Every rule is declarative JSON in
[`src/packs/kubernetes.json`](../src/packs/kubernetes.json). Copy it to
`policies/kubernetes.json` to edit it — a local pack of the same id wins — or
retune single rules per profile with `severityRemap`, documented in
[policy packs](policy-packs.md).

### Whole-subtree changes

The differ reports an added key once, carrying its entire subtree as the value.
A brand-new `Service` document is therefore *one* change at
`Service/prod/debug.…`, not a change per field — and a rule anchored at
`spec.type` would never see inside it. That is the single most common shape in a
manifest pull request, so the `kubernetes` pack sets `expandSubtrees: true`,
which expands added and removed subtrees into the leaf changes they imply before
rules run:

```json
{ "id": "kubernetes", "expandSubtrees": true, "rules": [] }
```

A rule then fires the same way whether a field changed in place or arrived with
its parent. Two consequences worth knowing:

- A finding's path can be **deeper than any reported change** — the finding
  points at `Service/prod/debug.spec.type` while the change list shows the
  document arriving whole. That is intentional: the finding names the risk.
- Removing a container reports each limit it carried as a removed limit. The
  path makes the cause obvious, and a pull request deleting a workload is worth
  a second look regardless.

The flag is per pack and off by default, so `default`, `strict-prod`,
`compose`, and `node-runtime` behave exactly as they always have.

---

## Limits

Read this part before trusting the result.

**Flecto does not render anything.** No chart resolution, no dependency
fetching, no values merging, no `lookup`. `helm` and `kustomize` are not
dependencies, are not invoked, and are not required in CI. This is a deliberate
trade: rendering is your renderer's job and it already does it well, and a
Flecto that shelled out would fail on every runner that lacks the binary. What
you get in exchange is that any renderer works, including ones that do not exist
yet.

**It is not a cluster drift tool.** Flecto never reads live state. Defaults the
API server would inject, mutating admission webhooks, and anything a controller
writes back are all invisible — it sees exactly the YAML you rendered. An
omitted `allowPrivilegeEscalation` defaults to `true` in the cluster; Flecto
only reports it if the field is actually in the manifest. For live drift, ArgoCD
and Flux are the right tools, and they compose fine with this.

**It is not a validator.** No OpenAPI schema check, no CRD awareness, no
`kubectl --dry-run`. A manifest the API server would reject looks fine here.
Pair it with `kubeconform` or `kubectl apply --dry-run=server`.

**It is not a complete policy engine.** Ten rules for changes that are risky at
review time — not a PSS or CIS benchmark. Kyverno, OPA/Gatekeeper, and
`kube-score` audit whole manifests against a full corpus; Flecto looks at what
*changed*, which is a smaller and differently shaped question. The rules are
path-shaped heuristics: `k8s-service-externally-exposed` matches any
`spec.type` becoming `LoadBalancer` or `NodePort`, which a CRD could in
principle trip.

**Rendering must be deterministic.** A chart using `randAlphaNum`, a timestamp,
or `lookup` produces a fresh value on every render and turns into diff noise.
Ignore those paths explicitly:

```bash
flecto compare base.yaml head.yaml --policies kubernetes \
  --ignore '**.helm.sh/chart,**.checksum/config'
```

**Document identity needs `kind` and `metadata.name`.** Documents are keyed
`kind/namespace/name`. If two documents in one file collide on that key, or a
document lacks it, Flecto falls back to positional keys (`0`, `1`, …) for the
whole file — reordering the render then reads as a wall of changes. Renderers
are stable in practice, but a template emitting documents conditionally can
shift positions.

**A single manifest is keyed by identity too.** A file holding one
Kubernetes-shaped document (`apiVersion` + `kind` + `metadata.name`) is keyed
`kind/namespace/name` exactly as it would be inside a multi-document file, so its
paths look the same whether it stands alone or gains a sibling. This is what lets
you add a `Service` next to an existing `Deployment` and see a single addition
rather than the whole file re-pathing. Ordinary single-document YAML — anything
without both `apiVersion` and `kind` — is untouched and keeps its bare paths.

---

## See also

- **[CI](ci.md)** — baselines, fail triggers, output formats, bundled Actions
- **[Policy packs](policy-packs.md)** — the rule schema, local overrides, `severityRemap`
- **[CLI reference](cli-reference.md)** — every flag on `compare` and `ci`
