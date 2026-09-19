# Narrating a change with a model (`flecto explain`)

Flecto renders `pool_size: 5 → 20` exactly. Whether that pushes aggregate
connections past your database's limit is a judgment call, and it's what a
reviewer at 2 AM wants to know. `flecto explain` asks a model you configure to
narrate the likely blast radius of a change, working from the semantic diff Flecto
already computed.

```text
$ flecto explain config/prod.yaml --snapshot-ref origin/main
config/prod.yaml — 2 changes from origin/main:
  ~ db.pool_size: 5 → 20
  ~ debug: false → true
  ! policy(warn) [default] db.pool_size: Pool size increased from 5 to 20 (>=2x).
  ! policy(error) [default] debug: Potentially dangerous toggle enabled.
flecto explain: sending the masked semantic diff to anthropic (claude-opus-5) at https://api.anthropic.com/v1/messages — ~640 input tokens (estimated), output capped at 16000 tokens. Advisory only: this never affects the exit code.

Model-generated narration (anthropic claude-opus-5) — advisory, not computed by Flecto, and never part of the exit code

- Each process can now open 4x as many database connections; multiplied across replicas this can exceed the server's max_connections — check the replica count and the limit.
- debug: true in production usually means verbose logging and sometimes detailed error pages; check what this service exposes when it is on.
```

Narration is **off unless you ask for it**, uses **your own key**, and is
**advisory only**: it never changes an exit code, never becomes a policy finding,
and is always labeled as model output. The rules below are what make that true.

> Not to be confused with the MCP server's `flecto_explain` tool
> ([mcp.md](mcp.md)), which deterministically returns the change at one path. That
> tool involves no model.

## Turning it on

Pick a provider and give it a key. Both are runner configuration: environment
variables, or flags on the command line.

```bash
export FLECTO_EXPLAIN_PROVIDER=anthropic
export FLECTO_EXPLAIN_API_KEY=sk-ant-...      # or ANTHROPIC_API_KEY

flecto explain "config/**/*.yaml" --snapshot-ref origin/main
flecto ci "config/**/*.yaml" --snapshot-ref origin/main --explain
```

Two providers are built in. Neither uses a vendor SDK; each is a single HTTPS
request made with Node's `fetch`, so there is no new dependency.

| Provider | Endpoint | Key | Default model |
|---|---|---|---|
| `anthropic` | `POST {url}/v1/messages` (default `https://api.anthropic.com`) | `FLECTO_EXPLAIN_API_KEY`, else `ANTHROPIC_API_KEY` | `claude-opus-5` |
| `openai` | `POST {url}/chat/completions` (default `https://api.openai.com/v1`) | `FLECTO_EXPLAIN_API_KEY`, else `OPENAI_API_KEY`, else none | none; set `--model` / `FLECTO_EXPLAIN_MODEL` |

`openai` speaks the OpenAI-compatible chat-completions shape, so it also works
with a local server such as Ollama, vLLM, or LM Studio: point
`FLECTO_EXPLAIN_API_URL` at it (`http://127.0.0.1:11434/v1`). If the server
takes no key, leave the key unset. With a local model, nothing leaves the
machine.

For `claude-opus-5` against the first-party API, the request opts into
server-side refusal fallbacks (`fallbacks: "default"`), so a declined request is
re-run on Anthropic's recommended fallback model in the same call instead of
coming back empty. A custom `FLECTO_EXPLAIN_API_URL` (a proxy, another platform)
never receives that beta header.

## What is sent

Only the **masked semantic diff** is sent: the changed paths, their before and
after values, and the policy findings, for files that have any. Masking happens
while the payload is built, **whether or not you pass `--mask-secrets`**:

- a value under a secret-looking key (`password`, `token`, `api_key`, …) is sent
  as `***`;
- a credential-shaped value under any key is redacted;
- a finding whose message interpolated a secret has that value masked too;
- an encrypted value is sent as the sentinel the parser already put in its place
  (`<encrypted:sops:…>`). The ciphertext never existed outside the parser, and
  nothing is decrypted.

File contents are never sent, and neither is any path outside the diff. File
names are sent relative to the working directory.

To see exactly what would go over the wire, add `--dry-run`. Nothing is sent,
and no key is needed, so you can review it before provisioning one:

```bash
flecto explain config/prod.yaml --snapshot-ref origin/main --dry-run
flecto ci config/prod.yaml --snapshot-ref origin/main --explain-dry-run   # printed to stderr
```

The printed request shows the URL, the headers (with the key replaced by the
name of the variable it would come from), and the full body.

## What it can never do

- **Change an exit code.** `ci --explain` decides the gate before it asks for
  narration. Everything that can go wrong (no provider configured, over budget,
  network error, timeout, HTTP error, a refusal, an empty answer) is a
  `No narration: …` warning on stderr, and the run continues exactly as it would
  without the flag. `--fail-on` has no narration trigger and won't get one.
- **Become a finding.** Findings gate merges, so they stay deterministic and
  rule-based. Narration explains findings; it never adds one.
- **Pass for Flecto's own output.** Every rendering starts with
  *Model-generated narration … advisory, not computed by Flecto*. In a PR comment
  it sits under its own heading, inside a fenced code block.
- **Change `ci`'s machine output.** With `--format json`, `ndjson`, `sarif`, or
  `github-annotations`, narration goes to stderr, and stdout is byte-for-byte
  what it is without `--explain`. Only `--format pr-comment` includes it in the
  body, because a person reads that body.

## Cost and determinism

Before a request is made, Flecto states the provider, model, endpoint, estimated
input tokens (about four characters per token), and the output cap. Afterwards it
reports the tokens the provider billed.

- **Input budget.** A diff estimated above `FLECTO_EXPLAIN_MAX_INPUT_TOKENS`
  (default 30,000) is not sent, and you get a warning. It's never truncated to fit:
  narrating half a diff would be worse than narrating none.
- **Output cap.** `--max-tokens` / `FLECTO_EXPLAIN_MAX_TOKENS` (default 16,000).
  Current models spend part of this on internal reasoning before they write, so
  a much lower cap can cut the answer off. A cut-off answer is labeled as one.
- **Timeout.** `FLECTO_EXPLAIN_TIMEOUT_MS` (default 120,000).
- **Cache.** An identical request is answered from a local cache, with the same
  prose and no second bill. Current models don't accept sampling parameters, so
  the cache is what makes re-running a pipeline reproducible. The cache lives
  outside the repository (`$XDG_CACHE_HOME/flecto/explain`, else
  `~/.cache/flecto/explain`; `%LOCALAPPDATA%\flecto\explain-cache` on Windows),
  and entries are keyed with an HMAC of your API key. A pull request can't commit
  an entry that Flecto would serve, because nobody without the key can compute its
  name. Set `FLECTO_EXPLAIN_CACHE_DIR` to move it (for example, into a directory
  your CI caches between runs), or pass `--no-cache` to `flecto explain`.

## Who can turn it on

Only the operator, never the repository. Narration sends data to a third party
and bills your key, so it's an action rather than a setting, the same way
`--update-baseline` and `watch --command` are. Any `explain*` option declared in
`.flectorc` or a profile is **refused loudly**. On an untrusted pull request,
`.flectorc` is attacker-controlled, and an rc-declared endpoint would let a pull
request choose where your diff and your API key are sent. The provider, model,
endpoint, and key come only from the command line and the runner environment.
`flecto explain` also reads `--format`, `--model`, and `--snapshot-ref` from the
command line only.

`FLECTO_EXPLAIN=0` is a runner-wide kill switch. It turns every `--explain` into a
warning and a no-op, for runners that must never make an outbound model call.

Redirects are refused, not followed. `fetch` strips only `Authorization` from a
cross-origin redirect, and Anthropic authenticates with `x-api-key`, which would
otherwise be forwarded to wherever the redirect points.

## Reading it critically

The model reads text a pull request author wrote. The prompt tells it the diff is
data, not instructions, and tells it never to call a change safe or approved.
Even so, **narration of attacker-authored content can be steered by that
content**. That risk is why narration is advisory, labeled, and kept out of the
gate, and why in a PR comment it's rendered inside a code fence, where links,
images, `@`-mentions, and HTML show as plain text. Treat it as a second pair of
eyes that is sometimes wrong, never as a verdict.

## In a pull request

```yaml
- name: Flecto
  env:
    FLECTO_EXPLAIN_PROVIDER: anthropic
    FLECTO_EXPLAIN_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: >
    npx flecto ci "config/**/*.yaml"
    --snapshot-ref origin/${{ github.base_ref }}
    --format pr-comment --pr-comment-post --explain
```

The sticky comment gains a *Model-generated narration (advisory)* section between
the policy findings and the change table. Repository secrets are not exposed to
workflows triggered from forks, so on a fork's pull request no key is present and
narration is skipped with a warning. The gate still runs.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `FLECTO_EXPLAIN_PROVIDER` | — | `anthropic` or `openai`. Required unless `--provider` is passed |
| `FLECTO_EXPLAIN_MODEL` | provider default | Model id |
| `FLECTO_EXPLAIN_API_KEY` | — | API key. Falls back to `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` |
| `FLECTO_EXPLAIN_API_URL` | provider default | Base URL (`http` allowed, for a local server) |
| `FLECTO_EXPLAIN_MAX_TOKENS` | `16000` | Output token cap |
| `FLECTO_EXPLAIN_MAX_INPUT_TOKENS` | `30000` | Estimated input size above which nothing is sent |
| `FLECTO_EXPLAIN_TIMEOUT_MS` | `120000` | Request timeout |
| `FLECTO_EXPLAIN_CACHE_DIR` | user cache dir | Where narrations are cached |
| `FLECTO_EXPLAIN` | — | `0` / `false` / `off` disables narration on this runner |
