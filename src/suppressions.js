import { basename, extname } from 'path';

/**
 * Inline suppressions: `# flecto-ignore-next-line <rule> — <reason>` on the line
 * above a deliberate finding. The companion to the baseline (#118) — a baseline
 * accepts findings in bulk, a suppression accepts one, in place, next to the
 * thing being accepted.
 *
 * Two rules keep it from decaying into a wall of unexplained `# noqa`:
 *
 * - **A reason is mandatory.** A directive without one is refused, loudly,
 *   naming the file and line — never silently applied and never silently
 *   dropped.
 * - **It is scoped to the next line and a named rule.** No bare "ignore
 *   everything here"; `--ignore` and `severityRemap` already do that, at the
 *   level where they belong.
 *
 * Resolving a directive to a finding is the hard part, because a finding carries
 * a *semantic path*, not a line. We reconstruct the full path of the key on the
 * suppressed line from the raw source — nesting for YAML, section/table for
 * INI/TOML, flat for dotenv — and match a finding whose path equals it (or ends
 * with it, so a multi-document identity prefix does not defeat the match). Using
 * the *full* path, not just the leaf, is what stops a suppression on one
 * `pool_size` from silently hiding an uncommented `pool_size` elsewhere in the
 * file — over-suppression being the dangerous failure for a security tool.
 *
 * JSON has no comment syntax, so inline suppression does not apply to it; use the
 * baseline for JSON.
 */

const DIRECTIVE = /flecto-ignore-next-line\b[ \t]*(.*)$/;
// Strip a leading reason separator: an em dash, one or more hyphens, or a colon.
const REASON_SEPARATOR = /^(?:—|-{1,2}|:)[ \t]*/;

/**
 * @typedef {'yaml' | 'toml' | 'ini' | 'dotenv' | null} SuppressionFormat
 *
 * @typedef {{
 *   rule: string,
 *   reason: string,
 *   line: number,
 *   path: string | null
 * }} Suppression
 *
 * @typedef {{ line: number, message: string }} SuppressionError
 */

/**
 * Which comment-bearing format a file is, or null when inline suppression does
 * not apply (JSON, or an unsupported extension).
 * @param {string} filepath
 * @returns {SuppressionFormat}
 */
export function suppressionFormat(filepath) {
  const base = basename(filepath);
  if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) return 'dotenv';
  switch (extname(filepath).toLowerCase()) {
    case '.yaml':
    case '.yml':
      return 'yaml';
    case '.toml':
      return 'toml';
    case '.ini':
      return 'ini';
    default:
      return null;
  }
}

/**
 * Leading indentation width (spaces; a tab counts as one).
 * @param {string} line
 * @returns {number}
 */
function indentOf(line) {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].length : 0;
}

/**
 * @param {string} raw
 * @returns {boolean}
 */
function isBlankOrComment(raw) {
  const trimmed = raw.trim();
  return trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';');
}

/**
 * Reconstruct the dotted path of the key defined on `targetIndex`, walking the
 * lines above it for context. Returns null when the line is not a plain
 * `key: value` / `key = value` mapping entry (e.g. an array item), which the
 * caller treats as "cannot resolve" rather than guessing.
 * @param {string[]} lines
 * @param {number} targetIndex
 * @param {SuppressionFormat} format
 * @returns {string | null}
 */
function pathAtLine(lines, targetIndex, format) {
  if (format === 'dotenv') return dotenvKey(lines[targetIndex]);
  if (format === 'ini' || format === 'toml') return sectionedKey(lines, targetIndex, format);
  return yamlPath(lines, targetIndex);
}

/**
 * @param {string} line
 * @returns {string | null}
 */
function dotenvKey(line) {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=/.exec(line);
  return match ? match[1] : null;
}

/**
 * INI/TOML share a section/table header + `key = value` shape.
 * @param {string[]} lines
 * @param {number} targetIndex
 * @param {'ini' | 'toml'} format
 * @returns {string | null}
 */
function sectionedKey(lines, targetIndex, format) {
  const target = lines[targetIndex];
  const keyMatch = /^\s*([A-Za-z0-9_.\-"']+)\s*=/.exec(target);
  if (!keyMatch) return null;
  const key = unquote(keyMatch[1].trim());

  let section = null;
  for (let i = 0; i < targetIndex; i++) {
    const line = lines[i].trim();
    // TOML arrays-of-tables ([[x]]) do not map onto a single dotted path.
    if (format === 'toml' && /^\[\[.+\]\]$/.test(line)) { section = null; continue; }
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) section = header[1].trim();
  }
  return section ? `${section}.${key}` : key;
}

/**
 * Reconstruct a nested YAML mapping path via indentation. Array items and
 * multi-document separators yield null, so those are left to the baseline rather
 * than resolved by guesswork.
 * @param {string[]} lines
 * @param {number} targetIndex
 * @returns {string | null}
 */
function yamlPath(lines, targetIndex) {
  const target = lines[targetIndex];
  const targetKey = yamlKey(target);
  if (targetKey === null) return null;

  /** @type {{ indent: number, key: string }[]} */
  const stack = [];
  for (let i = 0; i <= targetIndex; i++) {
    const line = lines[i];
    if (isBlankOrComment(line)) continue;
    if (line.trim() === '---') return null; // multi-document: identity-prefixed, skip
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) return null; // inside a sequence
    const key = yamlKey(line);
    if (key === null) continue;
    const indent = indentOf(line);
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key });
  }
  return stack.map((entry) => entry.key).join('.');
}

/**
 * The key of a `key:` or `key: value` YAML line, or null.
 * @param {string} line
 * @returns {string | null}
 */
function yamlKey(line) {
  const match = /^\s*([^\s:#][^:]*):(?:\s|$)/.exec(line);
  return match ? unquote(match[1].trim()) : null;
}

/**
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse every `flecto-ignore-next-line` directive in a file's raw text.
 * @param {string} raw
 * @param {SuppressionFormat} format
 * @returns {{ suppressions: Suppression[], errors: SuppressionError[] }}
 */
export function parseSuppressions(raw, format) {
  /** @type {Suppression[]} */
  const suppressions = [];
  /** @type {SuppressionError[]} */
  const errors = [];
  if (!format) return { suppressions, errors };

  const lines = String(raw).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = DIRECTIVE.exec(lines[i]);
    if (!match) continue;

    const rest = match[1].trim();
    const ruleMatch = /^(\S+)([\s\S]*)$/.exec(rest);
    const lineNo = i + 1;
    if (!ruleMatch) {
      errors.push({ line: lineNo, message: 'flecto-ignore-next-line needs a rule id and a reason' });
      continue;
    }
    const rule = ruleMatch[1];
    const reason = ruleMatch[2].trim().replace(REASON_SEPARATOR, '').trim();
    if (!reason) {
      errors.push({
        line: lineNo,
        message: `flecto-ignore-next-line ${rule} needs a reason (e.g. "# flecto-ignore-next-line ${rule} — why this is intended")`,
      });
      continue;
    }

    // The suppressed line is the next line that carries config, not another
    // comment or a blank.
    let target = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (!isBlankOrComment(lines[j])) { target = j; break; }
    }
    suppressions.push({
      rule,
      reason,
      line: lineNo,
      path: target === -1 ? null : pathAtLine(lines, target, format),
    });
  }
  return { suppressions, errors };
}

/**
 * True when `findingPath` is the suppression's path, or ends with it on a
 * dotted-segment boundary (tolerating a document-identity prefix).
 * @param {string} findingPath
 * @param {string} suppressionPath
 * @returns {boolean}
 */
function pathMatches(findingPath, suppressionPath) {
  if (!suppressionPath) return false;
  if (findingPath === suppressionPath) return true;
  return findingPath.endsWith(`.${suppressionPath}`);
}

/**
 * Partition findings against a file's suppressions.
 * @param {import('./policy.js').PolicyFinding[]} findings
 * @param {Suppression[]} suppressions
 * @returns {{
 *   active: import('./policy.js').PolicyFinding[],
 *   suppressed: Array<{ finding: import('./policy.js').PolicyFinding, reason: string }>
 * }}
 */
export function applySuppressions(findings, suppressions) {
  const active = [];
  const suppressed = [];
  for (const finding of findings) {
    const hit = suppressions.find((s) =>
      s.path && String(finding.id) === s.rule && pathMatches(String(finding.path ?? ''), s.path));
    if (hit) suppressed.push({ finding, reason: hit.reason });
    else active.push(finding);
  }
  return { active, suppressed };
}
