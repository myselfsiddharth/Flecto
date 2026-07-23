# Plugin authoring

Plugins implement policy logic that a declarative pack cannot express. A plugin is a local ESM module that exports an `evaluate(changes, ctx)` function.

Run the complete example:

```bash
cd examples/plugin
node ../../index.js ci config.yaml --snapshot-ref baseline.json --plugins ./replica-limit.js --fail-on policy
```

The command intentionally exits with status `1`: the plugin reports a finding for the replica increase.

## Plugin module

`evaluate` may be synchronous or async. It receives semantic change events and a context object, and must return an array of findings.

```js
export function evaluate(changes, ctx) {
  return changes
    .filter((change) => change.type === 'changed' && change.path === 'service.replicas')
    .filter((change) => typeof change.after === 'number' && change.after > 5)
    .map((change) => ({
      id: 'replica-limit',
      severity: 'warn',
      path: change.path,
      message: `Replica count is ${change.after}; expected at most 5.`,
    }));
}
```

Register local plugins with a comma-separated list:

```bash
flecto ci config/prod.yaml --plugins ./plugins/replica-limit.js,./plugins/other.js
```

The same `plugins` array can be set in `.flectorc` defaults or profiles.

## Inputs

Each item in `changes` has this shape:

```js
{
  type: 'added' | 'removed' | 'changed',
  path: 'database.pool_size',
  before: 5,
  after: 20
}
```

`before` or `after` can be absent for added or removed keys. Their values retain the types produced by the config parser, so check types before applying numeric or boolean logic.

`ctx` contains:

```js
{
  cwd,       // Flecto's current working directory
  file,      // absolute path to the file being evaluated
  profile,   // selected profile name, or null
  source,    // 'watch' | 'ci'
  packIds    // active policy-pack ids
}
```

## Return findings

Each returned item should have `id`, `severity`, `path`, and `message`:

```js
{
  id: 'replica-limit',
  severity: 'warn', // 'info', 'warn', or 'error'
  path: 'service.replicas',
  message: 'Replica count is 8; expected at most 5.',
  pack: 'my-plugin' // optional
}
```

If `pack` is omitted, Flecto labels it `plugin:<configured path>`. Findings with the same `id` and `path` are deduplicated, keeping the highest severity.

Plugin paths are resolved relative to Flecto's current working directory (unless absolute). Remote `http:` and `https:` plugin URLs are rejected. Let errors surface rather than swallowing them: a thrown plugin error fails the Flecto command.
