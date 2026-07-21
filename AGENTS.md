# AGENTS.md

## Cursor Cloud specific instructions

Flecto is a single Node.js ESM CLI (no server, no database, no ports). The entry point is `index.js` (`bin: flecto`); source lives in `src/`. Requires Node >= 18 (the VM has Node 22).

Standard commands are already documented in `README.md` and `package.json` `scripts`:
- Test: `npm test` (Node built-in runner over `test/*.test.js`).
- Run CLI in dev: `node index.js <watch|ci|init|doctor> ...` (no build step).

Non-obvious notes:
- There is no lint script and no build step; "run" means invoking `node index.js` directly.
- `flecto watch <file>` is a long-running process (uses chokidar); run it in a background/tmux session and edit the target file to trigger semantic diffs.
- `watch --diff`/`ci` exit with code `1` when changes are detected (`0` when clean) — this is intended, not a failure.
- `flecto ci --snapshot-ref <gitref>` needs a git repo; tests that rely on git skip gracefully when unavailable.
- Runtime dirs (`.flecto-snapshots/`, `.flecto-tmp/`, `.flecto-queue/`) are created relative to the cwd on use; run demos in a scratch dir to avoid clutter.
