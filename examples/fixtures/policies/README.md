# Shared policy fixtures

These files provide a stable before/after pair for policy-pack and plugin tests:

- `auth.api_key`: secret change
- `features.debug`: dangerous toggle enabled
- `database.pool_size`: numeric jump from 5 to 20
- `deployment.rollout.maxUnavailable`: nested-object drift from 1 to 3

Run the complete fixture scenario from this directory:

```bash
node ../../../index.js ci current.json --snapshot-ref baseline.json --profile prod --policies default,deployment-review --plugins ./plugins/async-rollout-guard.js --fail-on policy
```

The command intentionally exits with status `1`. It produces five findings: the built-in `default` pack reports `secret-key-changed`, `dangerous-toggle-enabled`, and `pool-size-jump`; `deployment-review` reports `rollout-unavailability-increased`; and the async plugin reports `async-rollout-approval`.

`baseline.json` uses the snapshot envelope shape expected by `--snapshot-ref`; `current.json` is the config under evaluation. Tests can import these files directly, copy them to a temporary directory, or run the documented command.
