# Getting started

A complete walkthrough, start to finish. Copy-paste it anywhere.

Requires **Node.js 20.19.0+**.

```bash
npm install -g flecto
```

Or run it without installing: every command below works with
`npx --yes flecto@4` in place of `flecto`.

---

**1. Create a config file to track.**

```bash
mkdir flecto-demo && cd flecto-demo && mkdir config
cat > config/prod.yaml <<'EOF'
database:
  host: db.internal
  pool_size: 5
  ssl: true
logging:
  level: info
  debug: false
EOF
```

**2. Save it as your baseline.**

```bash
flecto watch config/prod.yaml --snapshot
```

```
✓ Snapshot saved: /path/to/flecto-demo/.flecto-snapshots/4b8cbbd70d1832a2.json
```

**3. Make the kind of edit that causes incidents.**

```bash
cat > config/prod.yaml <<'EOF'
database:
  host: db.internal
  pool_size: 20
  ssl: true
logging:
  level: info
  debug: true
EOF
```

**4. Ask what changed.**

```bash
flecto watch config/prod.yaml --diff
```

```
/path/to/flecto-demo/config/prod.yaml — 2 changes from snapshot:
  ~ database.pool_size: 5 → 20
  ~ logging.debug: false → true
```

Two sentences instead of a diff you have to interpret. Now let Flecto judge it:

```bash
flecto ci config/prod.yaml --format github-annotations
```

```
::warning title=flecto changed::database.pool_size
::warning title=flecto changed::logging.debug
::warning title=flecto policy pool-size-jump [default]::database.pool_size: Pool size increased from 5 to 20 (>=2x).
::error title=flecto policy dangerous-toggle-enabled [default]::logging.debug: Potentially dangerous toggle enabled.
```

Exit code `1`. In CI, that's a failed build — before the change ships.

**5. Watch it live.** Leave this running and edit the file in another window:

```bash
flecto watch config/prod.yaml
```

```
flecto watching /path/to/flecto-demo/config/prod.yaml
Press Ctrl+C to stop.

[18:24:48] /path/to/flecto-demo/config/prod.yaml — 2 changes
  ~ database.pool_size: 5 → 20
  ~ logging.debug: false → true
  ! policy(warn) [default] database.pool_size: Pool size increased from 5 to 20 (>=2x).
  ! policy(error) [default] logging.debug: Potentially dangerous toggle enabled.
```



---

## Where to go next

That is the whole product in one file. The rest is depth:

- **[CI](ci.md)** — baselines, fail triggers, output formats, the bundled Actions
- **[Terraform plans](terraform.md)** — reviewing `terraform show -json` output
- **[Kubernetes](kubernetes.md)** — diffing rendered Helm and Kustomize manifests
- **[Configuration](configuration.md)** — `.flectorc`, profiles, ignore rules
- **[Policy packs](policy-packs.md)** — writing your own rules
- **[CLI reference](cli-reference.md)** — every command, flag, and exit code
