import { extname } from 'path';
import yaml from 'js-yaml';

import { isArmoredAgeFile } from './encrypted.js';
import { isEnvFilename, isIniFilename, stripJsonComments, yamlDocumentKeys } from './parser.js';

/**
 * Where a config path lives in the source text (#142).
 *
 * The differ reports paths (`db.pool_size`, `containers["web"].image`), not
 * positions: every parser Flecto uses hands back a plain tree and forgets where
 * each value came from. Diagnostics need a line and a range, and **a diagnostic
 * anchored to the wrong line is worse than none**, so this module is built
 * around one rule: a position is reported only where an independent reading of
 * the text agrees with the tree the differ actually diffed.
 *
 * Each format gets a scanner that records positions — the js-yaml listener for
 * YAML, dotenv's own line pattern, and small hand-written scanners for JSON,
 * INI, and TOML. The scanned structure is then checked against the parsed tree
 * node by node ({@link verify}): a mapping is trusted only when its keys are
 * exactly the parsed object's keys, a sequence only when its length matches.
 * Anything that disagrees — a construct a scanner does not model, a SOPS block
 * the encryption pass rewrote, a merged-in key — stops the lookup there, and the
 * diagnostic anchors to the nearest ancestor that *was* verified, never to a
 * guess.
 *
 * @typedef {{
 *   kind: 'mapping' | 'sequence' | 'scalar' | 'opaque',
 *   start: number,
 *   end: number,
 *   entries?: Map<string, PosEntry>,
 *   merge?: { start: number, end: number } | null,
 *   items?: PosNode[],
 *   trusted?: boolean,
 *   value?: unknown,
 * }} PosNode
 *
 * @typedef {{ keyStart: number, keyEnd: number, node: PosNode, check?: unknown, unsure?: boolean }} PosEntry
 *
 * @typedef {{ text: string, root: PosNode | null, lineStarts: number[] }} PositionIndex
 *
 * @typedef {'exact' | 'merge' | 'ancestor' | 'file'} Precision
 *   `exact`: the path itself. `merge`: a key a YAML merge (`<<`) brought in,
 *   anchored at the merge. `ancestor`: the path is not in the text (removed) or
 *   not addressable, so the nearest enclosing key that is. `file`: nothing
 *   narrower is known.
 *
 * @typedef {{ start: number, end: number, precision: Precision }} Location
 */

const MERGE_TAG = 'tag:yaml.org,2002:merge';

/**
 * Build the position index for a file's text, verified against the tree the
 * parser produced from that same text.
 * @param {string} filepath decides the format, exactly as the parser does
 * @param {string} text the raw source
 * @param {unknown} parsed what `parseContent(filepath, text)` returned
 * @returns {PositionIndex} `root` is null when the format has no position
 *   support or the text could not be scanned; every lookup is then file-level
 */
export function buildPositionIndex(filepath, text, parsed) {
  const source = String(text);
  let root = null;
  try {
    root = scan(filepath, source);
  } catch {
    root = null;
  }
  if (root) verify(root, parsed);
  return { text: source, root, lineStarts: lineStartsOf(source) };
}

/**
 * @param {string} filepath
 * @param {string} text
 * @returns {PosNode | null}
 */
function scan(filepath, text) {
  const ext = extname(filepath).toLowerCase();
  if (ext === '.age' || isArmoredAgeFile(text)) return null;
  if (isEnvFilename(filepath) || ext === '.env') return scanDotenv(text);
  if (isIniFilename(filepath)) return scanIni(text);
  if (ext === '.json' || ext === '.jsonc') return scanJson(text);
  if (ext === '.yaml' || ext === '.yml') return scanYaml(text);
  if (ext === '.toml') return scanToml(text);
  return null;
}

// ---------------------------------------------------------------------------
// Verification

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Mark each node trusted only where it agrees with the parsed tree, and attach
 * the parsed value it stands for (array identity lookups read it).
 * @param {PosNode} node
 * @param {unknown} value
 */
function verify(node, value) {
  node.value = value;
  node.trusted = false;
  if (node.kind === 'mapping') {
    if (!isPlainObject(value)) return;
    const entries = /** @type {Map<string, PosEntry>} */ (node.entries);
    for (const key of entries.keys()) {
      if (!Object.hasOwn(value, key)) return;
    }
    // A key the text does not show is only explainable by a merge.
    if (!node.merge && Object.keys(value).some((key) => !entries.has(key))) return;
    node.trusted = true;
    for (const [key, entry] of entries) {
      // A duplicated key resolves by the parser's rule (last wins for dotenv);
      // if the value at the position chosen does not match, that position is
      // not claimed.
      if ('check' in entry && entry.check !== value[key]) entry.unsure = true;
      verify(entry.node, value[key]);
    }
    return;
  }
  if (node.kind === 'sequence') {
    const items = /** @type {PosNode[]} */ (node.items);
    if (!Array.isArray(value) || value.length !== items.length) return;
    node.trusted = true;
    items.forEach((item, index) => verify(item, value[index]));
    return;
  }
  // Nothing below a scalar is addressable; an opaque node is never trusted.
  node.trusted = node.kind === 'scalar';
}

// ---------------------------------------------------------------------------
// Lookup

/**
 * Locate a diff path in the text.
 *
 * Paths are the differ's: `a.b`, `list[0]`, `list["web"]` (array identity),
 * `list[*]` (order-insensitive — no single element to point at). A key may
 * itself contain `.` or `[`, so candidates are tried against the raw path and a
 * path that reads two ways resolves to neither.
 * @param {PositionIndex} index
 * @param {string} path
 * @param {{ arrayIdKey?: string | null }} [options] the run's configured
 *   identity key, which is the only one the differ would have used
 * @returns {Location}
 */
export function locatePath(index, path, options = {}) {
  const file = { start: 0, end: 0, precision: /** @type {Precision} */ ('file') };
  if (!index?.root || typeof path !== 'string') return file;
  const outcome = resolve(index.root, path, null, options, index.text);
  if (!outcome.anchor) return file;
  return { ...outcome.anchor, precision: outcome.precision };
}

/**
 * @typedef {{ anchor: { start: number, end: number } | null, precision: Precision, complete: boolean }} Outcome
 */

/**
 * @param {PosNode} node
 * @param {string} rest the path still to consume below `node`
 * @param {{ start: number, end: number } | null} anchor where `node` itself is named
 * @param {{ arrayIdKey?: string | null }} options
 * @param {string} text
 * @returns {Outcome}
 */
function resolve(node, rest, anchor, options, text) {
  const here = { anchor, precision: /** @type {Precision} */ (anchor ? 'ancestor' : 'file'), complete: false };
  if (rest === '') return { anchor, precision: anchor ? 'exact' : 'file', complete: true };
  if (!node.trusted) return here;

  if (node.kind === 'mapping') {
    /** @type {Outcome[]} */
    const outcomes = [];
    for (const [key, entry] of /** @type {Map<string, PosEntry>} */ (node.entries)) {
      if (entry.unsure || !rest.startsWith(key)) continue;
      const next = rest.slice(key.length);
      if (next !== '' && next[0] !== '.' && next[0] !== '[') continue;
      outcomes.push(resolve(
        entry.node,
        next[0] === '.' ? next.slice(1) : next,
        entryRange(entry, text),
        options,
        text,
      ));
    }
    const complete = outcomes.filter((outcome) => outcome.complete);
    if (complete.length === 1) return complete[0];
    // Two readings of one path: pointing at either would be a guess.
    if (complete.length > 1 || outcomes.length > 1) return here;
    if (outcomes.length === 1) return outcomes[0];
    if (node.merge) return { anchor: node.merge, precision: 'merge', complete: false };
    return here;
  }

  if (node.kind === 'sequence') {
    const match = /^\[(\d+|"(?:[^"\\]|\\.)*")\]/u.exec(rest);
    if (!match) return here;
    const items = /** @type {PosNode[]} */ (node.items);
    const item = match[1].startsWith('"')
      ? itemByIdentity(items, match[1], options.arrayIdKey)
      : items[Number(match[1])];
    if (!item) return here;
    const next = rest.slice(match[0].length);
    return resolve(item, next[0] === '.' ? next.slice(1) : next, itemRange(item, text), options, text);
  }

  return here;
}

/**
 * The element an identity segment (`["web"]`) names, the way the differ chose
 * it: the configured key when there is one, else `id`, else `name`. The differ
 * picked a key using both sides of the diff and this sees only one, so an
 * element is returned only when every candidate key agrees on it.
 * @param {PosNode[]} items
 * @param {string} quoted the segment's JSON string literal
 * @param {string | null | undefined} arrayIdKey
 * @returns {PosNode | null}
 */
function itemByIdentity(items, quoted, arrayIdKey) {
  let target;
  try {
    target = JSON.parse(quoted);
  } catch {
    return null;
  }
  const keys = arrayIdKey ? [String(arrayIdKey)] : ['id', 'name'];
  /** @type {Set<PosNode>} */
  const matches = new Set();
  for (const key of keys) {
    for (const item of items) {
      const value = item.value;
      if (!isPlainObject(value) || !Object.hasOwn(value, key)) continue;
      const id = value[key];
      if (id === null || id === undefined || typeof id === 'object') continue;
      if (String(id) === target) matches.add(item);
    }
  }
  return matches.size === 1 ? [...matches][0] : null;
}

/**
 * The range a diagnostic about an entry underlines: the key, extended over a
 * scalar value on the same line (`pool_size: 20`), but never over a whole
 * nested block.
 * @param {PosEntry} entry
 * @param {string} text
 * @returns {{ start: number, end: number }}
 */
function entryRange(entry, text) {
  const { node } = entry;
  const sameLine = !/[\r\n]/u.test(text.slice(entry.keyStart, node.end));
  return {
    start: entry.keyStart,
    end: node.kind === 'scalar' && sameLine && node.end > entry.keyEnd ? node.end : entry.keyEnd,
  };
}

/**
 * The range for a sequence element: the whole element when it is a one-line
 * scalar, otherwise its first line.
 * @param {PosNode} item
 * @param {string} text
 * @returns {{ start: number, end: number }}
 */
function itemRange(item, text) {
  const firstLineEnd = lineEndOf(text, item.start);
  return { start: item.start, end: Math.min(item.end > item.start ? item.end : firstLineEnd, firstLineEnd) };
}

// ---------------------------------------------------------------------------
// Offsets and LSP positions

/**
 * @param {string} text
 * @returns {number[]}
 */
function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/**
 * @param {string} text
 * @param {number} offset
 * @returns {number} end of the line holding `offset`, before any `\r\n`
 */
function lineEndOf(text, offset) {
  let end = offset;
  while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1;
  return end;
}

/**
 * An offset as an LSP position. LSP counts characters in UTF-16 code units by
 * default, which is what JavaScript string offsets already are.
 * @param {PositionIndex} index
 * @param {number} offset
 * @returns {{ line: number, character: number }}
 */
export function offsetToPosition(index, offset) {
  const starts = index.lineStarts;
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low, character: offset - starts[low] };
}

/**
 * @param {PositionIndex} index
 * @param {{ start: number, end: number }} range
 * @returns {{ start: { line: number, character: number }, end: { line: number, character: number } }}
 */
export function toLspRange(index, range) {
  return { start: offsetToPosition(index, range.start), end: offsetToPosition(index, range.end) };
}

// ---------------------------------------------------------------------------
// Node helpers

/**
 * @param {number} start
 * @param {number} end
 * @returns {PosNode}
 */
function mappingNode(start, end) {
  return { kind: 'mapping', start, end, entries: new Map(), merge: null };
}

/**
 * @param {number} start
 * @param {number} end
 * @returns {PosNode}
 */
function scalarNode(start, end) {
  return { kind: 'scalar', start, end };
}

// ---------------------------------------------------------------------------
// YAML: the js-yaml listener

/**
 * @typedef {{ open: number, close: number, kind: string | null, tag: string | null, result: unknown, children: RawNode[] }} RawNode
 */

/**
 * Rebuild the node tree from js-yaml's open/close events. Every `composeNode`
 * call fires one of each, well nested, with the reader positioned at the node.
 * Keys and values of a mapping are its children in order; items of a sequence
 * likewise. Each pairing is then checked against the value js-yaml itself built
 * ({@link interpretYaml}), so the reconstruction never has to be trusted on the
 * strength of how the loader happens to work.
 * @param {string} text
 * @returns {PosNode | null}
 */
function scanYaml(text) {
  // js-yaml strips a byte-order mark before reading, so every offset it reports
  // is one short of the text the editor holds.
  const base = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  const body = base ? text.slice(1) : text;
  /** @type {RawNode[]} */
  const roots = [];
  /** @type {RawNode[]} */
  const stack = [];
  const docs = yaml.loadAll(body, null, {
    listener(type, state) {
      if (type === 'open') {
        /** @type {RawNode} */
        const node = { open: state.position, close: state.position, kind: null, tag: null, result: null, children: [] };
        (stack.length > 0 ? stack[stack.length - 1].children : roots).push(node);
        stack.push(node);
        return;
      }
      const node = stack.pop();
      if (!node) return;
      node.close = state.position;
      node.kind = state.kind;
      node.tag = state.tag;
      node.result = state.result;
    },
  });
  if (!Array.isArray(docs) || roots.length !== docs.length) return null;

  const present = docs.map((doc, i) => ({ doc, raw: roots[i] })).filter(({ doc }) => doc != null);
  const keys = yamlDocumentKeys(present.map(({ doc }) => doc));
  if (keys === null) return interpretYaml(present[0].raw, body, base);

  // A multi-document file parses to a synthetic mapping keyed by document
  // identity. The identity is not written anywhere, so each document is named
  // by its first line.
  const root = mappingNode(base, text.length);
  present.forEach(({ raw }, i) => {
    const node = interpretYaml(raw, body, base);
    /** @type {Map<string, PosEntry>} */ (root.entries).set(keys[i], {
      keyStart: node.start,
      keyEnd: lineEndOf(text, node.start),
      node,
    });
  });
  return root;
}

/**
 * A node js-yaml composed and then kept as-is: a block-context scalar is first
 * tried as a mapping key, and on finding no `:` the key's own result becomes the
 * node's. That shows as a node whose only child has the very same result.
 * @param {RawNode} raw
 * @returns {RawNode}
 */
function unwrap(raw) {
  let node = raw;
  while (
    node.kind !== 'mapping'
    && node.children.length === 1
    && node.children[0].kind === node.kind
    && Object.is(node.children[0].result, node.result)
  ) {
    node = node.children[0];
  }
  return node;
}

/**
 * A key composition that found nothing — how a block mapping discovers it has
 * ended.
 * @param {RawNode} raw
 * @returns {boolean}
 */
function isEmptyAttempt(raw) {
  return raw.kind === null && (raw.result === null || raw.result === undefined) && raw.open === raw.close;
}

/**
 * @param {RawNode} raw
 * @param {string} body the text js-yaml read
 * @param {number} base offset of `body` within the editor's text
 * @returns {PosNode}
 */
function interpretYaml(raw, body, base) {
  const node = unwrap(raw);
  if (node.kind === null && (node.result === null || node.result === undefined)) {
    // An empty value has no text of its own. Skipping trivia forward would land
    // on whatever the next line holds, so it stays where it was opened.
    let at = node.open;
    while (at < body.length && (body[at] === ' ' || body[at] === '\t')) at += 1;
    return scalarNode(at + base, at + base);
  }
  const start = skipYamlTrivia(body, node.open);
  const end = Math.max(start, trimEnd(body, node.close));
  const opaque = { kind: /** @type {const} */ ('opaque'), start: start + base, end: end + base };

  if (node.kind === 'mapping') {
    const children = [...node.children];
    if (children.length % 2 === 1 && isEmptyAttempt(children[children.length - 1])) children.pop();
    if (!isPlainObject(node.result) || children.length % 2 !== 0) return opaque;
    const out = mappingNode(start + base, end + base);
    for (let i = 0; i < children.length; i += 2) {
      const key = unwrap(children[i]);
      const valueRaw = children[i + 1];
      if (key.kind !== 'scalar' || (key.result !== null && typeof key.result === 'object')) return opaque;
      const keyStart = skipYamlTrivia(body, key.open);
      const keyEnd = Math.max(keyStart, trimEnd(body, key.close));
      const child = interpretYaml(valueRaw, body, base);
      if (key.tag === MERGE_TAG) {
        out.merge = { start: keyStart + base, end: Math.max(keyEnd + base, child.end) };
        continue;
      }
      const name = String(key.result);
      // The pairing is only believed if js-yaml put this very value under this
      // very key.
      if (!Object.hasOwn(node.result, name) || !Object.is(node.result[name], valueRaw.result)) return opaque;
      /** @type {Map<string, PosEntry>} */ (out.entries).set(name, {
        keyStart: keyStart + base,
        keyEnd: keyEnd + base,
        node: child,
      });
    }
    return out;
  }

  if (node.kind === 'sequence') {
    if (!Array.isArray(node.result) || node.result.length !== node.children.length) return opaque;
    /** @type {PosNode[]} */
    const items = [];
    for (let i = 0; i < node.children.length; i++) {
      if (!Object.is(node.result[i], node.children[i].result)) return opaque;
      items.push(interpretYaml(node.children[i], body, base));
    }
    return { kind: 'sequence', start: start + base, end: end + base, items };
  }

  // Scalars, aliases, and empty values: nothing below them is addressable. An
  // alias's contents live at its anchor, which is a different path.
  return scalarNode(start + base, end + base);
}

/**
 * Skip whitespace and comments forward. js-yaml opens a value node before the
 * separation space in front of it.
 * @param {string} text
 * @param {number} from
 * @returns {number}
 */
function skipYamlTrivia(text, from) {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i += 1;
    } else if (c === '#' && (i === 0 || /\s/u.test(text[i - 1]))) {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else {
      break;
    }
  }
  return i;
}

/**
 * @param {string} text
 * @param {number} end
 * @returns {number} `end` moved back over trailing whitespace
 */
function trimEnd(text, end) {
  let i = Math.min(end, text.length);
  while (i > 0 && /\s/u.test(text[i - 1])) i -= 1;
  return i;
}

// ---------------------------------------------------------------------------
// JSON / JSONC

/**
 * Scanned on the comment-blanked text the parser itself reads, which keeps
 * every offset of the original.
 * @param {string} raw
 * @returns {PosNode | null}
 */
function scanJson(raw) {
  const text = stripJsonComments(raw);
  const state = { text, i: 0 };
  skipJsonSpace(state);
  const root = readJsonValue(state);
  skipJsonSpace(state);
  return state.i === text.length ? root : null;
}

/** @param {{ text: string, i: number }} state */
function skipJsonSpace(state) {
  while (state.i < state.text.length && /\s/u.test(state.text[state.i])) state.i += 1;
}

/**
 * @param {{ text: string, i: number }} state
 * @returns {number} the offset just past the closing quote
 */
function readJsonString(state) {
  const { text } = state;
  if (text[state.i] !== '"') throw new Error('expected a string');
  let i = state.i + 1;
  while (i < text.length) {
    if (text[i] === '\\') i += 2;
    else if (text[i] === '"') return (state.i = i + 1);
    else i += 1;
  }
  throw new Error('unterminated string');
}

/**
 * @param {{ text: string, i: number }} state
 * @returns {PosNode}
 */
function readJsonValue(state) {
  skipJsonSpace(state);
  const { text } = state;
  const start = state.i;
  const c = text[start];

  if (c === '{') {
    const node = mappingNode(start, start);
    state.i += 1;
    skipJsonSpace(state);
    if (text[state.i] === '}') {
      state.i += 1;
    } else {
      for (;;) {
        skipJsonSpace(state);
        const keyStart = state.i;
        const keyEnd = readJsonString(state);
        const key = JSON.parse(text.slice(keyStart, keyEnd));
        skipJsonSpace(state);
        if (text[state.i] !== ':') throw new Error('expected :');
        state.i += 1;
        const child = readJsonValue(state);
        // JSON.parse keeps the last of duplicated keys; so does a Map.
        /** @type {Map<string, PosEntry>} */ (node.entries).delete(key);
        /** @type {Map<string, PosEntry>} */ (node.entries).set(key, { keyStart, keyEnd, node: child });
        skipJsonSpace(state);
        if (text[state.i] === ',') { state.i += 1; continue; }
        if (text[state.i] === '}') { state.i += 1; break; }
        throw new Error('expected , or }');
      }
    }
    node.end = state.i;
    return node;
  }

  if (c === '[') {
    /** @type {PosNode[]} */
    const items = [];
    state.i += 1;
    skipJsonSpace(state);
    if (text[state.i] === ']') {
      state.i += 1;
    } else {
      for (;;) {
        items.push(readJsonValue(state));
        skipJsonSpace(state);
        if (text[state.i] === ',') { state.i += 1; continue; }
        if (text[state.i] === ']') { state.i += 1; break; }
        throw new Error('expected , or ]');
      }
    }
    return { kind: 'sequence', start, end: state.i, items };
  }

  if (c === '"') {
    return scalarNode(start, readJsonString(state));
  }

  while (state.i < text.length && !/[\s,\]}]/u.test(text[state.i])) state.i += 1;
  if (state.i === start) throw new Error('expected a value');
  return scalarNode(start, state.i);
}

// ---------------------------------------------------------------------------
// dotenv

/**
 * dotenv's own line pattern (dotenv/lib/main.js), with match indices. Reading
 * keys with the parser's exact pattern is what makes the positions agree with
 * it; verification catches a future dotenv that changes it.
 */
const DOTENV_LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/dgm;

/**
 * @param {string} raw
 * @returns {PosNode}
 */
function scanDotenv(raw) {
  // dotenv normalizes line breaks before matching; map offsets back to the
  // original text, which is what the editor shows.
  const text = raw.replace(/\r\n?/gu, '\n');
  /** @type {number[]} */
  const collapsed = [];
  for (let i = 0, offset = 0; i < raw.length; i++) {
    if (raw[i] === '\r' && raw[i + 1] === '\n') {
      collapsed.push(i - offset);
      offset += 1;
      i += 1;
    }
  }
  const toRaw = (offset) => {
    let low = 0;
    let high = collapsed.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (collapsed[mid] < offset) low = mid + 1;
      else high = mid;
    }
    return offset + low;
  };

  const root = mappingNode(0, raw.length);
  const entries = /** @type {Map<string, PosEntry>} */ (root.entries);
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const match of text.matchAll(DOTENV_LINE)) {
    const key = match[1];
    const [keyStart, keyEnd] = match.indices[1];
    let [valueStart, valueEnd] = match.indices[2] ?? [keyEnd, keyEnd];
    while (valueStart < valueEnd && /\s/u.test(text[valueStart])) valueStart += 1;
    while (valueEnd > valueStart && /\s/u.test(text[valueEnd - 1])) valueEnd -= 1;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    entries.delete(key);
    entries.set(key, {
      keyStart: toRaw(keyStart),
      keyEnd: toRaw(keyEnd),
      node: scalarNode(toRaw(valueStart), toRaw(valueEnd)),
      check: dotenvValue(match[2]),
    });
  }
  // Only a duplicated key needs its value compared: its position depends on
  // which occurrence the parser kept.
  for (const [key, count] of seen) {
    if (count === 1) delete /** @type {PosEntry} */ (entries.get(key)).check;
  }
  return root;
}

/**
 * dotenv's value handling, so a duplicated key's chosen occurrence can be
 * compared with the value it actually parsed to.
 * @param {string | undefined} raw
 * @returns {string}
 */
function dotenvValue(raw) {
  let value = (raw || '').trim();
  const quote = value[0];
  value = value.replace(/^(['"`])([\s\S]*)\1$/gmu, '$2');
  if (quote === '"') value = value.replace(/\\n/gu, '\n').replace(/\\r/gu, '\r');
  return value;
}

// ---------------------------------------------------------------------------
// INI

/**
 * Mirrors `parseIni` line for line: a `[section]` groups the keys under it, a
 * repeated section keeps accumulating, the last of a repeated key wins.
 * @param {string} raw
 * @returns {PosNode}
 */
function scanIni(raw) {
  const root = mappingNode(0, raw.length);
  const rootEntries = /** @type {Map<string, PosEntry>} */ (root.entries);
  let bucket = root;
  const breaks = /\r?\n/gu;
  let lineStart = 0;
  for (;;) {
    const found = breaks.exec(raw);
    const lineEnd = found ? found.index : raw.length;
    const line = raw.slice(lineStart, lineEnd);
    const trimmed = line.trim();
    const trimmedStart = lineStart + (line.length - line.trimStart().length);

    if (trimmed && !trimmed.startsWith(';') && !trimmed.startsWith('#')) {
      const section = /^\[([^\]]+)\]$/u.exec(trimmed);
      if (section) {
        const name = section[1].trim();
        const nameStart = trimmedStart + 1 + (section[1].length - section[1].trimStart().length);
        const existing = rootEntries.get(name);
        if (existing && existing.node.kind === 'mapping' && existing.node !== root) {
          bucket = existing.node;
        } else {
          bucket = mappingNode(trimmedStart, trimmedStart + trimmed.length);
          rootEntries.set(name, { keyStart: nameStart, keyEnd: nameStart + name.length, node: bucket });
        }
      } else {
        const eq = trimmed.indexOf('=');
        if (eq !== -1) {
          const keyRaw = trimmed.slice(0, eq);
          const key = keyRaw.trim();
          const keyStart = trimmedStart + (keyRaw.length - keyRaw.trimStart().length);
          const valueRaw = trimmed.slice(eq + 1);
          const valueStart = trimmedStart + eq + 1 + (valueRaw.length - valueRaw.trimStart().length);
          const valueEnd = trimmedStart + trimmed.length;
          const entries = /** @type {Map<string, PosEntry>} */ (bucket.entries);
          entries.delete(key);
          entries.set(key, { keyStart, keyEnd: keyStart + key.length, node: scalarNode(valueStart, valueEnd) });
        }
      }
    }
    if (!found) break;
    lineStart = found.index + found[0].length;
  }
  return root;
}

// ---------------------------------------------------------------------------
// TOML

/**
 * A structural scanner for TOML: tables, arrays of tables, dotted and quoted
 * keys, inline tables, arrays, and every string form (so a `#` or `[` inside a
 * string is never read as structure). It does not validate TOML — the real
 * parser already did — and anything it models differently fails verification.
 * @param {string} text
 * @returns {PosNode | null}
 */
function scanToml(text) {
  const state = { text, i: text.charCodeAt(0) === 0xFEFF ? 1 : 0 };
  const root = mappingNode(0, text.length);
  let table = root;
  for (;;) {
    skipTomlSpace(state, true);
    if (state.i >= text.length) break;
    if (text[state.i] === '[') {
      const headerStart = state.i;
      const isArray = text[state.i + 1] === '[';
      state.i += isArray ? 2 : 1;
      skipTomlSpace(state, false);
      const keys = readTomlKey(state);
      skipTomlSpace(state, false);
      expectToml(state, isArray ? ']]' : ']');
      table = isArray ? openTomlArrayTable(root, keys, headerStart) : openTomlTable(root, keys);
    } else {
      const keys = readTomlKey(state);
      skipTomlSpace(state, false);
      expectToml(state, '=');
      skipTomlSpace(state, false);
      assignToml(table, keys, readTomlValue(state));
    }
    skipTomlSpace(state, false);
    if (state.i < text.length && text[state.i] !== '\n' && text[state.i] !== '\r') {
      throw new Error('expected end of line');
    }
  }
  return root;
}

/**
 * @param {{ text: string, i: number }} state
 * @param {boolean} newlines whether line breaks count as space here
 */
function skipTomlSpace(state, newlines) {
  const { text } = state;
  while (state.i < text.length) {
    const c = text[state.i];
    if (c === ' ' || c === '\t' || (newlines && (c === '\n' || c === '\r'))) {
      state.i += 1;
    } else if (c === '#') {
      while (state.i < text.length && text[state.i] !== '\n') state.i += 1;
    } else {
      break;
    }
  }
}

/**
 * @param {{ text: string, i: number }} state
 * @param {string} token
 */
function expectToml(state, token) {
  if (!state.text.startsWith(token, state.i)) throw new Error(`expected ${token}`);
  state.i += token.length;
}

/**
 * A dotted key: bare, "basic", or 'literal' segments.
 * @param {{ text: string, i: number }} state
 * @returns {Array<{ key: string, start: number, end: number }>}
 */
function readTomlKey(state) {
  const { text } = state;
  const segments = [];
  for (;;) {
    const start = state.i;
    let key;
    if (text[start] === '"') {
      const end = readTomlBasicString(state);
      key = decodeTomlBasic(text.slice(start + 1, end - 1));
    } else if (text[start] === "'") {
      const close = text.indexOf("'", start + 1);
      if (close === -1 || /[\r\n]/u.test(text.slice(start, close))) throw new Error('unterminated key');
      state.i = close + 1;
      key = text.slice(start + 1, close);
    } else {
      while (state.i < text.length && /[A-Za-z0-9_-]/u.test(text[state.i])) state.i += 1;
      if (state.i === start) throw new Error('expected a key');
      key = text.slice(start, state.i);
    }
    segments.push({ key, start, end: state.i });
    skipTomlSpace(state, false);
    if (text[state.i] !== '.') return segments;
    state.i += 1;
    skipTomlSpace(state, false);
  }
}

/**
 * @param {{ text: string, i: number }} state positioned on the opening quote
 * @returns {number} offset just past the closing quote
 */
function readTomlBasicString(state) {
  const { text } = state;
  let i = state.i + 1;
  while (i < text.length && text[i] !== '\n') {
    if (text[i] === '\\') i += 2;
    else if (text[i] === '"') return (state.i = i + 1);
    else i += 1;
  }
  throw new Error('unterminated string');
}

/**
 * @param {string} inner
 * @returns {string}
 */
function decodeTomlBasic(inner) {
  const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\u001B', '"': '"', '\\': '\\' };
  return inner.replace(/\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|x([0-9A-Fa-f]{2})|(.))/gu, (whole, u4, u8, x2, ch) => {
    const hex = u4 ?? u8 ?? x2;
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return Object.hasOwn(simple, ch) ? simple[ch] : whole;
  });
}

/**
 * @param {{ text: string, i: number }} state
 * @returns {PosNode}
 */
function readTomlValue(state) {
  const { text } = state;
  const start = state.i;

  if (text.startsWith('"""', start) || text.startsWith("'''", start)) {
    const quote = text[start];
    let i = start + 3;
    for (;;) {
      if (i >= text.length) throw new Error('unterminated multi-line string');
      if (quote === '"' && text[i] === '\\') { i += 2; continue; }
      if (text.startsWith(quote.repeat(3), i)) {
        // Up to two quotes may sit against the closing delimiter as content.
        let end = i + 3;
        while (end - i < 5 && text[end] === quote) end += 1;
        state.i = end;
        return scalarNode(start, end);
      }
      i += 1;
    }
  }
  if (text[start] === '"') return scalarNode(start, readTomlBasicString(state));
  if (text[start] === "'") {
    const close = text.indexOf("'", start + 1);
    if (close === -1 || /[\r\n]/u.test(text.slice(start, close))) throw new Error('unterminated string');
    state.i = close + 1;
    return scalarNode(start, state.i);
  }

  if (text[start] === '[') {
    /** @type {PosNode[]} */
    const items = [];
    state.i += 1;
    for (;;) {
      skipTomlSpace(state, true);
      if (text[state.i] === ']') { state.i += 1; break; }
      items.push(readTomlValue(state));
      skipTomlSpace(state, true);
      if (text[state.i] === ',') { state.i += 1; continue; }
      if (text[state.i] === ']') { state.i += 1; break; }
      throw new Error('expected , or ]');
    }
    return { kind: 'sequence', start, end: state.i, items };
  }

  if (text[start] === '{') {
    const node = mappingNode(start, start);
    state.i += 1;
    for (;;) {
      skipTomlSpace(state, true);
      if (text[state.i] === '}') { state.i += 1; break; }
      const keys = readTomlKey(state);
      skipTomlSpace(state, false);
      expectToml(state, '=');
      skipTomlSpace(state, false);
      assignToml(node, keys, readTomlValue(state));
      skipTomlSpace(state, true);
      if (text[state.i] === ',') { state.i += 1; continue; }
      if (text[state.i] === '}') { state.i += 1; break; }
      throw new Error('expected , or }');
    }
    node.end = state.i;
    return node;
  }

  // Numbers, booleans, and dates — a datetime may contain one space.
  while (state.i < text.length && !/[,\]}#\r\n]/u.test(text[state.i])) state.i += 1;
  let end = state.i;
  while (end > start && /[ \t]/u.test(text[end - 1])) end -= 1;
  if (end === start) throw new Error('expected a value');
  state.i = end;
  return scalarNode(start, end);
}

/**
 * The mapping a key segment names under `parent`, created on first mention. A
 * path through an array of tables continues in its latest element, as TOML
 * specifies.
 * @param {PosNode} parent
 * @param {{ key: string, start: number, end: number }} segment
 * @returns {PosNode}
 */
function tomlChild(parent, segment) {
  const entries = /** @type {Map<string, PosEntry>} */ (parent.entries);
  let entry = entries.get(segment.key);
  if (!entry) {
    entry = { keyStart: segment.start, keyEnd: segment.end, node: mappingNode(segment.start, segment.end) };
    entries.set(segment.key, entry);
  }
  const node = entry.node.kind === 'sequence'
    ? /** @type {PosNode[]} */ (entry.node.items)[/** @type {PosNode[]} */ (entry.node.items).length - 1]
    : entry.node;
  if (!node || node.kind !== 'mapping') throw new Error('not a table');
  return node;
}

/**
 * @param {PosNode} root
 * @param {Array<{ key: string, start: number, end: number }>} keys
 * @returns {PosNode}
 */
function openTomlTable(root, keys) {
  let table = root;
  for (const segment of keys) table = tomlChild(table, segment);
  return table;
}

/**
 * @param {PosNode} root
 * @param {Array<{ key: string, start: number, end: number }>} keys
 * @param {number} headerStart
 * @returns {PosNode} the new element, which is the table keys now go into
 */
function openTomlArrayTable(root, keys, headerStart) {
  const parent = openTomlTable(root, keys.slice(0, -1));
  const last = keys[keys.length - 1];
  const entries = /** @type {Map<string, PosEntry>} */ (parent.entries);
  let entry = entries.get(last.key);
  if (!entry) {
    entry = { keyStart: last.start, keyEnd: last.end, node: { kind: 'sequence', start: headerStart, end: headerStart, items: [] } };
    entries.set(last.key, entry);
  }
  if (entry.node.kind !== 'sequence') throw new Error('not an array of tables');
  const element = mappingNode(headerStart, headerStart);
  /** @type {PosNode[]} */ (entry.node.items).push(element);
  return element;
}

/**
 * @param {PosNode} table
 * @param {Array<{ key: string, start: number, end: number }>} keys
 * @param {PosNode} value
 */
function assignToml(table, keys, value) {
  const parent = openTomlTable(table, keys.slice(0, -1));
  const last = keys[keys.length - 1];
  /** @type {Map<string, PosEntry>} */ (parent.entries).set(last.key, { keyStart: last.start, keyEnd: last.end, node: value });
}
