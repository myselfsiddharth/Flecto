# Policy-pack example

This example compares `config.yaml` to `baseline.json` and loads the local `deployment-safety` policy pack.

From this directory, run:

```bash
node ../../index.js ci config.yaml --snapshot-ref baseline.json --policies deployment-safety --fail-on policy
```

It reports an error for enabling a public service and a warning for tripling the replica count. The command exits with status `1` because `--fail-on policy` treats any finding as a CI failure.
