# Terraform plans

`flecto plan` reads the JSON Terraform produces for a saved plan and turns each
resource-level change into the same change events, policy findings, envelope,
and exit code every other Flecto command uses.

**Flecto never runs the `terraform` binary.** It is not a dependency, it is not
expected on `PATH`, and Flecto will not shell out to it. You run Terraform; you
hand Flecto the JSON.

```bash
terraform plan -out plan.tfplan
terraform show -json plan.tfplan > plan.json

flecto plan plan.json
```

That separation is deliberate. The plan is produced by whatever Terraform
version, backend, credentials, and workspace your pipeline already has. Flecto
only reads the artifact, so it needs no cloud credentials, no provider plugins,
and no state access.

---

## What it looks like

```
plan.json — plan format 1.2, terraform 1.9.5
Plan: 1 to add, 1 to change, 1 to destroy, 1 to replace.
plan.json — 9 changes from the current state:
  - aws_db_instance.main.#action: "replace" [terraform will destroy and recreate aws_db_instance.main (forced by: engine_version)]
  ~ aws_db_instance.main.engine_version: "13.4" → "14.1"
  ~ aws_security_group.web.ingress[0].cidr_blocks[0]: "10.0.0.0/8" → "0.0.0.0/0"
  + aws_s3_bucket_acl.site.acl: "public-read"
  ! policy(error) [terraform] aws_db_instance.main.#action: Terraform will destroy a stateful resource. …
  ! policy(error) [terraform] aws_security_group.web.ingress[0].cidr_blocks[0]: Security group ingress will accept traffic from the whole internet (0.0.0.0/0). …
```

Paths are keyed by the resource **address**, so they read the way you would say
them out loud: `aws_security_group.web.ingress[0].cidr_blocks[0]`. Module
addresses keep their prefix (`module.storage.aws_ebs_volume.data.size`), and
`count` / `for_each` keys stay where Terraform put them
(`aws_instance.worker[0].instance_type`).

---

## How Terraform actions map onto change events

Every resource change also produces one event on a synthetic `#action`
attribute. `#` cannot appear in a Terraform attribute name, so it never collides
with a real one, and it gives resource-level rules a single event to match
instead of one per attribute.

| Terraform action | Event | `#action` value | Attribute events |
|---|---|---|---|
| `create` | `added` | `"create"` | every configured attribute, as `added` |
| `update` | `changed` | `"no-op"` → `"update"` | the before/after diff |
| `delete` | `removed` | `"delete"` | every attribute, as `removed` |
| `["delete","create"]` / `["create","delete"]` | **`removed`** | `"replace"` | the before/after diff |
| `no-op` | — | — | none |
| `read` (data sources) | — | — | none |

An action Flecto does not recognize is passed through verbatim as a `changed`
event (`"no-op"` → `"create,forget"`) rather than being dropped.

### Why `replace` is a removal

A replace destroys the resource. The recreated one is a new object with a new
id, and anything that lived only on the old instance is gone. Representing that
as a `changed` event would put the single most dangerous plan action in the same
bucket as bumping a timeout — easy to skim past in a review, and invisible to a
`--fail-on removed` gate.

So a replace is a `removed` event carrying the value `"replace"`, which means:

- `--fail-on removed` catches every replace, with no policy pack loaded at all.
- `terraform-resource-replaced` fires on it at `error`.
- `terraform-stateful-resource-destroyed` treats a replaced database exactly
  like a deleted one, because for your data it is the same thing.

The attribute-level diff is still emitted alongside it, so you can see *what*
forced the replacement. When Terraform reports `replace_paths`, the attribute is
named in the event's note: `(forced by: engine_version)`.

---

## Values Terraform cannot know yet (`after_unknown`)

Terraform marks attributes it cannot resolve until apply. Flecto substitutes
Terraform's own wording, `(known after apply)`, and tags the event with a
`known after apply` note. Such a value is **never** rendered as `null`.

Two rules keep this useful rather than noisy:

- **A known value becoming unknown is kept.** `dns_name: "app-1234.…" →
  (known after apply)` is a real change, and one worth seeing.
- **A pure addition that is only ever unknown is dropped.** On a create, every
  computed attribute (`id`, `arn`, `private_ip`) is unknown by definition.
  Listing them says nothing, so they are not emitted. The resource still always
  produces its `#action` event, so nothing goes silent.

---

## Values Terraform marks sensitive

Plan JSON carries `before_sensitive` / `after_sensitive` alongside the values
themselves — Terraform's human renderer uses them to decide what to hide, but
the values are right there in the JSON.

`flecto plan` replaces every value at a sensitive position with
`(sensitive value)` **during parsing**, before the policy engine, the envelope,
or any formatter can see it. Within `flecto plan` this is unconditional: it does
not depend on `--mask-secrets`, and there is no flag to turn it off.

> **The redaction lives in `flecto plan` only — and every other command now
> refuses plan JSON rather than reading it.** A plan file is ordinary JSON, so
> `flecto ci "**/*.json"`, a committed `tfplan.json` swept up by a `.flectorc`
> `files` pattern, `watch`, `compare`, `report`, and snapshot writes would
> otherwise read it as a plain config tree and print the sensitive values.
> `--mask-secrets` is not a backstop: it only fires when the attribute *name*
> looks sensitive, and `password` does while `user_data` does not.
>
> Those commands now fail with a pointer to `flecto plan`, mirroring how
> `flecto plan` already refuses a file that is not a plan:
>
> ```
> $ flecto ci tfplan.json
> [error] "tfplan.json" is Terraform plan JSON, which this command cannot read safely.
> …
> Use: flecto plan tfplan.json
> ```
>
> This is a hard failure rather than a skip, because a plan file caught by a
> repo-wide glob is a real misconfiguration, and silently omitting the file would
> leave you believing it had been gated. If a glob picks up plan files you do not
> want reviewed, exclude them — `"exclude": ["**/*.tfplan.json"]`.

A few consequences worth knowing:

- **Marking propagates down.** `"after_sensitive": { "environment": true }`
  marks every key under `environment`, so `environment.LOG_LEVEL` is redacted
  along with `environment.DB_DSN`. Terraform behaves the same way.
- **A changed secret still reports as changed.** The diff runs on the raw values
  and redaction happens immediately afterwards, so two different passwords do
  not collapse into "no change" just because both render as `(sensitive value)`.
- **Every one is flagged.** `terraform-sensitive-value-changed` fires at `warn`
  on any sensitive value set, changed, or removed.

`--mask-secrets` is still worth passing: it applies Flecto's own value-shaped
detection (see [Policy packs](policy-packs.md#secret-shaped-values)) to
everything Terraform did *not* mark — an access key pasted into a `user_data`
script, a token in an SSM parameter. The `terraform-hardcoded-credential` rule
raises those as errors whether or not masking is on.

---

## The `terraform` policy pack

`flecto plan` loads `--policies terraform` by default. An explicit `--policies`
flag or a `.flectorc` entry replaces that entirely.

| Rule | Severity | Catches |
|---|---|---|
| `terraform-resource-replaced` | error | Any destroy-and-recreate, in either ordering |
| `terraform-stateful-resource-destroyed` | error | A database, bucket, volume, or cache being deleted **or replaced** |
| `terraform-security-group-open-ingress` | error | Security group **ingress** opened to `0.0.0.0/0` or `::/0` |
| `terraform-iam-wildcard` | error | An IAM policy document granting `"Action": "*"` or `"Resource": "*"` |
| `terraform-s3-public-access-block-disabled` | error | A `block_public_*` flag set to `false`, or the whole public-access-block destroyed |
| `terraform-s3-public-acl` | error | A bucket ACL set to `public-read`, `public-read-write`, or `authenticated-read` |
| `terraform-instance-size-changed` | warn | `instance_type` / `instance_class` / `machine_type` / `node_type` changing |
| `terraform-capacity-jump` | warn | `desired_capacity`, `max_size`, `desired_count`, `node_count`, … at least doubling |
| `terraform-sensitive-value-changed` | warn | Any Terraform-sensitive value set, changed, or removed |
| `terraform-hardcoded-credential` | error | A credential-shaped value Terraform did *not* mark sensitive |

Deliberate non-firings, so the pack stays worth listening to:

- **Egress to `0.0.0.0/0` does not fire.** Outbound-to-anywhere is the ordinary
  case. Only `ingress` blocks and `aws_vpc_security_group_ingress_rule` count.
- **Scoped IAM does not fire.** `"Action": ["s3:GetObject"]` and a resource ARN
  ending in `/*` are not wildcards; only a bare `"*"` is.
- **`acl = "private"` does not fire**, and neither do the public-access-block
  flags that stay `true`.
- **Sub-2× capacity changes do not fire.** `desired_count: 4 → 5` is routine.
- **Deleting a stateless resource does not fire** the stateful rule. An SQS
  queue is not a database.

Every rule is declarative, using the predicates documented in
[Policy packs](policy-packs.md) — no Terraform-specific matcher was added to the
engine. Override severities per profile with `severityRemap`, or drop
`policies/terraform.json` in your repo to replace the pack outright.

---

## In CI

```yaml
- name: Terraform plan
  run: |
    terraform plan -out plan.tfplan
    terraform show -json plan.tfplan > plan.json

- name: Flecto plan review
  run: npx --yes flecto@3 plan plan.json --format pr-comment --pr-comment-post
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`--format` accepts `human` (the default), `json`, `ndjson`,
`github-annotations`, and `pr-comment` — the same formatters, the same
`schema_version: "2.0"` envelope, and the same sticky-comment behaviour as
`flecto ci`. See [CI](ci.md#output-formats).

`--fail-on` defaults to **`error`**, not to `changed`: a plan is *supposed* to
contain changes, so gating on their existence would fail every pipeline. The
pack reserves `error` for what should block a merge and leaves cost and sizing
advice at `warn`. Widen the gate with `--fail-on policy` (any finding),
`--fail-on warn`, or `--fail-on removed` (any destruction, including replaces).

Several plans in one run each produce their own result entry:

```bash
flecto plan infra/prod.json infra/staging.json --format json
```

---

## Cutting noise

`--ignore` works on plan paths exactly as it does on config paths, including
`**.key` and subtree prefixes:

```bash
# Drop provider-computed tag churn and the action markers.
flecto plan plan.json --ignore '**.tags_all,**.#action'

# Ignore one resource entirely.
flecto plan plan.json --ignore 'aws_cloudwatch_log_group.debug'
```

Two smaller behaviours cut noise before you have to:

- **`null` is absence, not a value.** An optional attribute left unset is not a
  change. Unsetting a previously-set attribute therefore reads as a removal, and
  setting one reads as an addition.
- **`no-op` and `read` entries produce nothing.** A plan full of unchanged
  resources and data-source reads is correctly reported as no changes.

Array identity options (`--array-id-key`, `--no-array-id`,
`--array-ignore-order`) do not apply here and are not offered. A plan is already
flattened onto Terraform's own indexed addressing, so there is no ordering
ambiguity left to resolve.

---

## Limitations

- **Only `resource_changes[]` is read.** `output_changes`, `resource_drift`,
  `prior_state`, and `configuration` are ignored. Drift reporting and output
  diffing are not covered yet.
- **`aws_security_group_rule` is not matched** by the ingress rule. That
  resource stores its direction in a sibling `type` attribute, and a change
  event carries one path and one value — there is nothing to correlate against.
  Prefer `aws_vpc_security_group_ingress_rule`, which is matched.
- **IAM trust policies are not inspected** for wildcard principals; the rule
  reads `Action` / `Resource` keys in `*.policy` documents.
- **Non-AWS providers are covered only where named.** The stateful-destroy and
  instance-size rules list a few Google and Azure types; everything else needs a
  local pack.
- **Plan format 1.x is what this was written against** (Terraform 1.x). A newer
  `format_version` major warns on stderr and still runs.
