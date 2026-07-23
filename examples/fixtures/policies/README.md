# Shared policy fixtures

These files provide a stable before/after pair for policy-pack and plugin tests:

- `auth.api_key`: secret change
- `features.debug`: dangerous toggle enabled
- `database.pool_size`: numeric jump from 5 to 20
- `deployment.rollout.maxUnavailable`: nested-object drift from 1 to 3

Run the complete fixture scenario from this directory:

```bash
node ../../../index.js policies test .
```

The command exits `0` after matching the five expected findings in `flecto-policy-test.json`: the built-in `default` pack reports `secret-key-changed`, `dangerous-toggle-enabled`, and `pool-size-jump`; `deployment-review` reports `rollout-unavailability-increased`; and the async plugin reports `async-rollout-approval`.

`baseline.json` uses the snapshot envelope shape expected by the harness; `current.json` is the config under evaluation. `flecto-policy-test.json` configures the active packs, plugin, profile, and expected `{ id, severity, path }` triples.
