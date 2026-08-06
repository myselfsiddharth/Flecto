import { readFileSync } from 'fs';
import { basename, extname } from 'path';
import yaml from 'js-yaml';
import TOML from '@iarna/toml';
import dotenv from 'dotenv';
import { isArmoredAgeFile, normalizeEncrypted, opaqueFileState } from './encrypted.js';

const SUPPORTED_EXT = ['.json', '.yaml', '.yml', '.toml', '.env', '.ini', '.age'];

/**
 * True for dotenv-like names: `.env`, `.env.*`, `*.env`
 * @param {string} filepath
 */
export function isEnvFilename(filepath) {
  const base = basename(filepath);
  return base === '.env' || base.startsWith('.env.') || base.endsWith('.env');
}

/**
 * True for INI files.
 * @param {string} filepath
 */
export function isIniFilename(filepath) {
  return extname(filepath).toLowerCase() === '.ini';
}

/**
 * Minimal INI parser: [section] + key=value.
 * Root keys are top-level; sectioned keys nest under the section name.
 * @param {string} raw
 * @returns {Record<string, unknown>}
 */
export function parseIni(raw) {
  /** @type {Record<string, unknown>} */
  const out = {};
  let section = null;

  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      if (!isPlainObject(out[section])) out[section] = {};
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (section == null) {
      out[key] = value;
    } else {
      /** @type {Record<string, string>} */
      const bucket = /** @type {any} */ (out[section]);
      bucket[key] = value;
    }
  }
  return out;
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const prototype = Object.getPrototypeOf(v);
  return prototype === Object.prototype || prototype === null;
}

/**
 * What a YAML anchor that points back at one of its own containers collapses
 * to. See {@link normalizeParsedValue} for why this is necessary and why a
 * plain sentinel, rather than e.g. a path reference, is enough.
 */
export const CIRCULAR_SENTINEL = '<circular>';

/**
 * Convert parser-specific scalar objects into a stable JSON-safe tree before
 * they reach snapshots, the differ, or output renderers.
 *
 * A recursive YAML anchor (`a: &x\n  b: *x`) parses to a genuinely cyclic
 * object — js-yaml resolves the alias to the *same* object reference, not a
 * copy, so `a.b === a`. `ancestors` tracks the containers on the path
 * currently being walked, the same ancestor-tracking pattern `collectLeaves`
 * in policy.js uses for the same reason; revisiting one replaces the
 * back-reference with {@link CIRCULAR_SENTINEL} instead of recursing into it.
 * A value merely reached twice by separate branches (not an ancestor of
 * itself) is still normalized in full on each branch.
 *
 * The result is always plain JSON: safe for `JSON.stringify` at the snapshot
 * write, and safe for the differ, which never sees a cycle because nothing
 * downstream of this function ever does. The sentinel is a fixed string
 * rather than e.g. a back-reference path, so two files with the same cycle
 * shape normalize to the same tree and compare equal — the whole point of a
 * stable, readable diff path.
 * @param {unknown} value
 * @param {Set<object>} [ancestors] internal recursion state; omit when calling
 * @returns {unknown}
 */
function normalizeParsedValue(value, ancestors = new Set()) {
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (value instanceof Date) return value.toJSON();
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return CIRCULAR_SENTINEL;
    ancestors.add(value);
    const out = value.map((item) => normalizeParsedValue(item, ancestors));
    ancestors.delete(value);
    return out;
  }
  if (
    value !== null
    && typeof value === 'object'
    && typeof value.toJSON === 'function'
  ) {
    const serialized = value.toJSON();
    if (serialized !== value && (serialized === null || typeof serialized !== 'object')) {
      return normalizeParsedValue(serialized, ancestors);
    }
  }
  if (isPlainObject(value)) {
    if (ancestors.has(value)) return CIRCULAR_SENTINEL;
    ancestors.add(value);
    const out = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalizeParsedValue(child, ancestors)]),
    );
    ancestors.delete(value);
    return out;
  }
  return value;
}

/**
 * Read a scalar field as a non-empty string, or null.
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @returns {string | null}
 */
function scalarField(obj, key) {
  const value = obj[key];
  if (value == null || typeof value === 'object') return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/**
 * Stable identity for one document of a multi-document YAML file.
 * Kubernetes-shaped documents key on `kind/name`, with the namespace inserted
 * when present (`kind/namespace/name`). Anything else falls back to a top-level
 * `id` then `name`, mirroring array identity matching in the differ.
 * @param {unknown} doc
 * @returns {string | null} null when the document has no stable identity
 */
function documentIdentity(doc) {
  if (!isPlainObject(doc)) return null;

  const kind = scalarField(doc, 'kind');
  const metadata = isPlainObject(doc.metadata) ? doc.metadata : null;
  const name = metadata ? scalarField(metadata, 'name') : null;
  if (kind && name) {
    const namespace = scalarField(metadata, 'namespace');
    return namespace ? `${kind}/${namespace}/${name}` : `${kind}/${name}`;
  }

  return scalarField(doc, 'id') ?? scalarField(doc, 'name');
}

/**
 * Keys for a multi-document file: identities when every document has a unique
 * one, otherwise document indices. It is all-or-nothing so keys within one file
 * stay homogeneous.
 * @param {unknown[]} docs
 * @returns {string[]}
 */
function documentKeys(docs) {
  const identities = docs.map((doc) => {
    const identity = documentIdentity(doc);
    // "__proto__" as a key would mutate the prototype instead of adding an
    // entry, silently losing the document. Fall back to indices instead.
    return identity === '__proto__' ? null : identity;
  });
  const unique = new Set(identities);
  if (!identities.includes(null) && unique.size === identities.length) {
    return /** @type {string[]} */ (identities);
  }
  return docs.map((_, index) => String(index));
}

/**
 * Parse a YAML stream, supporting `---`-separated multi-document files.
 *
 * A file holding a single document parses to that document unchanged, so diff
 * paths for ordinary YAML are untouched. A file holding several documents
 * parses to an object keyed per document, which lets the differ walk it like
 * any other tree. Empty documents (a leading or trailing `---`, or a `null`
 * document) are dropped, so a stray separator does not create a phantom entry.
 * @param {string} raw
 * @returns {unknown}
 * @throws {Error} on YAML syntax errors
 */
export function parseYamlStream(raw) {
  const docs = yaml.loadAll(raw).filter((doc) => doc != null);

  if (docs.length === 0) return {};
  if (docs.length === 1) return docs[0];

  const keys = documentKeys(docs);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (let i = 0; i < docs.length; i++) {
    out[keys[i]] = docs[i];
  }
  return out;
}

/**
 * Auto-detect the format of a file and parse it into a plain JS object.
 *
 * The parsed tree then goes through the encryption pass (see encrypted.js),
 * which replaces every ciphertext-bearing value with an opaque sentinel. Doing
 * it here rather than at render time is what makes the guarantee absolute:
 * nothing downstream — diff, snapshot, webhook, report — is ever handed
 * ciphertext, because the parser never produces any. A file with nothing to
 * redact comes back as the very same object.
 * @param {string} filepath
 * @param {string} raw
 * @returns {unknown}
 * @throws {Error} on unsupported format or parse failure
 */
export function parseContent(filepath, raw) {
  const ext = extname(filepath).toLowerCase();
  const envLike = isEnvFilename(filepath);
  const iniLike = isIniFilename(filepath);

  if (!envLike && !iniLike && !SUPPORTED_EXT.includes(ext)) {
    const supported = [...SUPPORTED_EXT, '.env.*', '*.env'].join(', ');
    throw new Error(
      `Unsupported file format "${ext || '(none)'}" for "${filepath}".\n` +
      `Supported extensions: ${supported}`
    );
  }

  // A `.age` file, and any file that opens with the age armor header, is one
  // opaque blob rather than a config document. There is no structure to parse
  // and no parser that would not be guessing.
  if (ext === '.age' || isArmoredAgeFile(raw)) {
    return opaqueFileState(raw);
  }

  let parsed;
  try {
    if (envLike || ext === '.env') {
      parsed = dotenv.parse(raw);
    } else if (iniLike) {
      parsed = parseIni(raw);
    } else if (ext === '.json') {
      parsed = JSON.parse(raw);
    } else if (ext === '.yaml' || ext === '.yml') {
      parsed = parseYamlStream(raw);
    } else if (ext === '.toml') {
      parsed = TOML.parse(raw);
    }
  } catch (err) {
    const lineMatch = err.message?.match(/line (\d+)/i);
    const lineInfo = lineMatch ? ` (line ${lineMatch[1]})` : '';
    throw new Error(
      `Parse error in "${filepath}"${lineInfo}: ${err.message}`
    );
  }

  return normalizeEncrypted(normalizeParsedValue(parsed));
}

/**
 * Auto-detect the format of a file and parse it into a plain JS value.
 * @param {string} filepath
 * @returns {unknown}
 */
export function parseFile(filepath) {
  let raw;
  try {
    raw = readFileSync(filepath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read file "${filepath}": ${err.message}`);
  }
  return parseContent(filepath, raw);
}

/**
 * Returns true if the file format is supported.
 * @param {string} filepath
 * @returns {boolean}
 */
export function isSupported(filepath) {
  if (isEnvFilename(filepath) || isIniFilename(filepath)) return true;
  return SUPPORTED_EXT.includes(extname(filepath).toLowerCase());
}
