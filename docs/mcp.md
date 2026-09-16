# Flecto as an MCP server

`flecto mcp` runs Flecto as a read-only [Model Context Protocol](https://modelcontextprotocol.io)
server over stdio, so an agent can ask for a semantic diff and get **the small
answer** — `pool_size: 5 → 20` — instead of reading a two-thousand-line manifest
into its context to find it.

It exposes three read-only tools:

| Tool | Answers |
|---|---|
| `flecto_diff(file, ref?, mask?)` | The semantic changes to one config file against a baseline (a git ref, default `HEAD`, or a snapshot path). |
| `flecto_check(files, packs?, mask?)` | The policy findings for one or more files (or globs), evaluated over their changes against `HEAD`. |
| `flecto_explain(file, path, ref?, mask?)` | What changed at one configuration path — its before/after value and any policy findings that touch it. |

Each returns Flecto's versioned JSON envelope as the tool result.

## Setup

`flecto mcp` speaks JSON-RPC on stdin/stdout and writes nothing else to stdout,
so any MCP client that launches a stdio server can use it. The server runs read
tools against the working directory it is started in, so point the client's
`cwd` (or launch directory) at the repository you want it to read.

### Claude Code

Add it with the CLI:

```bash
claude mcp add flecto -- flecto mcp
```

or, in `.mcp.json` at the repository root:

```json
{
  "mcpServers": {
    "flecto": { "command": "flecto", "args": ["mcp"] }
  }
}
```

Then ask, e.g., *"use flecto_diff on config/prod.yaml to show what changed since
HEAD."*

### Cursor

In `.cursor/mcp.json` (or the global `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "flecto": { "command": "flecto", "args": ["mcp"] }
  }
}
```

Any other stdio MCP client takes the same `command`/`args` pair.

## Security posture

The tools run the **same read-only `flecto ci` path** a pull request triggers,
as a subprocess, and return its envelope. That is the whole design, and it is
what makes the guarantees below true by construction rather than by careful
coding:

- **Read-only.** A tool can only reach what `ci` reaches. It never passes
  `--command`, `--plugins`, `--baseline`, `--update-baseline`, `--output`, or
  `--pr-comment-post`, so no agent-supplied value can become a write, a webhook,
  or a shell command. A tool an agent can invoke must not be able to execute a
  shell command — that is [GHSA-wq8m-fc3q-8m5x]'s lesson generalized.
- **Secrets masked by default — inverted from the CLI.** On the command line
  `--mask-secrets` is opt-in, because the consumer is a human terminal. In MCP
  the consumer is a model context that is transmitted to a provider and very
  often logged on the way, so masking is **on** unless a call explicitly passes
  `mask: false`. That opt-out is a disclosure: the raw value then travels to the
  model.
- **Plugins stay off**, regardless of `FLECTO_ALLOW_RC_PLUGINS` in the
  environment — the flag is stripped from the subprocess, because model-supplied
  arguments are untrusted input and an rc-declared plugin is code. A repository
  whose `.flectorc` declares plugins will have the tool report the refusal rather
  than run them.
- **Path containment.** A traversal (`..`) or an absolute path outside the
  working directory is refused before anything is spawned, and the CLI then
  applies its own symlink-escape check on every resolved target.
- **Bounded results.** A diff of thousands of changes is truncated to a stated
  count rather than flooding the context window — returning a small answer is the
  entire point.

## Notes

- **A baseline is required**, as for `ci`: `flecto_diff` defaults to diffing
  against `HEAD`, so a file that does not yet exist in `HEAD` (a brand-new file)
  has nothing to diff and the tool says so. Pass `ref` to choose another git ref
  or a snapshot path.
- **Not on every dependency.** The server ships in the core package and adds no
  runtime dependency — it speaks the stdio JSON-RPC framing directly.

[GHSA-wq8m-fc3q-8m5x]: https://github.com/myselfsiddharth/Flecto/security/advisories/GHSA-wq8m-fc3q-8m5x
