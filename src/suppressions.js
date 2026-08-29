import { basename, extname } from 'path';

import { stripJsonComments } from './parser.js';

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
 * JSON is included, because `.json` and `.jsonc` are parsed as JSONC (#152) and
 * so do carry comments. Its resolver reuses the parser's comment stripper rather
 * than recognising line and block comments a second time: they are blanked in
 * place, preserving every line number, and the key scan then walks a
 * comment-free copy.
 *
 * A directive that cannot be resolved to a key — an array element in any format,
 * or a file type with no comment syntax at all — produces a **warning naming the
 * file and line**. That case fails closed (the finding still fires and still
 * gates), so it is not a second build failure on top of the first; but a
 * suppression the author believes is applied and which is quietly absent is
 * exactly the failure mode this file exists to avoid, so it is never silent.
 */

const DIRECTIVE = /flecto-ignore-next-line\b[ \t]*(.*)$/;
// Strip a leading reason separator: an em dash, one or more hyphens, or a colon.
const REASON_SEPARATOR = /^(?:—|-{1,2}|:)[ \t]*/;

/**
 * @typedef {'yaml' | 'json' | 'toml' | 'ini' | 'dotenv' | null} SuppressionFormat
 *
 * @typedef {{
 *   rule: string,
 *   reason: string,
 *   line: number,
 *   path: string | null
 * }} Suppression
 *
 * @typedef {{ line: number, message: string }} SuppressionError
 *
 * @typedef {{ line: number, message: string }} SuppressionWarning
 */

/**
 * Which comment-bearing format a file is, or null when inline suppression does
 * not apply to it — an encrypted file, or an extension with no comment syntax.
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
    case '.json':
    case '.jsonc':
      return 'json';
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
 * Whether a line carries no config. JSON is scanned on a comment-blanked copy,
 * so its comments are already whitespace by the time this runs — treating a `#`
 * there as a comment would misread a line whose value merely starts with one.
 * @param {string} raw
 * @param {SuppressionFormat} [format]
 * @returns {boolean}
 */
function isBlankOrComment(raw, format) {
  const trimmed = raw.trim();
  if (trimmed === '') return true;
  if (format === 'json') return false;
  return trimmed.startsWith('#') || trimmed.startsWith(';');
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
  if (format === 'json') return jsonPath(lines, targetIndex);
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

/** Key of a `"key":` entry, capturing the raw (still-escaped) name. */
const JSON_KEY = /^\s*"((?:[^"\\]|\\.)*)"\s*:/;

/**
 * Reconstruct a nested JSON object path from the enclosing key stack. `lines`
 * are already comment-blanked, so what is scanned is config and nothing else.
 *
 * Anything inside an **array** yields null. That is the same refusal YAML makes
 * for a sequence item, and for the same reason: an array element's diff path is
 * either its index or its `arrayIdKey` identity depending on how the run is
 * configured, so a resolver that guessed one would suppress the wrong finding
 * under the other — over-suppression being the dangerous direction here. The
 * caller warns rather than dropping it quietly.
 * @param {string[]} lines
 * @param {number} targetIndex
 * @returns {string | null}
 */
function jsonPath(lines, targetIndex) {
  const key = jsonKeyOnLine(lines[targetIndex]);
  if (key === null) return null;
  const enclosing = jsonContainerKeys(lines.slice(0, targetIndex).join('\n'));
  if (enclosing === null) return null;
  return [...enclosing, key].join('.');
}

/**
 * @param {string} line
 * @returns {string | null}
 */
function jsonKeyOnLine(line) {
  const match = JSON_KEY.exec(line);
  return match ? decodeJsonString(match[1]) : null;
}

/**
 * A JSON key is an escaped string, so `\u00e9` and `\"` have to be decoded to
 * the name the differ reports rather than compared raw.
 * @param {string} inner
 * @returns {string | null}
 */
function decodeJsonString(inner) {
  try {
    return JSON.parse(`"${inner}"`);
  } catch {
    return null;
  }
}

/**
 * The object keys enclosing the end of `text`, outermost first, or null when
 * the position sits inside an array or the structure cannot be read. The root
 * container contributes no segment, matching how the differ builds a path.
 * @param {string} text
 * @returns {string[] | null}
 */
function jsonContainerKeys(text) {
  /** @type {{ array: boolean, key: string | null }[]} */
  const stack = [];
  let lastKey = null;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '"') {
      // Strings are opaque: a brace or bracket inside one is data, not structure.
      let end = i + 1;
      while (end < text.length) {
        if (text[end] === '\\') { end += 2; continue; }
        if (text[end] === '"') break;
        end += 1;
      }
      const inner = text.slice(i + 1, end);
      i = end + 1;
      let next = i;
      while (next < text.length && /\s/.test(text[next])) next += 1;
      // A string followed by a colon names the value that follows; otherwise it
      // is itself a value, and names nothing.
      if (text[next] === ':') {
        lastKey = decodeJsonString(inner);
        i = next + 1;
      }
      continue;
    }

    if (ch === '{' || ch === '[') {
      stack.push({ array: ch === '[', key: lastKey });
      lastKey = null;
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      lastKey = null;
    } else if (ch === ',') {
      lastKey = null;
    }
    i += 1;
  }

  if (stack.length === 0) return null;
  if (stack.some((frame) => frame.array)) return null;
  const keys = stack.slice(1).map((frame) => frame.key);
  return keys.some((key) => key === null) ? null : /** @type {string[]} */ (keys);
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
    if (isBlankOrComment(line, 'yaml')) continue;
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
 * @returns {{
 *   suppressions: Suppression[],
 *   errors: SuppressionError[],
 *   warnings: SuppressionWarning[]
 * }}
 */
export function parseSuppressions(raw, format) {
  /** @type {Suppression[]} */
  const suppressions = [];
  /** @type {SuppressionError[]} */
  const errors = [];
  /** @type {SuppressionWarning[]} */
  const warnings = [];

  const text = String(raw);
  const lines = text.split(/\r?\n/);
  // Directives are read from the raw text, and keys from a comment-blanked copy
  // of it. stripJsonComments() replaces each stripped character with a space and
  // keeps newlines, so the two are line-for-line identical.
  const code = format === 'json' ? stripJsonComments(text).split(/\r?\n/) : lines;

  for (let i = 0; i < lines.length; i++) {
    const match = DIRECTIVE.exec(lines[i]);
    if (!match) continue;
    // Directives are scanned on the raw line so `// flecto-ignore-next-line`
    // is visible. For JSON, comments have already been blanked on `code`, so a
    // match still present there lived inside a string — data, not a comment.
    // Treating it as a suppression would hide the next key, the over-suppression
    // this resolver exists to refuse.
    if (format === 'json') {
      const blanked = code[i].slice(match.index, match.index + match[0].length);
      if (blanked.trim() !== '') continue;
    }
    const lineNo = i + 1;

    // A directive in a file whose format cannot carry one does nothing. Saying
    // so is the whole point: the author believes the finding is accepted.
    if (!format) {
      warnings.push({
        line: lineNo,
        message: 'inline suppressions do not apply to this file type and this directive has no effect — use --baseline to accept the finding',
      });
      continue;
    }

    const rest = match[1].trim();
    const ruleMatch = /^(\S+)([\s\S]*)$/.exec(rest);
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
    for (let j = i + 1; j < code.length; j++) {
      if (!isBlankOrComment(code[j], format)) { target = j; break; }
    }
    const path = target === -1 ? null : pathAtLine(code, target, format);
    if (path === null) {
      warnings.push({
        line: lineNo,
        message: `flecto-ignore-next-line ${rule} does not resolve to a config key, so it suppresses nothing — array elements and multi-document files are not addressable inline; use --baseline`,
      });
    }
    suppressions.push({ rule, reason, line: lineNo, path });
  }
  return { suppressions, errors, warnings };
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
