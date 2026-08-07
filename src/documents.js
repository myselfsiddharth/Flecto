/**
 * Carrying the "this tree is a multi-document wrapper" signal.
 *
 * A `---`-separated YAML file parses to a synthetic object keyed by document
 * identity (see `parseYamlStream`), so every path inside a document gains a
 * `Kind/namespace/name` prefix. Several subsystems need to know which leading
 * path segments are those synthetic keys rather than real configuration keys —
 * most importantly secret-name matching, which must never look at a resource
 * name, because a resource *named* `token-service` is not a secret.
 *
 * The parser is the only thing that can answer this without guessing: it
 * invented the keys. Rather than re-deriving them downstream from the shape of
 * the keys — a heuristic that misfires the first time somebody writes a config
 * whose top-level keys genuinely look like `Kind/ns/name` — the parser records
 * them here and everything else reads them back.
 *
 * The record is a non-enumerable symbol property, so it is invisible to
 * `Object.keys`, `JSON.stringify`, spread, and `assert.deepEqual`: a marked tree
 * is byte-for-byte the same snapshot, diff, and payload it was before. The flip
 * side is that it does not survive a JSON round trip, so a tree read back out of
 * a snapshot file carries the keys only if the snapshot recorded them.
 * `documentKeysOf` distinguishes the two: `[]` means "known not to be a
 * wrapper", `null` means "provenance unknown".
 */

/** Where the synthetic document keys are recorded on a parsed tree. */
const DOCUMENT_KEYS = Symbol.for('flecto.documentKeys');

/** @type {readonly string[]} */
const NONE = Object.freeze([]);

/**
 * Record the synthetic document keys the parser invented for a tree.
 *
 * Returns the tree itself — marking is a side effect on an object Flecto just
 * created, never a copy. Non-object roots (a scalar YAML document, an opaque
 * age blob) cannot carry the mark and are returned unchanged.
 * @template T
 * @param {T} tree
 * @param {readonly string[] | null | undefined} keys
 * @returns {T}
 */
export function withDocumentKeys(tree, keys) {
  if (tree === null || typeof tree !== 'object') return tree;
  Object.defineProperty(tree, DOCUMENT_KEYS, {
    value: keys == null ? null : Object.freeze([...keys]),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return tree;
}

/**
 * The synthetic document keys recorded on a tree.
 * @param {unknown} tree
 * @returns {readonly string[] | null} `[]` when the tree is known to be a single
 *   document, `null` when nothing recorded its provenance
 */
export function documentKeysOf(tree) {
  if (tree === null || typeof tree !== 'object') return null;
  const keys = /** @type {Record<string | symbol, unknown>} */ (tree)[DOCUMENT_KEYS];
  return Array.isArray(keys) ? /** @type {readonly string[]} */ (keys) : null;
}

/**
 * The document keys covering either side of a diff, longest first.
 *
 * A document present on only one side still prefixes the paths of its own
 * additions or removals, so the union is what a path can start with. Longest
 * first so that if one identity is a prefix of another — `app` and `app.web` —
 * a path is attributed to the more specific one.
 * @param {unknown} before
 * @param {unknown} after
 * @returns {readonly string[]}
 */
export function diffDocumentKeys(before, after) {
  const merged = [...(documentKeysOf(before) ?? NONE), ...(documentKeysOf(after) ?? NONE)];
  if (merged.length === 0) return NONE;
  return [...new Set(merged)].sort((a, b) => b.length - a.length);
}

/**
 * Drop a leading document-identity segment from a diff path.
 *
 * Matching is by whole segment against the keys the parser actually invented,
 * not by pattern, so `Deployment/prod/token-service.spec.replicas` becomes
 * `spec.replicas` while an ordinary key that merely begins with the same text
 * is left alone. Returns the path unchanged when no key applies, which is the
 * single-document case and therefore the common one.
 * @param {string} path
 * @param {readonly string[] | null | undefined} keys tried in order; see
 *   {@link diffDocumentKeys} for why callers pass them longest first
 * @returns {string}
 */
export function stripDocumentPrefix(path, keys) {
  if (!keys || keys.length === 0 || !path) return path;
  for (const key of keys) {
    if (!key || !path.startsWith(key)) continue;
    if (path.length === key.length) return '';
    const next = path[key.length];
    if (next === '.') return path.slice(key.length + 1);
    if (next === '[') return path.slice(key.length);
  }
  return path;
}
