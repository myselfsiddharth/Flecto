import chalk from 'chalk';
import { redactSecretString } from './secrets.js';
import { ENCRYPTED_DISPLAY, displayEncrypted, isEncryptedSentinel } from './encrypted.js';
import { secretMatchPath } from './differ.js';

/**
 * Key names that mean "this value is a credential".
 *
 * Matched against the *configuration* path only. A multi-document file prefixes
 * every path with the document's identity — `Deployment/prod/token-service.…` —
 * and that identity is a resource name the user chose, not a key name. Letting
 * it match here masked every value in the document, numbers and booleans
 * included, so the path reaching this regex is always the one
 * {@link secretMatchPath} produced.
 */
const SECRET_PATH_RE = /(secret|token|password|api[_-]?key|private[_-]?key|credential)/i;

/**
 * Format a scalar value for display. Strings get quoted; others are JSON-stringified.
 * @param {unknown} v
 * @param {{ maskSecrets?: boolean, path?: string }} [opts]
 * @returns {string}
 */
function fmt(v, opts = {}) {
  if (v === undefined) return '';
  // An encrypted value reads the same masked or not: there is nothing to mask,
  // because the parser never carried the ciphertext this far.
  if (isEncryptedSentinel(v)) return chalk.dim(ENCRYPTED_DISPLAY);
  let value = displayEncrypted(v);
  if (opts.maskSecrets) {
    if (opts.path && SECRET_PATH_RE.test(opts.path)) {
      return chalk.dim('"***"');
    }
    // The changed path itself can look benign while the value carries secrets,
    // e.g. "database" holding { password }. Redact those the same way the
    // webhook/CI payloads do.
    value = maskSensitiveValue(value, opts.path ?? '');
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
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
  // The full path is what gets printed; the stripped one is what secret-name
  // matching is allowed to see.
  const maskOpts = { maskSecrets: Boolean(opts.maskSecrets), path: secretMatchPath(event) };
  // Notes ride on every change type — a Terraform plan explains a create or a
  // destroy there. The tree differ only ever notes changed events, so existing
  // added/removed output is unaffected.
  const noteStr = note ? chalk.dim(` [${note}]`) : '';

  if (type === 'added') {
    const line = `  ${chalk.green('+')} ${chalk.green(path)}: ${chalk.green(fmt(after, maskOpts))}${noteStr}`;
    return mode === 'verbose'
      ? `${line}\n    ${chalk.dim('(key added)')}`
      : line;
  }

  if (type === 'removed') {
    const line = `  ${chalk.red('-')} ${chalk.red(path)}: ${chalk.red(fmt(before, maskOpts))}${noteStr}`;
    return mode === 'verbose'
      ? `${line}\n    ${chalk.dim('(key removed)')}`
      : line;
  }

  // Both sides ciphertext: the only honest thing to say is that it moved.
  // Printing the two sentinels would be noise, and printing what they stand for
  // is not something Flecto can do or wants to be able to do.
  if (isEncryptedSentinel(before) && isEncryptedSentinel(after)) {
    const line = `  ${chalk.yellow('~')} ${chalk.yellow(path)}: ${chalk.dim('<encrypted value changed>')}`;
    return mode === 'verbose'
      ? `${line}\n    ${chalk.dim('(Flecto never decrypts — only that the ciphertext differs is known)')}`
      : line;
  }

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
 * Print a diff result (for `watch --diff` and `compare`) to stdout.
 * `baseline` names the side the events are measured from, so a cross-file
 * comparison reads unambiguously; it defaults to the saved snapshot.
 * @param {string} filepath
 * @param {import('./differ.js').ChangeEvent[]} events
 * @param {{ maskSecrets?: boolean, baseline?: string }} [opts]
 */
export function renderDiff(filepath, events, opts = {}) {
  const baseline = opts.baseline ?? 'snapshot';

  if (events.length === 0) {
    console.log(chalk.green(`✓ ${filepath} matches ${baseline} — no changes`));
    return;
  }

  console.log(chalk.cyan(`${filepath}`) + ` — ${events.length} change${events.length !== 1 ? 's' : ''} from ${baseline}:`);
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
 * Print a dim status note on stderr, so it stays out of machine-readable stdout.
 * @param {string} msg
 */
export function renderNote(msg) {
  console.error(chalk.dim(msg));
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
 * Mask secret-like values in a plain object tree for CI output. A value is
 * masked when its path looks secret, or — see secrets.js — when the value
 * itself does, which covers credentials stored under innocuous key names.
 * @param {unknown} value
 * @param {string} [path]
 * @returns {unknown}
 */
export function maskSensitiveValue(value, path = '') {
  if (SECRET_PATH_RE.test(path)) return '***';
  if (Array.isArray(value)) {
    return value.map((v, i) => maskSensitiveValue(v, `${path}[${i}]`));
  }
  if (
    value
    && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const child = path ? `${path}.${k}` : k;
      out[k] = maskSensitiveValue(v, child);
    }
    return out;
  }
  if (typeof value === 'string') return redactSecretString(value);
  return value;
}

/**
 * @param {import('./differ.js').ChangeEvent} event
 * @returns {import('./differ.js').ChangeEvent}
 */
export function maskChangeEvent(event) {
  const path = secretMatchPath(event);
  return {
    ...event,
    before: event.before === undefined ? undefined : maskSensitiveValue(event.before, path),
    after: event.after === undefined ? undefined : maskSensitiveValue(event.after, path),
  };
}
