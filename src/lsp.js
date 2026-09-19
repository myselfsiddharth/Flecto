import { dirname, sep } from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';

/**
 * `flecto lsp` (#142): a Language Server Protocol server over stdio that
 * publishes Flecto's findings and semantic changes as diagnostics while a
 * config file is being edited.
 *
 * The protocol loop does no analysis itself. Each document is analyzed in a
 * worker thread (lsp-worker.js → lsp-analysis.js), which is what makes the two
 * requirements hold at keystroke rate:
 *
 * - **Debounced**: edits to a document restart a short timer, and only the
 *   version that is current when it fires is analyzed.
 * - **Cancellable**: an analysis still running when a newer version of the same
 *   document is ready is abandoned by terminating the worker — a synchronous
 *   parse of a large manifest cannot be interrupted any other way — and one
 *   that runs past the timeout is stopped the same way. A pack regex that
 *   backtracks forever therefore costs one warning diagnostic, not a wedged
 *   server.
 *
 * Results are published only if the document is still open at the version that
 * was analyzed, so a slow answer never overwrites a newer one.
 *
 * Nothing but JSON-RPC is written to `output`: the worker's own stdout and
 * stderr — a plugin that logs, a pack warning — are routed to `log`.
 */

/** JSON-RPC error codes the server uses. */
const ERRORS = { methodNotFound: -32601, serverNotInitialized: -32002, invalidRequest: -32600 };

/**
 * @typedef {{ diagnostics?: object[], error?: string, timedOut?: boolean, cancelled?: boolean }} RunResult
 *
 * @typedef {{
 *   run: (job: Record<string, unknown>) => Promise<RunResult>,
 *   cancel: () => void,
 *   dispose: () => void,
 * }} Executor
 */

/**
 * Run analyses in a worker thread, one at a time.
 * @param {{ timeoutMs: number, log: (message: string) => void }} options
 * @returns {Executor}
 */
export function createWorkerExecutor({ timeoutMs, log }) {
  /** @type {Worker | null} */
  let worker = null;
  /** @type {{ id: number, owner: Worker, resolve: (result: RunResult) => void, timer: NodeJS.Timeout } | null} */
  let pending = null;
  let nextId = 1;

  const settle = (/** @type {RunResult} */ result) => {
    if (!pending) return;
    clearTimeout(pending.timer);
    const { resolve } = pending;
    pending = null;
    resolve(result);
  };

  const stop = (/** @type {RunResult} */ result) => {
    const current = worker;
    worker = null;
    settle(result);
    if (current) void current.terminate();
  };

  const spawn = () => {
    const created = new Worker(new URL('./lsp-worker.js', import.meta.url), { stdout: true, stderr: true });
    created.stdout.on('data', (chunk) => log(String(chunk).trimEnd()));
    created.stderr.on('data', (chunk) => log(String(chunk).trimEnd()));
    created.on('message', (message) => {
      if (pending && message?.id === pending.id) {
        settle(message.error ? { error: message.error } : { diagnostics: message.diagnostics ?? [] });
      }
    });
    // A terminated worker's `exit` arrives asynchronously, often after the next
    // job has started on its replacement, so a worker only ever settles a job
    // it was given.
    created.on('error', (err) => {
      if (worker === created) worker = null;
      if (pending?.owner === created) settle({ error: err?.message ?? String(err) });
    });
    created.on('exit', () => {
      if (worker === created) worker = null;
      if (pending?.owner === created) settle({ error: 'the analysis worker exited unexpectedly' });
    });
    return created;
  };

  return {
    run(job) {
      worker ??= spawn();
      const id = nextId++;
      const target = worker;
      return new Promise((resolve) => {
        pending = {
          id,
          owner: target,
          resolve,
          timer: setTimeout(() => stop({ timedOut: true }), timeoutMs),
        };
        target.postMessage({ ...job, id });
      });
    },
    cancel() {
      if (pending) stop({ cancelled: true });
    },
    dispose() {
      stop({ cancelled: true });
    },
  };
}

/**
 * @param {string} uri
 * @returns {string | null}
 */
function uriToPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/**
 * Apply one `didChange` content change. The server asks for full-document
 * sync, but a client that sends ranged edits anyway is handled rather than
 * silently diverging.
 * @param {string} text
 * @param {{ text: string, range?: { start: { line: number, character: number }, end: { line: number, character: number } } }} change
 * @returns {string}
 */
function applyChange(text, change) {
  if (!change.range) return change.text;
  const offsetOf = ({ line, character }) => {
    let offset = 0;
    for (let current = 0; current < line; current++) {
      const next = text.indexOf('\n', offset);
      if (next === -1) return text.length;
      offset = next + 1;
    }
    return Math.min(offset + character, text.length);
  };
  return text.slice(0, offsetOf(change.range.start)) + change.text + text.slice(offsetOf(change.range.end));
}

/**
 * Start the server on a pair of streams.
 * @param {{
 *   input: NodeJS.ReadableStream,
 *   output: NodeJS.WritableStream,
 *   version: string,
 *   cwd: string,
 *   settings: import('./lsp-analysis.js').LspSettings,
 *   debounceMs?: number,
 *   timeoutMs?: number,
 *   executor?: Executor,
 *   log?: (message: string) => void,
 *   onExit?: (code: number) => void,
 * }} options
 * @returns {{ done: Promise<number> }} resolves with the exit code once the
 *   client sends `exit` or closes the stream
 */
export function startLanguageServer(options) {
  const { input, output, version, settings } = options;
  const debounceMs = options.debounceMs ?? 250;
  const log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
  const executor = options.executor ?? createWorkerExecutor({ timeoutMs: options.timeoutMs ?? 10_000, log });

  /** @type {Map<string, { text: string, version: number }>} */
  const docs = new Map();
  /** @type {Map<string, NodeJS.Timeout>} */
  const timers = new Map();
  /** @type {Set<string>} */
  const queued = new Set();
  /** @type {{ uri: string, version: number } | null} */
  let running = null;
  let initialized = false;
  let shutdownRequested = false;
  let exited = false;
  /** @type {string[]} */
  let roots = [options.cwd];
  let finish = (/** @type {number} */ _code) => {};
  const done = new Promise((resolve) => { finish = resolve; });

  const send = (message) => {
    const body = JSON.stringify({ jsonrpc: '2.0', ...message });
    output.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  };
  const respond = (id, result) => send({ id, result });
  const fail = (id, code, message) => send({ id, error: { code, message } });
  const publish = (uri, docVersion, diagnostics) => send({
    method: 'textDocument/publishDiagnostics',
    params: { uri, ...(docVersion === null ? {} : { version: docVersion }), diagnostics },
  });

  /**
   * The workspace folder that owns a file: the longest one containing it, so
   * `.flectorc` and `policies/` resolve from the right project in a multi-root
   * workspace.
   * @param {string} path
   * @returns {string}
   */
  const rootFor = (path) => roots
    .filter((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep))
    .sort((a, b) => b.length - a.length)[0] ?? dirname(path);

  const pump = () => {
    if (running || queued.size === 0 || exited) return;
    const [uri] = queued;
    queued.delete(uri);
    const doc = docs.get(uri);
    const path = uriToPath(uri);
    if (!doc || !path) {
      pump();
      return;
    }
    const job = { root: rootFor(path), path, text: doc.text, settings };
    running = { uri, version: doc.version };
    const analyzed = running;
    void executor.run(job).then((result) => {
      running = null;
      const current = docs.get(uri);
      if (!result.cancelled && current && current.version === analyzed.version && !exited) {
        if (result.timedOut) {
          publish(uri, analyzed.version, [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            severity: 2,
            source: 'flecto',
            code: 'timeout',
            message: 'Flecto stopped analyzing this file because it took too long. A policy pack regex that'
              + ' backtracks on a long value is the usual cause; `flecto ci` would hang on it too.',
          }]);
        } else if (result.error) {
          publish(uri, analyzed.version, [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            severity: 1,
            source: 'flecto',
            code: 'error',
            message: `Flecto could not analyze this file: ${result.error}`,
          }]);
        } else {
          publish(uri, analyzed.version, result.diagnostics ?? []);
        }
      }
      pump();
    });
  };

  const enqueue = (uri) => {
    queued.add(uri);
    // A newer version of the document being analyzed makes that analysis
    // worthless; stop it rather than wait for it.
    if (running?.uri === uri && docs.get(uri)?.version !== running.version) executor.cancel();
    pump();
  };

  const schedule = (uri) => {
    clearTimeout(timers.get(uri));
    timers.set(uri, setTimeout(() => {
      timers.delete(uri);
      enqueue(uri);
    }, debounceMs));
  };

  const exit = (code) => {
    if (exited) return;
    exited = true;
    for (const timer of timers.values()) clearTimeout(timer);
    executor.dispose();
    finish(code);
    options.onExit?.(code);
  };

  /** @param {any} message */
  const handle = (message) => {
    if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
      if (message && message.id !== undefined && message.method === undefined) return; // a response to us
      if (message?.id !== undefined) fail(message.id, ERRORS.invalidRequest, 'Invalid request');
      return;
    }
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;

    if (method === 'initialize') {
      const folders = Array.isArray(params?.workspaceFolders) ? params.workspaceFolders.map((f) => uriToPath(f?.uri)) : [];
      const rootUriPath = uriToPath(params?.rootUri);
      const found = [...folders, rootUriPath, typeof params?.rootPath === 'string' ? params.rootPath : null]
        .filter((folder) => typeof folder === 'string' && folder.length > 0);
      if (found.length > 0) roots = [...new Set(found)];
      initialized = true;
      respond(id, {
        capabilities: {
          positionEncoding: 'utf-16',
          textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
        },
        serverInfo: { name: 'flecto', version },
      });
      return;
    }
    if (method === 'exit') {
      exit(shutdownRequested ? 0 : 1);
      return;
    }
    if (!initialized) {
      if (isRequest) fail(id, ERRORS.serverNotInitialized, 'Server not initialized');
      return;
    }

    switch (method) {
      case 'initialized':
        return;
      case 'shutdown':
        shutdownRequested = true;
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        queued.clear();
        executor.cancel();
        respond(id, null);
        return;
      case 'textDocument/didOpen': {
        const doc = params?.textDocument;
        if (typeof doc?.uri !== 'string' || typeof doc.text !== 'string') return;
        docs.set(doc.uri, { text: doc.text, version: Number(doc.version) || 0 });
        schedule(doc.uri);
        return;
      }
      case 'textDocument/didChange': {
        const uri = params?.textDocument?.uri;
        const doc = docs.get(uri);
        if (!doc || !Array.isArray(params.contentChanges)) return;
        let { text } = doc;
        for (const change of params.contentChanges) {
          if (typeof change?.text === 'string') text = applyChange(text, change);
        }
        docs.set(uri, { text, version: Number(params.textDocument.version) || doc.version + 1 });
        schedule(uri);
        return;
      }
      case 'textDocument/didSave':
      case 'workspace/didChangeWatchedFiles': {
        // A saved `.flectorc`, pack, or baseline changes what every open
        // document should show, and the analysis reads those from disk.
        for (const uri of docs.keys()) schedule(uri);
        return;
      }
      case 'textDocument/didClose': {
        const uri = params?.textDocument?.uri;
        clearTimeout(timers.get(uri));
        timers.delete(uri);
        queued.delete(uri);
        docs.delete(uri);
        if (running?.uri === uri) executor.cancel();
        if (typeof uri === 'string') publish(uri, null, []);
        return;
      }
      default:
        // Notifications we do not handle ($/cancelRequest, $/setTrace, …) are
        // ignored, as the protocol allows; unknown requests get an error.
        if (isRequest) fail(id, ERRORS.methodNotFound, `Unhandled method ${method}`);
    }
  };

  // Content-Length framing. Lengths are in bytes, so the buffer is kept as
  // bytes and only a complete body is decoded.
  let buffer = Buffer.alloc(0);
  input.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = buffer.subarray(0, headerEnd).toString('ascii');
      const length = /Content-Length:\s*(\d+)/iu.exec(header);
      if (!length) {
        // Unframed garbage: drop through the header terminator and resync.
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + Number(length[1]);
      if (buffer.length < bodyEnd) return;
      const body = buffer.subarray(bodyStart, bodyEnd).toString('utf8');
      buffer = buffer.subarray(bodyEnd);
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        send({ id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      try {
        handle(message);
      } catch (err) {
        log(`flecto lsp: ${err?.stack ?? err}`);
        if (message?.id !== undefined) fail(message.id, -32603, 'Internal error');
      }
    }
  });
  input.on('end', () => exit(shutdownRequested ? 0 : 1));

  return { done };
}
