import { spawnSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { isAbsolute, resolve, sep } from 'path';

/**
 * `flecto mcp` — a read-only Model Context Protocol server over stdio (#140).
 *
 * The argument for it is the one the CLI cannot make on its own: an agent asked
 * to debug a config incident reads the whole file into context to learn that
 * `pool_size` doubled. Flecto already computes that small answer; this hands it
 * to the agent as a structured tool result instead of a screen-scrape.
 *
 * ## Why it is built as a translator over the CLI
 *
 * Every tool here runs the *same* read-only `flecto ci --format json` path a
 * pull request triggers, as a subprocess, and returns its JSON envelope. That is
 * deliberate, and it is the whole security posture:
 *
 * - **Read-only by construction.** A tool can only reach what `ci` reaches. It
 *   never passes `--command`, `--pr-comment-post`, `--baseline`,
 *   `--update-baseline`, `--output`, or `--plugins`, so there is no argument by
 *   which an agent-supplied value becomes a write or a shell command. That is
 *   GHSA-wq8m-fc3q-8m5x's lesson generalized: a tool an agent can invoke must
 *   not be able to execute a shell command. Nor can a value smuggle one of those
 *   options in: files follow a `--`, values ride as `--name=value`, and a file
 *   argument starting with `-` is refused before anything spawns.
 * - **Plugins stay off**, regardless of `FLECTO_ALLOW_RC_PLUGINS` in the
 *   environment — the runner strips it from the child, because model-supplied
 *   arguments are untrusted input by definition and an rc-declared plugin is
 *   code.
 * - **Path containment** is enforced twice: `assertSafeTargetArg` refuses a
 *   traversal in a tool argument before anything spawns, and the CLI then
 *   applies its own symlink-escape check on every resolved target
 *   (`FLECTO_ALLOW_SYMLINK_TARGETS` is stripped from the child, so it cannot be
 *   switched off).
 * - **Masking is inverted from the CLI**: on by default here, because the
 *   consumer is a model context that is transmitted to a provider and very often
 *   logged on the way. The opt-out is explicit (`mask: false`) and documented as
 *   a disclosure.
 *
 * The seam is the JSON envelope (`schema_version`), which is already Flecto's
 * versioned machine-facing contract. When this moves to its own `flecto-mcp`
 * package, only {@link makeCliRunner} changes — it locates the `flecto` binary
 * from `node_modules` instead of being handed this repo's `index.js`. The
 * protocol layer, the tool schemas, the validation, and the bounding all move
 * verbatim. Nothing here imports Flecto's internals, so there is no private API
 * to freeze first.
 */

/** The MCP revision advertised when the client names none. */
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

/** A result never returns more than this many changes or findings per file. */
export const MAX_ITEMS = 500;

/**
 * The three read-only tools, exactly the sketch in #140. `inputSchema` is JSON
 * Schema, which is what an MCP client renders and validates against.
 */
export const TOOLS = [
  {
    name: 'flecto_diff',
    description:
      'Semantic changes to one config file against a baseline (a git ref, default HEAD, '
      + 'or a path-shaped snapshot file). Returns the meaningful diff — the small answer — not the file. '
      + 'Secret-like values are masked by default.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to the config file, relative to the working directory.' },
        ref: {
          type: 'string',
          description: 'Baseline to diff against: a git revision (default "HEAD"), or a snapshot file named as a path (absolute, ./ or ../).',
        },
        mask: {
          type: 'boolean',
          description: 'Mask secret-like values (default true). Set false only when the caller accepts disclosing them.',
        },
      },
      required: ['file'],
      additionalProperties: false,
    },
  },
  {
    name: 'flecto_check',
    description:
      'Policy findings for one or more config files (or globs), evaluated over their changes '
      + 'against HEAD. Optionally restrict to named policy packs. Secret-like values are masked by default.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Config file paths or globs, relative to the working directory.',
        },
        packs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Policy pack ids to evaluate (default: the packs configured in .flectorc).',
        },
        mask: { type: 'boolean', description: 'Mask secret-like values (default true).' },
      },
      required: ['files'],
      additionalProperties: false,
    },
  },
  {
    name: 'flecto_explain',
    description:
      'What changed at one configuration path in a file (e.g. "database.pool_size"), against a '
      + 'baseline (default HEAD): the before/after value and any policy findings that touch it. '
      + 'Secret-like values are masked by default.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to the config file, relative to the working directory.' },
        path: { type: 'string', description: 'The configuration path to explain, in dot/index notation.' },
        ref: { type: 'string', description: 'Baseline to diff against: a git revision (default "HEAD"), or a snapshot file named as a path (absolute, ./ or ../).' },
        mask: { type: 'boolean', description: 'Mask secret-like values (default true).' },
      },
      required: ['file', 'path'],
      additionalProperties: false,
    },
  },
];

/**
 * Refuse a target argument that escapes the working directory before it is ever
 * spawned. Globs are allowed (the CLI resolves and contains each match); a `..`
 * segment or an absolute path outside `cwd` is not.
 *
 * Nor is a leading `-`. A file argument lands on the `ci` command line, and one
 * spelled `--plugins=./p.mjs` or `--update-baseline` would be parsed as that
 * option — code execution and a write from a single tool call. `ciArgs` already
 * ends options with `--` before any file; this refuses the shape outright too, so
 * the guarantee does not rest on one line of argv ordering.
 * @param {unknown} arg
 * @param {string} cwd
 * @returns {string} the argument, when it is safe
 */
export function assertSafeTargetArg(arg, cwd) {
  if (typeof arg !== 'string' || arg === '') {
    throw new Error('a file argument must be a non-empty string');
  }
  if (arg.includes('\0')) throw new Error('a file argument must not contain a NUL byte');
  if (arg.startsWith('-')) {
    throw new Error(`"${arg}" starts with "-" and would be read as a CLI option; it is refused`);
  }
  const segments = arg.split(/[\\/]/);
  if (segments.includes('..')) {
    throw new Error(`"${arg}" escapes the working directory ("..") and is refused`);
  }
  if (isAbsolute(arg)) {
    const resolved = resolve(arg);
    const root = resolve(cwd);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new Error(`"${arg}" is outside the working directory and is refused`);
    }
  }
  return arg;
}

/** The real path, following links; the lexical one when it cannot be resolved. */
function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * A ref must be a plain value, not another flag and not a control character —
 * it is passed to the CLI as the value of `--snapshot-ref`.
 *
 * It is also a *path*: `ci` reads a ref that names an existing file as a
 * snapshot, resolved against the working directory. Uncontained, `ref:
 * "/elsewhere/creds.json"` diffed that file and returned its values to the
 * agent, and a non-JSON file leaked its opening bytes through the parse error.
 * So a ref naming anything on disk gets the containment a file argument gets,
 * checked on the real path so an in-repo symlink cannot point it outward.
 * @param {unknown} ref
 * @param {string} cwd
 * @returns {string}
 */
function assertSafeRef(ref, cwd) {
  if (typeof ref !== 'string' || ref === '') throw new Error('ref must be a non-empty string');
  if (ref.startsWith('-')) throw new Error(`ref "${ref}" must not start with "-"`);
  if (/[\0\n\r]/.test(ref)) throw new Error('ref must not contain a newline or NUL byte');
  const asPath = resolve(cwd, ref);
  if (existsSync(asPath)) {
    const real = canonicalPath(asPath);
    const root = canonicalPath(cwd);
    if (real !== root && !real.startsWith(root + sep)) {
      throw new Error(`ref "${ref}" names a file outside the working directory and is refused`);
    }
  }
  return ref;
}

/**
 * Cap a list, reporting how much was withheld so a bounded result never claims
 * to be the whole answer.
 * @template T
 * @param {T[]} items
 * @param {number} [cap]
 * @returns {{ items: T[], total: number, omitted: number, truncated: boolean }}
 */
export function bound(items, cap = MAX_ITEMS) {
  const list = Array.isArray(items) ? items : [];
  const kept = list.slice(0, cap);
  return { items: kept, total: list.length, omitted: list.length - kept.length, truncated: list.length > kept.length };
}

/**
 * Build the argv for a read-only `ci` run. This is the *only* place tool inputs
 * become CLI arguments, so the read-only guarantee is auditable in one function:
 * nothing here can emit a write, a webhook, a plugin path, or `--command`.
 *
 * That holds only if no tool input is *parsed* as an option. So every option is
 * emitted first, agent-supplied values ride in `--name=value` form (never as a
 * separate argument the parser could take for a flag), and `--` ends option
 * parsing before the files, which are therefore always operands.
 * @param {{ files: string[], ref?: string, packs?: string[], mask?: boolean }} spec
 * @returns {string[]}
 */
function ciArgs({ files, ref, packs, mask }) {
  const args = ['ci', `--snapshot-ref=${ref ?? 'HEAD'}`, '--format', 'json', '--allow-empty'];
  if (mask !== false) args.push('--mask-secrets');
  if (packs && packs.length > 0) args.push(`--policies=${packs.join(',')}`);
  args.push('--', ...files);
  return args;
}

/**
 * Parse `ci --format json` output into the per-file results. `ci` exits non-zero
 * whenever it finds a change or a finding — that is its gate, not an error — so
 * the exit code is ignored and the presence of parseable stdout is the signal.
 * A genuine failure (no baseline, unreadable file) prints `[error] …` to stderr
 * and leaves stdout empty, which surfaces as a tool error.
 * @param {{ status: number | null, stdout: string, stderr: string }} run
 * @returns {Array<{ file: string, envelope: any, policies: any[] }>}
 */
function parseCiResults(run) {
  const stdout = (run.stdout ?? '').trim();
  if (!stdout) {
    const detail = (run.stderr ?? '').trim() || `flecto exited ${run.status}`;
    throw new Error(detail.replace(/^\[error\]\s*/, ''));
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`could not parse flecto output: ${stdout.slice(0, 200)}`);
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** True when `changePath` is `target` or nested beneath it (`a.b`, `a[0]`). */
function pathMatches(changePath, target) {
  if (changePath === target) return true;
  return changePath.startsWith(`${target}.`) || changePath.startsWith(`${target}[`);
}

/* --------------------------------------------------------------- the tools */

/**
 * @typedef {(args: string[]) => Promise<{ status: number | null, stdout: string, stderr: string }>} FlectoRunner
 */

/** @type {Record<string, (input: any, ctx: { runFlecto: FlectoRunner, cwd: string }) => Promise<object>>} */
const HANDLERS = {
  async flecto_diff(input, { runFlecto, cwd }) {
    const file = assertSafeTargetArg(input?.file, cwd);
    const ref = input?.ref === undefined ? 'HEAD' : assertSafeRef(input.ref, cwd);
    const run = await runFlecto(ciArgs({ files: [file], ref, mask: input?.mask }));
    const results = parseCiResults(run);
    const result = results.find((r) => r.file?.endsWith(file)) ?? results[0];
    const changes = bound(result?.envelope?.changes ?? []);
    return {
      tool: 'flecto_diff',
      file,
      ref,
      masked: input?.mask !== false,
      changeCount: changes.total,
      changes: changes.items,
      ...(changes.truncated ? { truncated: { changes: changes.omitted } } : {}),
      policies: bound(result?.policies ?? []).items,
    };
  },

  async flecto_check(input, { runFlecto, cwd }) {
    if (!Array.isArray(input?.files) || input.files.length === 0) {
      throw new Error('files must be a non-empty array');
    }
    const files = input.files.map((f) => assertSafeTargetArg(f, cwd));
    const packs = Array.isArray(input?.packs) ? input.packs.map(String) : undefined;
    const run = await runFlecto(ciArgs({ files, ref: 'HEAD', packs, mask: input?.mask }));
    const results = parseCiResults(run);
    const findings = results.flatMap((r) => (r.policies ?? []).map((finding) => ({ file: r.file, ...finding })));
    const capped = bound(findings);
    return {
      tool: 'flecto_check',
      files,
      ...(packs ? { packs } : {}),
      masked: input?.mask !== false,
      findingCount: capped.total,
      findings: capped.items,
      ...(capped.truncated ? { truncated: { findings: capped.omitted } } : {}),
    };
  },

  async flecto_explain(input, { runFlecto, cwd }) {
    const file = assertSafeTargetArg(input?.file, cwd);
    if (typeof input?.path !== 'string' || input.path === '') {
      throw new Error('path must be a non-empty string');
    }
    const target = input.path;
    const ref = input?.ref === undefined ? 'HEAD' : assertSafeRef(input.ref, cwd);
    const run = await runFlecto(ciArgs({ files: [file], ref, mask: input?.mask }));
    const results = parseCiResults(run);
    const result = results.find((r) => r.file?.endsWith(file)) ?? results[0];
    const changes = (result?.envelope?.changes ?? []).filter((c) => pathMatches(String(c.path ?? ''), target));
    const findings = (result?.policies ?? []).filter((f) => pathMatches(String(f.path ?? ''), target));
    return {
      tool: 'flecto_explain',
      file,
      path: target,
      ref,
      masked: input?.mask !== false,
      changed: changes.length > 0,
      changes: bound(changes).items,
      findings: bound(findings).items,
      ...(changes.length === 0 ? { note: `No change at "${target}" against ${ref}.` } : {}),
    };
  },
};

/* ------------------------------------------------------------ JSON-RPC core */

const jsonrpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const jsonrpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

/**
 * A dispatcher over parsed JSON-RPC messages, with no I/O of its own so it can
 * be driven directly in tests. Returns the response object, or `null` for a
 * notification (which gets none).
 * @param {{ version: string, cwd: string, runFlecto: FlectoRunner }} ctx
 */
export function createServer({ version, cwd, runFlecto }) {
  let protocolVersion = DEFAULT_PROTOCOL_VERSION;

  return {
    /**
     * @param {any} msg a parsed JSON-RPC message
     * @returns {Promise<object | null>}
     */
    async handle(msg) {
      if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
        return jsonrpcError(msg?.id, -32600, 'Invalid Request');
      }
      const { id, method, params } = msg;
      const isNotification = id === undefined || id === null;

      switch (method) {
        case 'initialize': {
          if (typeof params?.protocolVersion === 'string') protocolVersion = params.protocolVersion;
          return jsonrpcResult(id, {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'flecto', version },
          });
        }
        case 'ping':
          return jsonrpcResult(id, {});
        case 'tools/list':
          return jsonrpcResult(id, { tools: TOOLS });
        case 'tools/call': {
          const name = params?.name;
          const handler = HANDLERS[name];
          if (!handler) {
            return jsonrpcResult(id, {
              content: [{ type: 'text', text: `Unknown tool: ${String(name)}` }],
              isError: true,
            });
          }
          try {
            const payload = await handler(params?.arguments ?? {}, { runFlecto, cwd });
            return jsonrpcResult(id, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
          } catch (err) {
            // A tool-level failure is returned as an error *result*, not a
            // JSON-RPC error, so the model sees the reason and can adjust.
            return jsonrpcResult(id, {
              content: [{ type: 'text', text: `flecto ${name} failed: ${err.message}` }],
              isError: true,
            });
          }
        }
        default:
          // Notifications we do not act on (e.g. notifications/initialized) get
          // no response, per JSON-RPC; unknown requests get method-not-found.
          if (isNotification) return null;
          return jsonrpcError(id, -32601, `Method not found: ${method}`);
      }
    },
  };
}

/**
 * The default runner: spawn the read-only `flecto` CLI. `FLECTO_ALLOW_RC_PLUGINS`,
 * `FLECTO_ALLOW_RC_WRITES`, and `FLECTO_ALLOW_SYMLINK_TARGETS` are stripped from
 * the child so none can be turned on for a tool call, whatever the environment
 * holds.
 * @param {{ nodeExec: string, cliPath: string, cwd: string }} opts
 * @returns {FlectoRunner}
 */
export function makeCliRunner({ nodeExec, cliPath, cwd }) {
  return async (args) => {
    const env = { ...process.env };
    delete env.FLECTO_ALLOW_RC_PLUGINS;
    delete env.FLECTO_ALLOW_RC_WRITES;
    // The symlink-escape check is one of the two containment layers a tool
    // call relies on, so the operator's opt-out does not carry into it either.
    delete env.FLECTO_ALLOW_SYMLINK_TARGETS;
    const run = spawnSync(nodeExec, [cliPath, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
  };
}

/**
 * Serve the MCP protocol over stdio: newline-delimited JSON-RPC in, the same
 * out. All diagnostics go to stderr so stdout carries protocol only.
 * @param {{ version: string, cwd?: string, runFlecto: FlectoRunner, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, onLog?: (msg: string) => void }} opts
 * @returns {Promise<void>} resolves when the input stream ends
 */
export function runStdioServer({ version, cwd = process.cwd(), runFlecto, input = process.stdin, output = process.stdout, onLog = (m) => process.stderr.write(`${m}\n`) }) {
  const server = createServer({ version, cwd, runFlecto });
  let buffer = '';

  const send = (message) => output.write(`${JSON.stringify(message)}\n`);

  const processLine = async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      send(jsonrpcError(null, -32700, 'Parse error'));
      return;
    }
    try {
      const response = await server.handle(msg);
      if (response) send(response);
    } catch (err) {
      onLog(`handler error: ${err.stack ?? err.message}`);
      if (msg && msg.id !== undefined && msg.id !== null) {
        send(jsonrpcError(msg.id, -32603, 'Internal error'));
      }
    }
  };

  return new Promise((resolveDone) => {
    input.setEncoding('utf8');
    // Lines are processed strictly in order: a chain of promises so a slow tool
    // call cannot interleave its response with the next line's.
    let chain = Promise.resolve();
    input.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        chain = chain.then(() => processLine(line));
      }
    });
    input.on('end', () => {
      chain = chain.then(() => processLine(buffer)).then(() => resolveDone());
    });
  });
}
