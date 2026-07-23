import chalk from 'chalk';

const SECRET_PATH_RE = /(secret|token|password|api[_-]?key|private[_-]?key|credential)/i;

/**
 * Format a scalar value for display. Strings get quoted; others are JSON-stringified.
 * @param {unknown} v
 * @param {{ maskSecrets?: boolean, path?: string }} [opts]
 * @returns {string}
 */
function fmt(v, opts = {}) {
  if (v === undefined) return '';
  if (opts.maskSecrets && opts.path && SECRET_PATH_RE.test(opts.path)) {
    return chalk.dim('"***"');
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return String(v);
}

/**
 * Return a HH:MM:SS timestamp string.
 * @returns {string}
 */
function timestamp() {
  return new Date().toTimeString().slice(0, 8);
}

/**
 * Render a single change event as a colored string.
 * @param {import('./differ.js').ChangeEvent} event
 * @param {'compact' | 'verbose'} mode
 * @param {{ maskSecrets?: boolean }} [opts]
 * @returns {string}
 */
function renderEvent(event, mode, opts = {}) {
  const { type, path, before, after, note } = event;
  const maskOpts = { maskSecrets: Boolean(opts.maskSecrets), path };

  if (type === 'added') {
    const line = `  ${chalk.green('+')} ${chalk.green(path)}: ${chalk.green(fmt(after, maskOpts))}`;
    return mode === 'verbose'
      ? `${line}\n    ${chalk.dim('(key added)')}`
      : line;
  }

  if (type === 'removed') {
    const line = `  ${chalk.red('-')} ${chalk.red(path)}: ${chalk.red(fmt(before, maskOpts))}`;
    return mode === 'verbose'
      ? `${line}\n    ${chalk.dim('(key removed)')}`
      : line;
  }

  const noteStr = note ? chalk.dim(` [${note}]`) : '';
  if (mode === 'verbose') {
    return [
      `  ${chalk.yellow('~')} ${chalk.yellow(path)}${noteStr}`,
      `    ${chalk.dim('before:')} ${chalk.red(fmt(before, maskOpts))}`,
      `    ${chalk.dim('after: ')} ${chalk.green(fmt(after, maskOpts))}`,
    ].join('\n');
  }
  return `  ${chalk.yellow('~')} ${chalk.yellow(path)}: ${chalk.red(fmt(before, maskOpts))} ${chalk.dim('→')} ${chalk.green(fmt(after, maskOpts))}${noteStr}`;
}

/**
 * Render a batch of change events to stdout.
 * @param {string} filepath
 * @param {import('./differ.js').ChangeEvent[]} events
 * @param {'compact' | 'verbose'} mode
 * @param {{ maskSecrets?: boolean }} [opts]
 */
export function renderChanges(filepath, events, mode = 'compact', opts = {}) {
  const ts = chalk.dim(`[${timestamp()}]`);
  const file = chalk.cyan(filepath);
  const count = `${events.length} change${events.length !== 1 ? 's' : ''}`;

  console.log(`${ts} ${file} — ${count}`);
  for (const event of events) {
    console.log(renderEvent(event, mode, opts));
  }

  if (mode === 'verbose') {
    console.log('');
  }
}

/**
 * Print a diff result (for --diff mode) to stdout.
 * @param {string} filepath
 * @param {import('./differ.js').ChangeEvent[]} events
 * @param {{ maskSecrets?: boolean }} [opts]
 */
export function renderDiff(filepath, events, opts = {}) {
  if (events.length === 0) {
    console.log(chalk.green(`✓ ${filepath} matches snapshot — no changes`));
    return;
  }

  console.log(chalk.cyan(`${filepath}`) + ` — ${events.length} change${events.length !== 1 ? 's' : ''} from snapshot:`);
  for (const event of events) {
    console.log(renderEvent(event, 'compact', opts));
  }
}

/**
 * Print an error message in red.
 * @param {string} msg
 */
export function renderError(msg) {
  console.error(chalk.red(`[error] ${msg}`));
}

/**
 * Print a warning in yellow.
 * @param {string} msg
 */
export function renderWarn(msg) {
  console.warn(chalk.yellow(`[warn] ${msg}`));
}

/**
 * Print an info message in dim text.
 * @param {string} msg
 */
export function renderInfo(msg) {
  console.log(chalk.dim(msg));
}

/**
 * Print policy findings.
 * @param {import('./policy.js').PolicyFinding[]} findings
 */
export function renderPolicyFindings(findings) {
  if (!findings || findings.length === 0) return;
  for (const f of findings) {
    const prefix = f.severity === 'error'
      ? chalk.red('! policy(error)')
      : f.severity === 'warn'
        ? chalk.yellow('! policy(warn)')
        : chalk.blue('! policy(info)');
    const pack = f.pack ? chalk.dim(` [${f.pack}]`) : '';
    console.log(`  ${prefix}${pack} ${chalk.cyan(f.path)}: ${f.message}`);
  }
}

/**
 * Mask secret-like values in a plain object tree for CI output.
 * @param {unknown} value
 * @param {string} [path]
 * @returns {unknown}
 */
export function maskSensitiveValue(value, path = '') {
  if (SECRET_PATH_RE.test(path)) return '***';
  if (Array.isArray(value)) {
    return value.map((v, i) => maskSensitiveValue(v, `${path}[${i}]`));
  }
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const child = path ? `${path}.${k}` : k;
      out[k] = maskSensitiveValue(v, child);
    }
    return out;
  }
  return value;
}

/**
 * @param {import('./differ.js').ChangeEvent} event
 * @returns {import('./differ.js').ChangeEvent}
 */
export function maskChangeEvent(event) {
  return {
    ...event,
    before: event.before === undefined ? undefined : maskSensitiveValue(event.before, event.path),
    after: event.after === undefined ? undefined : maskSensitiveValue(event.after, event.path),
  };
}
