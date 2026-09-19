# Findings in your editor (`flecto lsp`)

The cheapest moment to catch `debug: true` in `prod.yaml` is when it's typed.
`flecto lsp` is a [Language Server Protocol](https://microsoft.github.io/language-server-protocol/)
server that runs the same checks as `flecto ci` on the file you're editing and
shows the results as diagnostics, underlined on the line they're about:

```text
prod.yaml
  2:3  warning  Pool size increased from 5 to 20 (>=2x).          flecto(pool-size-jump)
  4:1  error    Potentially dangerous toggle enabled.             flecto(dangerous-toggle-enabled)
  2:3  hint     db.pool_size changed from 5 (HEAD) to 20          flecto(changed)
```

Policy findings keep their severity (`error`, `warning`, `information`). Semantic
changes against the baseline show as hints, which most editors render as a faint
underline or dots.

## Setup

The server speaks LSP over stdin/stdout. Point your editor at `flecto lsp`. It
accepts the `--stdio` flag editors often pass.

**Neovim 0.11+**

```lua
vim.lsp.config('flecto', {
  cmd = { 'flecto', 'lsp', '--stdio' },
  filetypes = { 'yaml', 'json', 'jsonc', 'toml', 'dosini', 'sh' },
  root_markers = { '.flectorc', '.flectorc.json', '.flectorc.yaml', '.flectorc.yml', '.git' },
})
vim.lsp.enable('flecto')
```

**Helix** (`languages.toml`). Listing `language-servers` replaces the defaults,
so keep the ones you already use:

```toml
[language-server.flecto]
command = "flecto"
args = ["lsp", "--stdio"]

[[language]]
name = "yaml"
language-servers = ["yaml-language-server", "flecto"]
```

**Emacs (eglot).** eglot runs one server per major mode, so this replaces any
YAML server you have:

```elisp
(add-to-list 'eglot-server-programs
             '((yaml-mode yaml-ts-mode) . ("flecto" "lsp" "--stdio")))
```

**VS Code** needs a client extension to start a language server. There's no
Flecto extension yet.

The workspace folder the editor opens is the project root. `.flectorc`,
`policies/`, and the git repository are read from there.

## It agrees with the merge gate

Two sources of truth would be worse than none, so the editor answers with the
same inputs `flecto ci` uses:

- **The same `.flectorc`**: packs, `severityRemap`, `ignore`, array identity, and
  `--profile` / `FLECTO_PROFILE`.
- **The same scope.** With `files`/`include` in `.flectorc`, only a file they
  match (minus `exclude`) gets diagnostics. A file CI never checks isn't flagged.
- **The same inline suppressions.** A `# flecto-ignore-next-line <rule> — <reason>`
  hides its finding here exactly as it does in CI. A directive missing its reason
  is shown as an **error** on its line, because that's what fails the CI run.
- **The same `--baseline` file**, when `.flectorc` names one: a finding it already
  accepts doesn't gate, so it doesn't show.
- **The same masking.** With `maskSecrets` in `.flectorc`, values interpolated into
  finding messages are masked. Change hints always mask secret-looking values: a
  hover that shows the password a line had at HEAD is a leak nobody asked for.

The baseline differs by design: the editor compares the text you're typing with
`HEAD` (`--snapshot-ref <ref>` to change it, `--snapshot-store local|shared` to
use saved snapshots), while CI compares a pull request with its base.

Where the editor *can't* agree, it says so on the file instead of differing
quietly:

- **Plugins declared in `.flectorc` are never loaded**, even with
  `FLECTO_ALLOW_RC_PLUGINS=1`. Opening a repository in an editor is the same threat
  model as CI running an untrusted pull request, but that variable in a shell
  profile would apply to every repository you ever open. You get a warning that
  plugin findings are missing. To load plugins you trust, pass them yourself with
  `--plugins`. These must be **absolute** paths: a relative one would resolve
  inside whatever repository is open, including one that ships a file at exactly
  that path.
- **A file HEAD doesn't have** still gets its policy findings. Every key counts as
  added, and a note says `flecto ci --snapshot-ref` fails closed on such a file.

## Where a diagnostic lands

Flecto's differ reports paths (`db.pool_size`, `containers["web"].image`), not
line numbers, so the server maps each path back into the text you're editing. A
diagnostic on the wrong line is worse than none, so a position is used only where
an independent scan of the text **agrees with the tree the parser produced**. Each
mapping must have exactly the parsed keys, and each list exactly the parsed length.
YAML positions come from js-yaml's own event stream, dotenv's from dotenv's own
line pattern, and JSON, INI, and TOML from small scanners that verification keeps
honest.

When a path can't be pinned down exactly, the diagnostic anchors to the nearest
enclosing key that can, and its message names the full path:

| Case | Anchored at |
|---|---|
| A removed key | Its parent key (the key isn't in the text any more) |
| A key a YAML merge (`<<: *base`) brought in | The `<<` line |
| Inside an alias (`x: *base`) | `x` (the value lives at the anchor, a different path) |
| An element of an order-insensitive list (`[*]`) | The list's key |
| A path that reads two ways (`a.b` as one key, or `a` then `b`) | The file |
| An array identity (`["web"]`) where `id` and `name` point at different elements | The list's key |
| SOPS metadata, which the encryption pass re-keys | The nearest key that still matches |
| Synthetic paths such as `<encryption>` | The file |

## Staying responsive

A keystroke-rate re-diff of a large manifest must never wedge the editor:

- **Debounced.** An analysis starts `--debounce` ms (default 250) after the last
  edit, on the version current at that moment.
- **Cancellable.** Each analysis runs in a worker thread. If a newer version of the
  same file arrives while one is running, the worker is terminated rather than
  waited for. A result is published only for the version still open.
- **Bounded.** An analysis that runs past `--timeout` ms (default 10000) is stopped
  and reported as one warning. A policy-pack regex that backtracks forever on a
  long value would hang `flecto ci` (a documented limitation); here it costs a
  warning, and the next edit is analyzed normally. Files over 5 MB are skipped.

## Flags

| Flag | Default | Description |
|---|---|---|
| `--stdio` | — | Accepted and ignored; stdio is the only transport |
| `-p, --profile <name>` | `FLECTO_PROFILE` | Profile from `.flectorc` |
| `--snapshot-ref <ref>` | `HEAD` | Git ref open files are compared with |
| `--snapshot-store <id>` | — | Compare with a snapshot store (`local` or `shared`) instead of git |
| `--snapshot-dir <path>` | store default | Directory holding the snapshot store |
| `--plugins <paths>` | none | Comma-separated **absolute** plugin paths to load |
| `--changes <level>` | `hint` | How semantic changes appear: `hint`, `info`, or `none` |
| `--debounce <ms>` | `250` | Quiet period after an edit before analyzing |
| `--timeout <ms>` | `10000` | Stop an analysis that runs longer than this |

## Not yet

Quick fixes and code actions are out of scope until the diagnostics themselves
are right. The position mapping (`src/positions.js`) is what line-anchored pull
request comments and SARIF regions would need, and it's written to be reused for
both.
