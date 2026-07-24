# Plugin example

This plugin flags a replica count above five.

From this directory, run:

```bash
node ../../index.js ci config.yaml --snapshot-ref baseline.json --plugins ./replica-limit.js --fail-on policy
```

It reports a warning from `replica-limit.js` and exits with status `1` because `--fail-on policy` treats any finding as a CI failure.
