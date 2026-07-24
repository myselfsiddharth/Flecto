import chokidar from 'chokidar';
import { parseFile } from './parser.js';
import { diffTrees } from './differ.js';
import { renderWarn, renderInfo } from './renderer.js';

/** @typedef {import('./differ.js').ChangeEvent} ChangeEvent */

/**
 * @typedef {Object} WatcherOptions
 * @property {number}   [interval]     Polling fallback interval in ms (default: 100)
 * @property {boolean}  [polling]      Force polling mode (default: false)
 * @property {string}   [mode]         Output mode: 'compact' | 'verbose'
 * @property {string[]} [ignorePaths]  Key paths to suppress in diffs
 * @property {string | null} [arrayIdKey]
 * @property {boolean} [arrayIdentity]
 * @property {boolean} [arrayIgnoreOrder]
 */

/**
 * Start watching a file for semantic changes.
 *
 * @param {string} filepath
 * @param {WatcherOptions} options
 * @param {(event: { kind: 'changes', filepath: string, events: ChangeEvent[] } | { kind: 'lifecycle', filepath: string, lifecycle: { type: string, message: string } }) => void | Promise<void>} onEvent
 * @returns {import('chokidar').FSWatcher}
 */
export function startWatcher(filepath, options = {}, onEvent) {
  const interval = options.interval ?? 100;
  const ignorePaths = options.ignorePaths ?? [];
  const polling = options.polling ?? false;
  const diffOpts = {
    ignorePaths,
    arrayIdKey: options.arrayIdKey ?? null,
    arrayIdentity: options.arrayIdentity !== false,
    arrayIgnoreOrder: Boolean(options.arrayIgnoreOrder),
  };

  /** @type {unknown | null} */
  let lastGoodState = null;

  // Attempt initial parse so we have a baseline before the first write
  try {
    lastGoodState = parseFile(filepath);
  } catch (err) {
    renderWarn(`Could not parse initial state of "${filepath}": ${err.message}`);
    renderWarn('Watching anyway — will use first successful parse as baseline.');
    safelyEmit(onEvent, {
      kind: 'lifecycle',
      filepath,
      lifecycle: { type: 'initial-parse-failed', message: err.message },
    });
  }

  /** @type {NodeJS.Timeout | null} */
  let debounceTimer = null;

  const watcher = chokidar.watch(filepath, {
    persistent: true,
    // Prefer native events; allow users to force polling for flaky FS/network drives.
    usePolling: polling,
    interval: polling ? interval : undefined,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
    ignoreInitial: true,
  });

  const scheduleRead = (reason) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      handleChange(filepath, diffOpts, lastGoodState, (newState, events, lifecycle) => {
        if (newState !== null) {
          lastGoodState = newState;
        }
        if (lifecycle) {
          safelyEmit(onEvent, { kind: 'lifecycle', filepath, lifecycle });
        }
        if (events.length > 0) {
          safelyEmit(onEvent, { kind: 'changes', filepath, events });
        } else if (reason === 'add') {
          safelyEmit(onEvent, {
            kind: 'lifecycle',
            filepath,
            lifecycle: { type: 'file-restored', message: 'File content reloaded after add event.' },
          });
        }
      });
    }, 200);
  };

  // Many editors do atomic saves (unlink+add), so treat add/unlink as change signals too.
  watcher.on('change', () => scheduleRead('change'));
  watcher.on('add', () => {
    // If the file was replaced, re-parse and diff against the last baseline if available.
    scheduleRead('add');
  });
  watcher.on('unlink', () => {
    // File temporarily missing; keep last good state and wait for add.
    renderWarn(`File disappeared: "${filepath}" (waiting for it to reappear)`);
    safelyEmit(onEvent, {
      kind: 'lifecycle',
      filepath,
      lifecycle: { type: 'file-missing', message: 'File disappeared; waiting for restore.' },
    });
  });

  watcher.on('error', (err) => {
    renderWarn(`Watcher error: ${err.message}`);
    safelyEmit(onEvent, {
      kind: 'lifecycle',
      filepath,
      lifecycle: { type: 'watcher-error', message: err.message },
    });
  });

  return watcher;
}

function safelyEmit(onEvent, event) {
  Promise.resolve()
    .then(() => onEvent(event))
    .catch((err) => {
      renderWarn(`Watcher event handler error: ${err?.message ?? String(err)}`);
    });
}

/**
 * Internal: re-parse the file and diff against the previous state.
 * @param {string} filepath
 * @param {{ ignorePaths?: string[], arrayIdKey?: string | null, arrayIdentity?: boolean, arrayIgnoreOrder?: boolean }} diffOpts
 * @param {unknown | null} lastGoodState
 * @param {(newState: unknown | null, events: ChangeEvent[], lifecycle: { type: string, message: string } | null) => void} callback
 */
function handleChange(filepath, diffOpts, lastGoodState, callback) {
  let newState;
  try {
    newState = parseFile(filepath);
  } catch (err) {
    renderWarn(`Parse error — keeping last valid state. ${err.message}`);
    callback(lastGoodState, [], { type: 'parse-error', message: err.message });
    return; // don't update lastGoodState
  }

  if (lastGoodState === null) {
    // First successful parse — record as baseline, no diff to show yet
    renderInfo(`Baseline established for "${filepath}".`);
    callback(newState, [], { type: 'baseline-created', message: 'First valid state recorded.' });
    return;
  }

  const events = diffTrees(lastGoodState, newState, diffOpts);
  callback(newState, events, null);
}
