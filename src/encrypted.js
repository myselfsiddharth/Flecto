/**
 * Structural awareness of SOPS- and age-encrypted files.
 *
 * Flecto **never decrypts**. It never shells out to `sops` or `age`, never
 * reads a key file, never touches an agent socket, and never sends ciphertext
 * anywhere. That is the whole security proposition: pointing Flecto at an
 * encrypted file must be exactly as safe as pointing `git diff` at it, minus
 * the ciphertext noise.
 *
 * What it does instead is treat the *shape* of the file as the signal. An
 * encrypted config still tells you a great deal without being opened:
 *
 *   - which keys exist (added / removed / moved)
 *   - which encrypted values changed, and which did not
 *   - who can decrypt it — the recipient list in the `sops` metadata block
 *   - whether the file is still encrypted at all
 *
 * The mechanism is a normalization pass applied at parse time, before any
 * other part of Flecto sees the tree. Every ciphertext-bearing string is
 * replaced with an opaque sentinel, `<encrypted:SCHEME:DIGEST>`, where DIGEST
 * is a truncated SHA-256 of the ciphertext. Because the substitution happens in
 * the parser, ciphertext cannot reach a diff, a snapshot file, a webhook body,
 * a PR comment, or an HTML report — there is no code path that carries it. The
 * digest is what makes "this encrypted value changed" observable without
 * revealing the value or even its length.
 *
 * Detection is content-based. Filenames are a hint at best: teams commit
 * `secrets.yaml`, `values.prod.yaml`, and `db.json` that are fully encrypted,
 * and `.sops.yaml` — which is the *creation-rules config*, not an encrypted
 * file at all.
 */

import { createHash } from 'crypto';

/**
 * @typedef {'sops' | 'age' | 'pgp'} EncryptionScheme
 * @typedef {EncryptionScheme | 'plaintext'} EncryptionState
 */

/** Synthetic diff path carrying the file-level encryption state. */
export const ENCRYPTION_STATE_PATH = '<encryption>';

/** Synthetic diff path for the "MAC moved on its own" integrity signal. */
export const ENCRYPTION_MAC_PATH = '<encryption.mac>';

/** What an encrypted value collapses to in human-facing output. */
export const ENCRYPTED_DISPLAY = '<encrypted value>';

/** What a value that used to be encrypted collapses to once it is not. */
export const DECRYPTED_DISPLAY = '<no longer encrypted>';

/** Long enough that two versions of one value practically never collide. */
const DIGEST_CHARS = 12;

/**
 * A SOPS-encrypted leaf, e.g.
 * `ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]`. The cipher name and the
 * `data:` field are both required, which is specific enough that a hand-written
 * config value has essentially no chance of matching.
 */
const SOPS_ENC_TOKEN_RE = /^ENC\[[A-Z0-9_]+,data:[^\]]*\]$/;

/** Armored age blob — a whole file, or a wrapped data key inside `sops.age`. */
const AGE_ARMOR_HEADER = '-----BEGIN AGE ENCRYPTED FILE-----';

/** Armored PGP blob — the wrapped data key inside `sops.pgp`. */
const PGP_MESSAGE_HEADER = '-----BEGIN PGP MESSAGE-----';

/** Matches exactly what `sentinel()` produces, and nothing else. */
const SENTINEL_RE = /^<encrypted:(sops|age|pgp):[0-9a-f]{12}>$/;

/** Key-provider groups SOPS writes into its metadata block, in its own order. */
const RECIPIENT_GROUPS = ['kms', 'gcp_kms', 'azure_kv', 'hc_vault', 'age', 'pgp'];

/**
 * The fields that identify a recipient within its group. Every one of these is
 * a public identifier — a key ARN, an age public key, a PGP fingerprint — so
 * they stay visible in the diff. They are the answer to "who can read this?",
 * which is the single most useful thing an encrypted file can tell you.
 * @type {Record<string, string[]>}
 */
const RECIPIENT_ID_FIELDS = {
  kms: ['arn'],
  gcp_kms: ['resource_id'],
  azure_kv: ['vault_url', 'name', 'version'],
  hc_vault: ['vault_address', 'engine_path', 'key_name'],
  age: ['recipient'],
  pgp: ['fp'],
};

/**
 * Paths whose change means "the SOPS MAC moved", relative to the document that
 * owns the metadata block — the file root for an ordinary file, one document
 * down for a multi-document one.
 */
const MAC_PATHS = new Set(['sops.mac', 'sops_mac']);

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
 * Build the opaque stand-in for one ciphertext.
 * @param {EncryptionScheme} scheme
 * @param {string} ciphertext
 * @returns {string}
 */
function sentinel(scheme, ciphertext) {
  const digest = createHash('sha256').update(String(ciphertext), 'utf8').digest('hex');
  return `<encrypted:${scheme}:${digest.slice(0, DIGEST_CHARS)}>`;
}

/**
 * True when a value is one of Flecto's encrypted-value sentinels.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isEncryptedSentinel(value) {
  return typeof value === 'string' && SENTINEL_RE.test(value);
}

/**
 * The scheme recorded in a sentinel, or null when the value is not one.
 * @param {unknown} value
 * @returns {EncryptionScheme | null}
 */
export function sentinelScheme(value) {
  if (typeof value !== 'string') return null;
  const match = SENTINEL_RE.exec(value);
  return match ? /** @type {EncryptionScheme} */ (match[1]) : null;
}

/**
 * Classify a raw string as ciphertext, without decrypting it.
 * @param {unknown} value
 * @returns {EncryptionScheme | null}
 */
export function encryptedValueScheme(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (SOPS_ENC_TOKEN_RE.test(trimmed)) return 'sops';
  if (trimmed.includes(AGE_ARMOR_HEADER)) return 'age';
  if (trimmed.includes(PGP_MESSAGE_HEADER)) return 'pgp';
  return null;
}

/**
 * True when the whole file is one armored age blob rather than a config
 * document. Such a file is not YAML or JSON in any useful sense, so the parser
 * short-circuits it rather than letting js-yaml guess at the armor.
 * @param {string} raw
 * @returns {boolean}
 */
export function isArmoredAgeFile(raw) {
  return String(raw).trimStart().startsWith(AGE_ARMOR_HEADER);
}

/**
 * The parsed form of a file that is nothing but ciphertext: a single sentinel.
 * Diffing two versions reports that the blob changed, and nothing else — which
 * is genuinely all an opaque file can tell you.
 * @param {string} raw
 * @returns {string}
 */
export function opaqueFileState(raw) {
  return sentinel('age', String(raw).trim());
}

/**
 * True when a `sops:` value is really a SOPS metadata block.
 *
 * SOPS always writes `version` plus a MAC, a modification stamp, and at least
 * one key group. Requiring `version` *and two of the other three* is what keeps
 * an ordinary config that happens to pin `sops: { version: "3.9.0" }` from
 * being mistaken for an encrypted file. Both the on-disk array shape and the
 * normalized keyed-object shape are accepted, so this holds for a tree read
 * back out of a snapshot too.
 * @param {unknown} block
 * @returns {boolean}
 */
export function looksLikeSopsMetadata(block) {
  if (!isPlainObject(block)) return false;
  if (typeof block.version !== 'string' && typeof block.version !== 'number') return false;

  let signals = 0;
  if (typeof block.mac === 'string' && block.mac.trim()) signals += 1;
  if (typeof block.lastmodified === 'string' && block.lastmodified.trim()) signals += 1;
  if (RECIPIENT_GROUPS.some((group) => hasRecipientEntries(block[group]))) signals += 1;
  return signals >= 2;
}

/**
 * @param {unknown} group
 * @returns {boolean}
 */
function hasRecipientEntries(group) {
  if (Array.isArray(group)) return group.some(isPlainObject);
  if (isPlainObject(group)) return Object.values(group).some(isPlainObject);
  return false;
}

/**
 * SOPS's flat-format metadata, used for dotenv and INI files, where the block
 * is spelled as `sops_version` / `sops_mac` / `sops_lastmodified` top-level
 * keys instead of a nested map.
 * @param {Record<string, unknown>} tree
 * @returns {boolean}
 */
function hasFlatSopsMetadata(tree) {
  if (typeof tree.sops_version !== 'string' || !tree.sops_version.trim()) return false;
  return typeof tree.sops_mac === 'string' || typeof tree.sops_lastmodified === 'string';
}

/**
 * Top-level keys whose value carries a SOPS metadata block of its own.
 *
 * This is what a multi-document file looks like once `parseYamlStream` has
 * wrapped its documents: the `sops` block of each `kind: Secret` sits one level
 * down, under the document's identity key. Detection is by content —
 * {@link looksLikeSopsMetadata}, which wants a version plus two more signals —
 * and never by the shape of the key, so a config whose top-level keys happen to
 * read like `Kind/ns/name` is not affected unless it genuinely contains a SOPS
 * metadata block, in which case calling it encrypted is the right answer.
 *
 * Content rather than the parser's own multi-document signal, because this runs
 * at diff time on trees that may have been read back out of a JSON snapshot,
 * where no in-memory signal can have survived. Both sides of every diff are
 * therefore judged by the same rule, which is what keeps a snapshot baseline
 * from disagreeing with a freshly parsed file about whether a file is
 * encrypted.
 * @param {unknown} tree
 * @returns {string[]}
 */
function sopsDocumentKeys(tree) {
  if (!isPlainObject(tree)) return [];
  const keys = [];
  for (const [key, doc] of Object.entries(tree)) {
    if (isPlainObject(doc) && looksLikeSopsMetadata(doc.sops)) keys.push(key);
  }
  return keys;
}

/**
 * The encryption state of an already-normalized tree.
 *
 * Cheap by construction: the root checks are O(1) and the per-document scan is
 * one property read per top-level key, each of which bails out immediately
 * unless that key holds a genuine SOPS metadata block. Every diff runs this on
 * both sides, and an ordinary config must not pay for a feature it does not use.
 *
 * A multi-document file counts as encrypted when *any* of its documents is —
 * the same reading as the single-document case, where one `sops` block makes
 * the file encrypted. Losing it everywhere is what raises `<encryption>`.
 * @param {unknown} tree
 * @returns {EncryptionState}
 */
export function encryptionState(tree) {
  if (typeof tree === 'string') return sentinelScheme(tree) ?? 'plaintext';
  if (!isPlainObject(tree)) return 'plaintext';
  if (looksLikeSopsMetadata(tree.sops)) return 'sops';
  if (hasFlatSopsMetadata(tree)) return 'sops';
  return sopsDocumentKeys(tree).length > 0 ? 'sops' : 'plaintext';
}

/**
 * Recursively map a tree, returning the *original reference* when nothing
 * changed. That identity is load-bearing: it is how an unencrypted file proves
 * it came out of the encryption pass untouched.
 * @param {unknown} value
 * @param {(leaf: string) => string} mapString
 * @returns {unknown}
 */
function mapStrings(value, mapString) {
  if (typeof value === 'string') return mapString(value);

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = mapStrings(item, mapString);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }

  if (isPlainObject(value)) {
    let changed = false;
    // Rebuilt with fromEntries, not `out[key] = next`: a key literally named
    // "__proto__" would run the prototype setter and drop the subtree.
    const entries = Object.entries(value).map(([key, item]) => {
      const next = mapStrings(item, mapString);
      if (next !== item) changed = true;
      return [key, next];
    });
    return changed ? Object.fromEntries(entries) : value;
  }

  return value;
}

/**
 * Replace every ciphertext-bearing string in a tree with its sentinel.
 * @param {unknown} tree
 * @returns {unknown}
 */
function redactCiphertext(tree) {
  return mapStrings(tree, (leaf) => {
    const scheme = encryptedValueScheme(leaf);
    return scheme ? sentinel(scheme, leaf) : leaf;
  });
}

/**
 * The stable identity of one recipient entry, built from its public fields.
 * @param {string} group
 * @param {Record<string, unknown>} entry
 * @returns {string | null}
 */
function recipientIdentity(group, entry) {
  const parts = [];
  for (const field of RECIPIENT_ID_FIELDS[group] ?? []) {
    const value = entry[field];
    if (value == null || typeof value === 'object') continue;
    const text = String(value).trim();
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join('|') : null;
}

/**
 * Redact the wrapped data key on a recipient entry. `enc` is the data key
 * sealed to that recipient — ciphertext, and useless to a reader — while every
 * other field on the entry identifies *who* the recipient is and stays.
 * @param {string} group
 * @param {Record<string, unknown>} entry
 * @returns {Record<string, unknown>}
 */
function redactRecipientEntry(group, entry) {
  const enc = entry.enc;
  if (typeof enc !== 'string' || !enc.trim() || isEncryptedSentinel(enc)) return entry;
  const scheme = group === 'age' || group === 'pgp' ? group : 'sops';
  return { ...entry, enc: sentinel(/** @type {EncryptionScheme} */ (scheme), enc) };
}

/**
 * Re-key a recipient array by recipient identity.
 *
 * On disk these are arrays, so index diffing would report a recipient inserted
 * at the front as "every recipient changed" — the opposite of the truth, and
 * exactly the case where a reviewer must not be misled. Recipient order carries
 * no meaning, so keying by identity turns the real event into a single `added`
 * or `removed` at a path that names the key involved.
 *
 * All-or-nothing: if any entry lacks an identity or two share one, the array
 * shape is kept so the diff stays faithful to the file.
 * @param {string} group
 * @param {unknown} value
 * @returns {unknown}
 */
function normalizeRecipientGroup(group, value) {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isPlainObject)) return value;

  const redacted = value.map((entry) => redactRecipientEntry(group, entry));
  const identities = value.map((entry) => recipientIdentity(group, entry));
  const usable = identities.every((id) => id != null && id !== '__proto__')
    && new Set(identities).size === identities.length;

  if (!usable) {
    return redacted.some((entry, index) => entry !== value[index]) ? redacted : value;
  }
  return Object.fromEntries(identities.map((id, index) => [id, redacted[index]]));
}

/**
 * Normalize the recipient groups inside a SOPS metadata block.
 * @param {Record<string, unknown>} block
 * @returns {Record<string, unknown>}
 */
function normalizeSopsBlock(block) {
  let changed = false;
  const entries = Object.entries(block).map(([key, value]) => {
    const next = RECIPIENT_GROUPS.includes(key) ? normalizeRecipientGroup(key, value) : value;
    if (next !== value) changed = true;
    return [key, next];
  });
  return changed ? Object.fromEntries(entries) : block;
}

/**
 * Replace `owner.sops` with its recipient-normalized form, or return `owner`
 * itself when nothing needed re-keying.
 * @param {Record<string, unknown>} owner
 * @returns {Record<string, unknown>}
 */
function normalizeSopsOwner(owner) {
  if (!looksLikeSopsMetadata(owner.sops)) return owner;
  const sops = normalizeSopsBlock(/** @type {Record<string, unknown>} */ (owner.sops));
  // Spreading first keeps `sops` in its original position among the keys.
  return sops === owner.sops ? owner : { ...owner, sops };
}

/**
 * The parser's entry point: make a freshly parsed tree safe to carry.
 *
 * Returns the argument itself when the file holds no ciphertext, so an ordinary
 * config is not merely equal to what it used to be — it is the same object.
 *
 * `documentKeys` are the synthetic keys `parseYamlStream` invented for a
 * multi-document file. They are threaded in rather than rediscovered because
 * this pass *rewrites diff paths* — it re-keys recipient arrays by identity —
 * and that must happen for a document the parser really produced and nowhere
 * else. A single-document config that merely embeds something SOPS-shaped keeps
 * the paths it has always had.
 * @param {unknown} tree
 * @param {readonly string[]} [documentKeys]
 * @returns {unknown}
 */
export function normalizeEncrypted(tree, documentKeys = []) {
  const redacted = redactCiphertext(tree);
  if (!isPlainObject(redacted)) return redacted;

  let out = normalizeSopsOwner(redacted);
  for (const key of documentKeys) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) continue;
    const doc = out[key];
    if (!isPlainObject(doc)) continue;
    const normalized = normalizeSopsOwner(doc);
    if (normalized === doc) continue;
    if (out === redacted) out = { ...redacted };
    Object.defineProperty(out, key, {
      value: normalized,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * Collapse sentinels to human-readable text for display. Used by the terminal
 * renderer; machine-readable outputs keep the sentinel, which is stable across
 * runs and therefore useful to correlate.
 * @param {unknown} value
 * @returns {unknown}
 */
export function displayEncrypted(value) {
  return mapStrings(value, (leaf) => (isEncryptedSentinel(leaf) ? ENCRYPTED_DISPLAY : leaf));
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isSopsMetadataPath(path) {
  return path === 'sops'
    || path.startsWith('sops.')
    || path.startsWith('sops[')
    || path.startsWith('sops_');
}

/**
 * The metadata-relative form of a diff path: the path as the document that owns
 * the `sops` block sees it. `sops.mac` for an ordinary file,
 * `ConfigMap/prod/billing.sops.mac` → `sops.mac` for a multi-document one.
 *
 * `prefixes` are the top-level keys that carry their own metadata block, so a
 * document without one never has its paths rewritten.
 * @param {string} path
 * @param {string[]} prefixes
 * @returns {string}
 */
function metadataRelativePath(path, prefixes) {
  for (const prefix of prefixes) {
    if (path.startsWith(prefix) && path[prefix.length] === '.') {
      return path.slice(prefix.length + 1);
    }
  }
  return path;
}

/**
 * @param {EncryptionState} before
 * @param {EncryptionState} after
 * @returns {string}
 */
function stateNote(before, after) {
  if (after === 'plaintext') return 'file is no longer encrypted';
  if (before === 'plaintext') return 'file is now encrypted';
  return 'encryption scheme changed';
}

/**
 * Add the change events that only exist for an encrypted file, and strip a
 * value that stopped being encrypted.
 *
 * Called by `diffTrees` for every diff. When neither side is encrypted it
 * returns the exact array it was given, so an ordinary config sees no new
 * events, no copied objects, and no measurable cost. "Encrypted" here covers a
 * multi-document file in which any single document is — otherwise a `kind:
 * Secret` shipped alongside a plain ConfigMap would lose every protection
 * below.
 *
 * Three things are derived that a key-by-key walk cannot express on its own:
 *
 *   1. `<encryption>` — the file gained or lost encryption. Losing it means
 *      plaintext secrets were committed, which is why the `sops` pack raises it
 *      as an error rather than a note.
 *   2. `<encryption.mac>` — the SOPS MAC moved while every value it covers,
 *      encrypted or not, stayed put. Normal edits move both together, so this
 *      combination is a hand-edited or tampered metadata block.
 *   3. A value that was ciphertext and is now a plain scalar is replaced with
 *      a marker. The point of the diff is that the value was exposed; printing
 *      it into a CI log would expose it again, to a wider audience.
 *
 * @param {unknown} before
 * @param {unknown} after
 * @param {import('./differ.js').ChangeEvent[]} events
 * @returns {import('./differ.js').ChangeEvent[]}
 */
export function annotateEncryptedChanges(before, after, events) {
  const beforeState = encryptionState(before);
  const afterState = encryptionState(after);
  if (beforeState === 'plaintext' && afterState === 'plaintext') return events;

  const out = events.map((event) => {
    if (
      event.type === 'changed'
      && isEncryptedSentinel(event.before)
      && !isEncryptedSentinel(event.after)
      && (event.after == null || typeof event.after !== 'object')
    ) {
      return { ...event, after: DECRYPTED_DISPLAY, note: 'value is no longer encrypted' };
    }
    return event;
  });

  if (beforeState !== afterState) {
    out.unshift({
      type: 'changed',
      path: ENCRYPTION_STATE_PATH,
      before: beforeState,
      after: afterState,
      note: stateNote(beforeState, afterState),
    });
  }

  if (beforeState !== 'plaintext' && afterState !== 'plaintext') {
    // In a multi-document file the metadata blocks live under the document
    // keys, so read every path relative to whichever document owns one.
    const prefixes = [...new Set([...sopsDocumentKeys(before), ...sopsDocumentKeys(after)])];
    const relative = (path) => metadataRelativePath(path, prefixes);
    const macChanged = events.some(
      (event) => event.type === 'changed' && MAC_PATHS.has(relative(event.path)),
    );
    const payloadChanged = events.some((event) => !isSopsMetadataPath(relative(event.path)));
    if (macChanged && !payloadChanged) {
      out.push({
        type: 'changed',
        path: ENCRYPTION_MAC_PATH,
        before: 'consistent',
        after: 'mac-only',
        note: 'MAC changed but no value did',
      });
    }
  }

  return out;
}
