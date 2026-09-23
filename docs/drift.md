# Live-vs-declared drift

Flecto answers *"what changed in this file"*. The question underneath it is
usually **"does what we declared still match what is running"** — the config
committed six months ago, against the value somebody hotfixed into the cluster
at 3 AM and never backported.

```bash
flecto-drift config/prod.yaml --against k8s://production/configmap/api
```

```
config/prod.yaml — 2 changes from k8s configmap production/api:
  ~ pool_size: "5" → "50"
  ~ tls: "true" → "false"
```

## It is a separate binary, deliberately

Every other Flecto command authenticates to nothing: it reads files, shells out
to nothing but `git`, and touches no key material. That is a real promise, and
`drift` is the one thing that cannot keep it.

So it does not share an entry point with the tool that can. `flecto ci` cannot
reach it, nothing in `src/` outside `drift-sources.js` imports it, and
installing Flecto does not enable it — you have to run a different binary, on
purpose. The intent is for it to become its own package with its own security
review and release cadence.

**If you never run `flecto-drift`, nothing about Flecto's posture changes.**

## It holds no credentials

There is no `--token`, no `--kubeconfig`, no `--profile`, and no environment
variable Flecto reads for authentication. Every live source delegates to a tool
you have already installed and already authenticated:

| Source | Tool | Command |
|---|---|---|
| `k8s://<ns>/configmap/<name>` | `kubectl` | `get configmap <name> --namespace <ns> --output json` |
| `k8s://<ns>/secret/<name>` | `kubectl` | `get secret <name> --namespace <ns> --output json` |
| `ssm://<path-prefix>` | `aws` | `ssm get-parameters-by-path --path <p> --recursive` |
| `tfstate://<path>` | none | reads the file |

Flecto inherits exactly what that tool is entitled to and nothing more. That is
what makes **"give it a read-only role"** advice you can enforce in your own
RBAC or IAM, rather than a promise this code makes about itself.

This is also why `kubectl` and `aws` are *your* dependency, not Flecto's — the
package adds none, and the README's "nothing extra has to exist on the CI
runner" stays true of everything except this command, which says so when the
tool is missing.

## Read-only is structural

Every argv is built in `src/drift-sources.js` from a fixed table of allowed
tools and verbs. There is no code path in that file that can construct a
mutating command, so *"it cannot write"* is a property of the table rather than
of reviewer attention.

Nothing from the URI reaches argv as a flag. Each component is validated —
Kubernetes names against RFC 1123, SSM paths against a conservative pattern —
and anything beginning with `-` is refused by name:

```
$ flecto-drift app.yaml --against 'k8s://prod/configmap/--output=pwned'
[error] drift: name "--output=pwned" starts with "-" and would be read as an option

$ flecto-drift app.yaml --against 'k8s://prod/delete/api'
[error] drift: "delete" is not a readable kind; use configmap or secret
```

Set up the credential to match. A read-only Kubernetes role:

```yaml
kind: Role
rules:
  - apiGroups: [""]
    resources: ["configmaps", "secrets"]
    verbs: ["get"]          # get only — no list, watch, patch, or delete
```

## Values from a secret store are never printed

A Kubernetes Secret or an SSM `SecureString` is compared **by shape** — length
and a truncated digest — never by value:

```
config/secrets.yaml — 1 change from k8s secret production/creds:
  ~ db_password: "<11 bytes, sha256:f75778f7425b>" → "<16 bytes, sha256:7f1413226447>"
```

A rotation is still visible, which is the entire point of drift detection, and
the plaintext never enters a change event, a report, or a terminal. SSM is read
**without** `--with-decryption`, so a SecureString's plaintext never leaves AWS
at all.

**There is no flag to turn this off**, because a flag that prints production
secrets is a feature request whose answer is no.

## Terraform state

Only the `outputs` block is read. Terraform state routinely carries provider
credentials in resource attributes, and walking all of it would turn a drift
check into an exfiltration primitive. Outputs marked `sensitive` are shaped like
any other secret.

## In CI

```bash
flecto-drift config/prod.yaml --against k8s://production/configmap/api --fail-on-drift
```

Exits `1` when the declared file and the live state differ, `0` when they match.
`--format json` gives a machine-readable report carrying `drifted`, the change
list, and a `comparison` field that is `"values"` or `"shape-only"` — so a
consumer never has to guess whether a value in the report is real or a digest.

## What is deliberately not here

- **No write path of any kind.** Not "apply the declared file", not "sync". The
  moment this tool can change live state it needs a different security review
  than the one it has.
- **No credential handling.** See above.
- **No secret values.** See above.
- **No cluster-wide or account-wide scan.** One named source per invocation, so
  the blast radius of a mistake is one ConfigMap.
