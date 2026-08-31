import { readFileSync } from 'fs';
import { basename, extname } from 'path';
import yaml from 'js-yaml';
import TOML from '@iarna/toml';
import dotenv from 'dotenv';
import { isArmoredAgeFile, normalizeEncrypted, opaqueFileState } from './encrypted.js';
import { documentKeysOf, withDocumentKeys } from './documents.js';
import { assertNotTerraformPlan } from './terraform.js';

const SUPPORTED_EXT = ['.json', '.jsonc', '.yaml', '.yml', '.toml', '.env', '.ini', '.age'];

// Upper bound on nodes produced when normalizing a parsed tree. Well above any
// real config (a 5,000-key file is 5,000 nodes) and below where alias expansion
// becomes a denial of service. See normalizeParsedValue.
const MAX_NORMALIZED_NODES = 5_000_000;

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
 * Define an own data property, whatever the key is called.
 *
 * `target[key] = value` is not a property write when `key` is `"__proto__"`: it
 * runs the `Object.prototype.__proto__` setter instead, which either reassigns
 * the object's prototype or silently discards the value. `defineProperty` is the
 * operation that was actually meant every time a parser writes a key it read out
 * of a file, and it treats every key name the same.
 * @param {Record<string, unknown>} target
 * @param {string} key
 * @param {unknown} value
 */
function defineOwn(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Minimal INI parser: [section] + key=value.
 * Root keys are top-level; sectioned keys nest under the section name.
 *
 * Section and key names come out of the file, which in Flecto's threat model
 * means they come out of a pull request. They are read and written as **own
 * properties only**: `out[section]` on a section named `__proto__` resolves to
 * `Object.prototype` — which passes `isPlainObject`, since its own prototype is
 * `null` — and every key in that section would then be written onto the
 * prototype of every object in the process. `Object.hasOwn` for the lookup and
 * `defineOwn` for the write make a reserved name an ordinary key holding
 * ordinary data, which is what a config file's `[__proto__]` section is.
 * @param {string} raw
 * @returns {Record<string, unknown>}
 */
export function parseIni(raw) {
  /** @type {Record<string, unknown>} */
  const out = {};
  /** @type {Record<string, unknown>} */
  let bucket = out;

  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const section = sectionMatch[1].trim();
      const existing = Object.hasOwn(out, section) ? out[section] : undefined;
      if (isPlainObject(existing)) {
        bucket = /** @type {Record<string, unknown>} */ (existing);
      } else {
        // A repeated section keeps accumulating; a section colliding with a
        // root scalar replaces it, exactly as before.
        bucket = {};
        defineOwn(out, section, bucket);
      }
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
    defineOwn(bucket, key, value);
  }
  return out;
}

/**
 * Parse JSON that may carry line and block comments and trailing commas —
 * the JSONC dialect `tsconfig.json`, `.vscode/settings.json`, `jsconfig.json`,
 * and `devcontainer.json` are written in by convention.
 *
 * Comments are blanked rather than removed: every stripped character is
 * replaced by a space, and newlines inside a block comment are kept as
 * newlines. That keeps byte offsets and line/column numbers identical to the
 * original file, so the position `JSON.parse` reports on a real syntax error
 * still points at the line the author has open. Deleting the spans instead
 * would silently shift every error after the first comment.
 *
 * The scan tracks string state, because the naive strip is wrong on exactly
 * the values config files are full of: `"https://example.com"` contains `//`,
 * and a `/*` may sit inside a string just as legitimately. Backslash escapes
 * are consumed as a pair so a `\"` never looks like the end of a string.
 *
 * Note that comments are not preserved on the parsed value. Flecto only ever
 * reads config, so nothing is written back — but a snapshot records the parsed
 * structure, not the file, and comments are not part of it.
 * @param {string} raw
 * @returns {unknown}
 */
export function parseJsonc(raw) {
  return JSON.parse(stripJsonComments(raw));
}

/**
 * Blank out JSONC comments and trailing commas, preserving every byte offset.
 * Exported for tests; {@link parseJsonc} is the parsing entry point.
 * @param {string} raw
 * @returns {string}
 */
export function stripJsonComments(raw) {
  const text = String(raw);
  const out = text.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) {
      // Keep line breaks so line numbers in parse errors stay true.
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };

  // Index of a comma that has seen nothing but whitespace since, or -1. When a
  // closing brace or bracket arrives it is a trailing comma and gets blanked.
  let pendingComma = -1;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '"') {
      // A string is opaque: scan to its unescaped closing quote.
      pendingComma = -1;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '"') { i += 1; break; }
        i += 1;
      }
      continue;
    }

    if (ch === '/' && text[i + 1] === '/') {
      let end = i + 2;
      while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1;
      blank(i, end);
      i = end;
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      const closed = text.indexOf('*/', i + 2);
      // An unterminated block comment runs to end of input. Blanking it leaves
      // JSON.parse to report the truncated document, which is the real error.
      const end = closed === -1 ? text.length : closed + 2;
      blank(i, end);
      i = end;
      continue;
    }

    if (ch === ',') {
      pendingComma = i;
    } else if (ch === '}' || ch === ']') {
      if (pendingComma !== -1) out[pendingComma] = ' ';
      pendingComma = -1;
    } else if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
      pendingComma = -1;
    }
    i += 1;
  }

  return out.join('');
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
 *
 * A budget bounds the total nodes produced. YAML aliases resolve to shared
 * object *references*, so a tiny file — `a: &a [x,…]`, `b: [*a,*a,…]`, repeated
 * a handful of levels — parses to a small DAG that this function expands into an
 * exponentially large *tree* (each alias reference is normalized independently,
 * on purpose, so two files with the same shape compare equal). Without a bound,
 * a few hundred bytes of nested aliases hang the process — a "billion laughs"
 * denial of service reachable on any parsed file. The budget makes it fail with
 * a clear error instead. The limit is far above any real config.
 * @param {unknown} value
 * @param {Set<object>} [ancestors] internal recursion state; omit when calling
 * @param {{ n: number }} [budget] internal node counter; omit when calling
 * @returns {unknown}
 */
function normalizeParsedValue(value, ancestors = new Set(), budget = { n: 0 }) {
  if (++budget.n > MAX_NORMALIZED_NODES) {
    throw new Error(
      `document expands to too many nodes (limit ${MAX_NORMALIZED_NODES}); `
      + 'this is usually YAML alias expansion (a "billion laughs" bomb)',
    );
  }
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (value instanceof Date) return value.toJSON();
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return CIRCULAR_SENTINEL;
    ancestors.add(value);
    const out = value.map((item) => normalizeParsedValue(item, ancestors, budget));
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
      return normalizeParsedValue(serialized, ancestors, budget);
    }
  }
  if (isPlainObject(value)) {
    if (ancestors.has(value)) return CIRCULAR_SENTINEL;
    ancestors.add(value);
    const out = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalizeParsedValue(child, ancestors, budget)]),
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
 * True for a document that carries the Kubernetes resource markers `apiVersion`
 * and `kind`. This is the signal used to decide whether a *single*-document file
 * should be keyed by identity like a multi-document one (#124): a manifest that
 * gains a second document beside it must keep the paths it had, and the only way
 * to do that is to key it the same way whether it stands alone or not.
 *
 * Ordinary config that happens to have a `kind` but no `apiVersion` — a form
 * field, say — is not treated as a manifest, so single-document config files are
 * untouched.
 * @param {unknown} doc
 * @returns {boolean}
 */
function isKubernetesDocument(doc) {
  return isPlainObject(doc)
    && scalarField(doc, 'apiVersion') !== null
    && scalarField(doc, 'kind') !== null;
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
 * A file holding a single *non-manifest* document parses to that document
 * unchanged, so diff paths for ordinary YAML are untouched. A file holding
 * several documents — or a single Kubernetes manifest — parses to an object
 * keyed per document, which lets the differ walk it like any other tree and,
 * crucially, keeps a manifest's paths stable when a second document is added
 * beside it (#124). Empty documents (a leading or trailing `---`, or a `null`
 * document) are dropped, so a stray separator does not create a phantom entry.
 *
 * The keys it invents are recorded on the wrapper (see documents.js) so that
 * everything downstream can tell a synthetic document prefix from a real
 * configuration key without having to guess from its shape.
 * @param {string} raw
 * @returns {unknown}
 * @throws {Error} on YAML syntax errors
 */
export function parseYamlStream(raw) {
  const docs = yaml.loadAll(raw).filter((doc) => doc != null);

  if (docs.length === 0) return withDocumentKeys({}, []);

  // A lone document is normally returned bare, preserving ordinary YAML paths.
  // The exception is a Kubernetes manifest with a resolvable identity: keying it
  // now means adding a second document later leaves its paths unchanged, instead
  // of re-pathing the whole file and reporting the untouched resource as
  // removed-and-re-added. Ordinary single-document config is unaffected.
  if (docs.length === 1) {
    const [doc] = docs;
    const identity = isKubernetesDocument(doc) ? documentIdentity(doc) : null;
    if (identity == null || identity === '__proto__') {
      return withDocumentKeys(doc, []);
    }
    return withDocumentKeys({ [identity]: doc }, [identity]);
  }

  const keys = documentKeys(docs);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (let i = 0; i < docs.length; i++) {
    out[keys[i]] = docs[i];
  }
  return withDocumentKeys(out, keys);
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
 *
 * The multi-document keys invented by `parseYamlStream` are handed to the
 * encryption pass explicitly — a SOPS block sits inside each document, not at
 * the root — and re-recorded on the returned tree, since normalization may have
 * replaced the object the mark was on.
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
    } else if (ext === '.json' || ext === '.jsonc') {
      parsed = parseJsonc(raw);
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

  // Guarded here, on the one path every generic command shares, rather than in
  // each command: ci, watch, compare, report, and snapshot reads all land here,
  // and so does a plan read out of git via --snapshot-ref. `flecto plan` reads
  // through readTerraformPlanFile() instead and is unaffected (#113).
  assertNotTerraformPlan(parsed, filepath);

  const keys = documentKeysOf(parsed) ?? [];
  return withDocumentKeys(normalizeEncrypted(normalizeParsedValue(parsed), keys), keys);
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
