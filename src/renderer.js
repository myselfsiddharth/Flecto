import chalk from 'chalk';

/**
 * Format a scalar value for display. Strings get quoted; others are JSON-stringified.
 * @param {unknown} v
 * @returns {string}
 */
function fmt(v) {
  if (v === undefined) return '';
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
 * @returns {string}
 */
function renderEvent(event, mode) {
  const { type, path, before, after, note } = event;

  if (type === 'added') {
    const line = `  ${chalk.green('+')} ${chalk.green(path)}: ${chalk.green(fmt(after))}`;
    return mode === 'verbose'
      ? `${line}\n    ${chalk.dim('(key added)')}`
      : line;
  }

  if (type === 'removed') {
    const line = `  ${chalk.red('-')} ${chalk.red(path)}: ${chalk.red(fmt(before))}`;
    return mode === 'verbose'
      ? `${line}\n    ${chalk.dim('(key removed)')}`
      : line;
  }

  // changed
  const noteStr = note ? chalk.dim(` [${note}]`) : '';
  if (mode === 'verbose') {
    return [
      `  ${chalk.yellow('~')} ${chalk.yellow(path)}${noteStr}`,
      `    ${chalk.dim('before:')} ${chalk.red(fmt(before))}`,
      `    ${chalk.dim('after: ')} ${chalk.green(fmt(after))}`,
    ].join('\n');
  }
  return `  ${chalk.yellow('~')} ${chalk.yellow(path)}: ${chalk.red(fmt(before))} ${chalk.dim('→')} ${chalk.green(fmt(after))}${noteStr}`;
}

/**
 * Render a batch of change events to stdout.
 * @param {string} filepath
 * @param {import('./differ.js').ChangeEvent[]} events
 * @param {'compact' | 'verbose'} mode
 */
export function renderChanges(filepath, events, mode = 'compact') {
  const ts = chalk.dim(`[${timestamp()}]`);
  const file = chalk.cyan(filepath);
  const count = `${events.length} change${events.length !== 1 ? 's' : ''}`;

  console.log(`${ts} ${file} — ${count}`);
  for (const event of events) {
    console.log(renderEvent(event, mode));
  }

  if (mode === 'verbose') {
    console.log('');
  }
}

/**
 * Print a diff result (for --diff mode) to stdout.
 * @param {string} filepath
 * @param {import('./differ.js').ChangeEvent[]} events
 */
export function renderDiff(filepath, events) {
  if (events.length === 0) {
    console.log(chalk.green(`✓ ${filepath} matches snapshot — no changes`));
    return;
  }

  console.log(chalk.cyan(`${filepath}`) + ` — ${events.length} change${events.length !== 1 ? 's' : ''} from snapshot:`);
  for (const event of events) {
    console.log(renderEvent(event, 'compact'));
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
    console.log(`  ${prefix} ${chalk.cyan(f.path)}: ${f.message}`);
  }
}
