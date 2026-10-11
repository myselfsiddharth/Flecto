import { Buffer } from 'buffer';

/**
 * Value-based secret detection.
 *
 * Key-name detection (see SECRET_PATH_RE in renderer.js and the
 * secret-key-changed rule in packs/default.json) misses a credential stored
 * under a boring key such as `db.connstr`. This module inspects the *value*
 * instead, and is shared by the masking path and the policy engine so
 * detection and redaction never drift apart.
 *
 * Two detectors run, in order:
 *
 *   1. Known token formats (below). High confidence, cheap, no false
 *      positives in practice — these prefixes are vendor-assigned.
 *   2. A high-entropy fallback for opaque strings with no recognizable
 *      prefix. Deliberately conservative: masking a real hostname in
 *      someone's terminal is worse than missing an unusual secret, so the
 *      gates below reject anything that could plausibly be a hostname, URL,
 *      path, UUID, digest, or version string.
 */

/**
 * @typedef {'aws-access-key-id'
 *   | 'github-token'
 *   | 'slack-token'
 *   | 'google-api-key'
 *   | 'stripe-secret-key'
 *   | 'jwt'
 *   | 'private-key-block'
 *   | 'url-credentials'
 *   | 'high-entropy'} SecretKind
 *
 * @typedef {{ kind: SecretKind, start: number, end: number }} SecretMatch
 */

const REDACTED = '***';

/**
 * Vendor token formats. Each pattern is global so a value can carry more than
 * one secret (a connection string, a shell snippet), and the prefixed ones are
 * anchored on a word boundary so they do not fire mid-word.
 * Stripe test keys (sk_test_) are intentionally excluded — they are not
 * credentials worth redacting and appear in documentation constantly.
 * @type {Array<{ kind: SecretKind, re: RegExp }>}
 */
const KNOWN_FORMATS = [
  // AWS access key ids: AKIA (long-lived) / ASIA (STS session), then 16 chars.
  { kind: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // GitHub PATs, OAuth, user-to-server, server-to-server, refresh, fine-grained.
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  // Slack bot/user/app/refresh/legacy tokens.
  { kind: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  // Google API keys: fixed "AIza" prefix, 35 further base64url chars.
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Stripe live secret / restricted keys.
  { kind: 'stripe-secret-key', re: /\b[sr]k_live_[0-9A-Za-z]{16,}\b/g },
  // JWT: base64url header starting with "eyJ" ('{"'), payload, signature.
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
];

// PEM/PGP private-key block markers, matched linearly. A single regex spanning
// BEGIN…END with `[\s\S]*?…$` backtracks quadratically on a long BEGIN-prefixed
// value with no END — a denial-of-service vector, since secret detection runs
// on every changed string value. Instead we find the markers with anchored,
// non-spanning regexes and pair them by position (see findPrivateKeyBlocks).
const PRIVATE_KEY_BEGIN_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g;
const PRIVATE_KEY_END_RE = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g;

// Credentials embedded in a URL authority: scheme://user:PASSWORD@host. The
// scheme run is length-bounded ({0,32}); an unbounded `*` before the required
// `://` backtracks quadratically on a long value that never contains `://`. No
// real URL scheme approaches 32 characters, so the bound changes nothing that
// matters and removes the ReDoS.
const URL_CREDENTIALS_RE = /[a-z][a-z0-9+.-]{0,32}:\/\/[^\s/:@]+:([^\s/@]+)@/gi;

/**
 * Values that only *reference* a secret. Redacting these adds noise and, worse,
 * would make the policy rule fire on configs that correctly keep secrets out of
 * the file.
 *
 * `$(NAME)` is Kubernetes' env-var expansion in a container's env and args, and
 * `{{ ... }}` a Helm or Jinja template expression: in a connection string such
 * as `postgres://app:$(DB_PASSWORD)@db/app` both are the reference, not the
 * credential.
 */
const PLACEHOLDER_RE = /^(?:\$\{[^}]*\}|\$\([A-Za-z_][A-Za-z0-9_]*\)|\{\{[^}]*\}\}|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z0-9_]+%|<[^>]*>|\*+)$/;

/**
 * High-entropy fallback gates. Every one of these must pass:
 *
 *   length      >= 24 characters. Shorter opaque strings (short ids, hashes of
 *               truncated length, base36 counters) are too common in configs.
 *   charset     only [A-Za-z0-9+=_-]. Notably excludes "." "/" ":" and
 *               whitespace, so hostnames, URLs, filesystem paths, dotted
 *               version strings, ARNs, and image refs can never be candidates.
 *               The cost is missing standard-base64 secrets that happen to
 *               contain "/" — an acceptable trade for the false-positive floor.
 *   classes     at least one lowercase, one uppercase, and one digit. This
 *               alone rejects git SHAs and other lowercase hex, uppercase
 *               base32/TOTP seeds, kebab-case names, and ISO-8601 stamps.
 *   case mix    25%–85% of the letters are uppercase. Random base64/base62 key
 *               material sits near 50%; word-shaped identifiers such as
 *               `CustomerSuccessDashboard2026` or `AcmeVpnGateway01Prod` sit
 *               near 12% and are the main residual false-positive class once
 *               the charset gate has removed paths and hostnames.
 *   word runs   no run of 8 or more consecutive same-case letters. Words are
 *               long same-case runs; random tokens change case roughly every
 *               other character. This catches mixed shapes the case-mix gate
 *               lets through, such as `PRODUCTION_us_east_1_Config2024`.
 *   entropy     Shannon entropy over the string's own characters >= 4.0
 *               bits/char. A 24-char base64 secret lands around 4.3; English-ish
 *               identifiers of the same length land well below 4.0.
 *
 * Plus explicit rejections for benign shapes that can clear all five: UUIDs,
 * subresource-integrity strings (sha512-…), and base64 of ordinary ASCII text.
 *
 * Measured on a corpus of 3,000 random base64url/base62 tokens (lengths 24–64)
 * and a hand-built corpus of benign config values: 0 false positives on that
 * corpus; ~5% of random tokens missed (worst at length 24, ~7%). Other
 * corpora can still yield false positives when a value is an opaque public
 * identifier structurally indistinguishable from secret material — e.g. Google
 * Place IDs (ChIJN1t_tDeuEmsRUsoyG83frY4) and IPFS CIDv0 hashes
 * (QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG). Standard-base64 secrets
 * that contain "/" are always missed by this fallback by construction — the
 * known formats above are what covers those.
 */
const ENTROPY_MIN_LENGTH = 24;
const ENTROPY_MIN_BITS = 4.0;
const ENTROPY_MIN_UPPER_RATIO = 0.25;
const ENTROPY_MAX_UPPER_RATIO = 0.85;
const ENTROPY_MAX_SAME_CASE_RUN = 8;
const ENTROPY_CHARSET_RE = /^[A-Za-z0-9+=_-]+$/;
const UUID_RE = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;
const INTEGRITY_PREFIX_RE = /^(?:sha1|sha256|sha384|sha512|md5)-/i;
const PRINTABLE_DECODE_RATIO = 0.9;

/**
 * Shannon entropy of a string in bits per character.
 * @param {string} value
 * @returns {number}
 */
function shannonEntropy(value) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * True when a base64-ish string decodes to ordinary printable text, e.g. an
 * encoded config blob or a base64'd sentence. Random key material decodes to
 * bytes that are printable only ~37% of the time, so this separates the two
 * cleanly.
 * @param {string} value
 * @returns {boolean}
 */
function decodesToPrintableText(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.length < 8) return false;
  let printable = 0;
  for (const byte of decoded) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e)) printable += 1;
  }
  return printable / decoded.length >= PRINTABLE_DECODE_RATIO;
}

/**
 * Fraction of the letters in a string that are uppercase. Word-shaped
 * identifiers cluster low, random key material clusters near one half.
 * @param {string} value
 * @returns {number}
 */
function uppercaseRatio(value) {
  const letters = value.match(/[A-Za-z]/g)?.length ?? 0;
  if (letters === 0) return 0;
  return (value.match(/[A-Z]/g)?.length ?? 0) / letters;
}

/**
 * Length of the longest run of consecutive same-case letters. Words produce
 * long runs; random tokens flip case every couple of characters.
 * @param {string} value
 * @returns {number}
 */
function maxSameCaseRun(value) {
  let longest = 0;
  let run = 0;
  let previous = null;
  for (const char of value) {
    const kind = /[a-z]/.test(char) ? 'lower' : /[A-Z]/.test(char) ? 'upper' : null;
    run = kind && kind === previous ? run + 1 : (kind ? 1 : 0);
    previous = kind;
    if (run > longest) longest = run;
  }
  return longest;
}

/**
 * The high-entropy fallback. See the gate documentation above.
 * @param {string} value
 * @returns {boolean}
 */
function isHighEntropySecret(value) {
  if (value.length < ENTROPY_MIN_LENGTH) return false;
  if (!ENTROPY_CHARSET_RE.test(value)) return false;
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) return false;
  const upper = uppercaseRatio(value);
  if (upper < ENTROPY_MIN_UPPER_RATIO || upper > ENTROPY_MAX_UPPER_RATIO) return false;
  if (maxSameCaseRun(value) >= ENTROPY_MAX_SAME_CASE_RUN) return false;
  if (UUID_RE.test(value)) return false;
  if (INTEGRITY_PREFIX_RE.test(value)) return false;
  if (shannonEntropy(value) < ENTROPY_MIN_BITS) return false;
  if (decodesToPrintableText(value)) return false;
  return true;
}

/**
 * PEM/PGP private-key spans, found linearly. Each BEGIN marker pairs with the
 * next END marker after it; a BEGIN with no following END runs to end of string
 * (an unterminated fragment is still a leaked key). Pairing by position avoids
 * the quadratic backtracking a single BEGIN…END regex incurs.
 * @param {string} value
 * @returns {SecretMatch[]}
 */
function findPrivateKeyBlocks(value) {
  /** @type {SecretMatch[]} */
  const spans = [];
  PRIVATE_KEY_BEGIN_RE.lastIndex = 0;
  let begin;
  while ((begin = PRIVATE_KEY_BEGIN_RE.exec(value)) !== null) {
    const bodyStart = begin.index + begin[0].length;
    PRIVATE_KEY_END_RE.lastIndex = bodyStart;
    const end = PRIVATE_KEY_END_RE.exec(value);
    const spanEnd = end ? end.index + end[0].length : value.length;
    spans.push({ kind: 'private-key-block', start: begin.index, end: spanEnd });
    // Resume scanning past this block so overlapping BEGINs inside it are skipped.
    PRIVATE_KEY_BEGIN_RE.lastIndex = spanEnd;
  }
  return spans;
}

/**
 * Locate every secret-shaped span inside a string, sorted and non-overlapping.
 * @param {string} value
 * @returns {SecretMatch[]}
 */
function findSecretMatches(value) {
  /** @type {SecretMatch[]} */
  const matches = [];

  for (const { kind, re } of KNOWN_FORMATS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(value)) !== null) {
      matches.push({ kind, start: match.index, end: match.index + match[0].length });
      if (match[0].length === 0) re.lastIndex += 1;
    }
  }

  matches.push(...findPrivateKeyBlocks(value));

  URL_CREDENTIALS_RE.lastIndex = 0;
  let credentials;
  while ((credentials = URL_CREDENTIALS_RE.exec(value)) !== null) {
    const password = credentials[1];
    if (PLACEHOLDER_RE.test(password)) continue;
    const start = credentials.index + credentials[0].length - password.length - 1;
    matches.push({ kind: 'url-credentials', start, end: start + password.length });
  }

  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  /** @type {SecretMatch[]} */
  const merged = [];
  for (const match of matches) {
    const previous = merged.at(-1);
    if (previous && match.start <= previous.end) {
      previous.end = Math.max(previous.end, match.end);
      continue;
    }
    merged.push({ ...match });
  }
  return merged;
}

/**
 * Classify a value by the kind of the earliest secret found in it, or null when
 * no detector recognizes it. Non-strings are never secrets.
 * @param {unknown} value
 * @returns {SecretKind | null}
 */
export function detectSecretKind(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || PLACEHOLDER_RE.test(trimmed)) return null;
  const [first] = findSecretMatches(value);
  if (first) return first.kind;
  return isHighEntropySecret(trimmed) ? 'high-entropy' : null;
}

/**
 * True when a string carries a secret, by known format or by entropy.
 * @param {unknown} value
 * @returns {boolean}
 */
export function looksLikeSecret(value) {
  return detectSecretKind(value) !== null;
}

/**
 * Redact the secret parts of a string. An opaque high-entropy value is
 * replaced wholesale; a secret embedded in a larger value (a connection
 * string, a URL with credentials) keeps its surrounding context so the diff
 * stays readable.
 * @param {string} value
 * @returns {string}
 */
export function redactSecretString(value) {
  const trimmed = value.trim();
  if (!trimmed || PLACEHOLDER_RE.test(trimmed)) return value;

  const matches = findSecretMatches(value);
  if (matches.length === 0) {
    return isHighEntropySecret(trimmed) ? REDACTED : value;
  }

  let out = '';
  let cursor = 0;
  for (const { start, end } of matches) {
    out += value.slice(cursor, start) + REDACTED;
    cursor = end;
  }
  return out + value.slice(cursor);
}

/**
 * Key names that mean "this value is a credential".
 *
 * Matched against the *configuration* path only. A multi-document file prefixes
 * every path with the document's identity — `Deployment/prod/token-service.…` —
 * and that identity is a resource name the user chose, not a key name. Letting
 * it match masks every value in the document, numbers and booleans included, so
 * callers strip the document prefix before matching: see `secretMatchPath` in
 * differ.js, and the document handling in `maskState`.
 */
export const SECRET_PATH_RE = /(secret|token|password|api[_-]?key|private[_-]?key|credential)/i;

// Whole words that name a credential, after splitting a key on camelCase and
// punctuation. A word that *ends* in one also counts, for keys written with no
// separator (`DBPASSWORD`, `accesstoken`), but one that only *starts* with one
// does not: `tokenizer` is not a token, `passwordless` is not a password.
const SECRET_WORDS = ['secrets', 'secret', 'tokens', 'token', 'passwords', 'password', 'passwd', 'credentials', 'credential', 'apikey', 'privatekey'];
const SECRET_PAIRS = [['api', 'key'], ['private', 'key']];
/**
 * A last word that makes a secret-named key *about* the secret rather than the
 * secret: `secretName`, `passwordPolicy`, `tokenTTL`, `secretUser`. Not `key`
 * (`apiKey`, `secretKey` are credentials) and not `id` (Vault's `secret_id`).
 */
const METADATA_WORDS = new Set([
  'name', 'names', 'ref', 'refs', 'user', 'username', 'policy', 'policies', 'ttl', 'expiry', 'expiration',
  'lifetime', 'timeout', 'length', 'path', 'file', 'url', 'uri', 'endpoint', 'header', 'type', 'enabled',
  'mode', 'format', 'rotation', 'version', 'count', 'size', 'prefix', 'suffix', 'store', 'provider',
  'manager', 'namespace', 'selector', 'annotations', 'labels', 'mount', 'volume', 'dir', 'location',
  'interval', 'issuer', 'threshold', 'duration', 'seconds', 'retry', 'config', 'configuration', 'settings',
  'options', 'job', 'jobs', 'generator', 'source', 'review', 'init', 'controller', 'operator', 'webhook',
  'sync', 'cache',
]);
/**
 * Keys that are structure, not content, when their parent names a secret:
 * `password: { secret: db, key: password }` (a reference), `clientSecret: {
 * type: string }` (a schema), a projected `serviceAccountToken: { audience,
 * expirationSeconds, path }`.
 */
const STRUCTURAL_KEYS = new Set([
  'name', 'key', 'namespace', 'type', 'description', 'format', 'enabled', 'enable', 'optional', 'required',
  'mode', 'defaultmode', 'items', 'path', 'mountpath', 'subpath', 'readonly', 'audience', 'aud',
  'expirationseconds', 'issuer', 'provider', 'kind', 'apiversion', 'version', 'labels', 'annotations',
  'selector', 'prefix', 'suffix', 'header', 'ttl', 'rotationpolicy', 'algorithm', 'encoding', 'size',
  'length', 'image', 'repository', 'registry', 'tag', 'pullpolicy', 'digest', 'create', 'secretname',
  // JSON-schema keywords: a CRD's `clientSecret: { type: string, maxLength: 64 }`.
  'properties', 'additionalproperties', 'maxproperties', 'minproperties', 'maxlength', 'minlength',
  'pattern', 'enum', 'default', 'minimum', 'maximum', 'nullable', 'xkubernetesmaptype',
  'xkuberneteslisttype', 'xkubernetespreserveunknownfields', 'xkubernetesvalidations',
]);

// Last words of keys that group structure: `containerSecurityContext`,
// `matchLabels`, `matchExpressions`, `podSpec`.
const STRUCTURE_WORDS = new Set(['context', 'labels', 'expressions', 'spec', 'metadata', 'status', 'template', 'resources', 'probe', 'affinity', 'tolerations', 'ports', 'service', 'ingress', 'rules', 'schema']);

// Containers that carry a secret's contents under arbitrary keys.
const TRANSPARENT_KEYS = new Set(['data', 'stringdata', 'values', 'value', 'env', 'environment', 'vars', 'variables', 'entries', 'keys']);

/**
 * The named keys of a diff path, indices dropped: `a.b[0]["C"]` -> a, b, C.
 * @param {string} path
 * @returns {string[]}
 */
function pathKeys(path) {
  /** @type {string[]} */
  const keys = [];
  for (const match of path.matchAll(/\["((?:[^"\\]|\\.)*)"\]|\[[^\]]*\]|([^.[\]]+)/g)) {
    if (match[1] !== undefined) {
      try {
        keys.push(JSON.parse(`"${match[1]}"`));
      } catch {
        keys.push(match[1]);
      }
    } else if (match[2] !== undefined) {
      keys.push(match[2]);
    }
  }
  return keys;
}

/**
 * Lowercased words of a key: `adminPasswordKey` -> admin, password, key.
 * @param {string} key
 * @returns {string[]}
 */
function keyWords(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Index of the word that names a credential, or -1.
 * @param {string[]} words
 * @returns {number}
 */
function secretWordIndex(words) {
  for (let i = 0; i < words.length; i++) {
    if (SECRET_WORDS.some((word) => words[i] === word || words[i].endsWith(word))) return i;
    if (SECRET_PAIRS.some(([a, b]) => words[i] === a && words[i + 1] === b)) return i + 1;
  }
  return -1;
}

/**
 * Lowercase alphanumerics only: `x-kubernetes-map-type` -> `xkubernetesmaptype`.
 * @param {string} key
 * @returns {string}
 */
function normalizeKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * A key that groups structure rather than content, so a credential name above
 * it does not reach below it: `selector`, `matchLabels`, `securityContext`,
 * `authorizationHeader`, `tokenReviewConfig`.
 * @param {string} key
 * @returns {boolean}
 */
function isStructureOrMetadata(key) {
  if (STRUCTURAL_KEYS.has(normalizeKey(key))) return true;
  const last = keyWords(key).at(-1);
  return last !== undefined && (METADATA_WORDS.has(last) || STRUCTURE_WORDS.has(last));
}

/**
 * A key that names a credential: a secret word whose key does not end in a
 * metadata word. `password`, `apiKey`, `DB_PASSWORD` yes; `secretName`,
 * `createSecretJob`, `tokenRefreshInterval` no.
 * @param {string} key
 * @returns {boolean}
 */
function namesCredential(key) {
  const words = keyWords(key);
  const at = secretWordIndex(words);
  return at >= 0 && !(at < words.length - 1 && METADATA_WORDS.has(words.at(-1)));
}

/**
 * True when a configuration path names a credential.
 *
 * Decided on the leaf's own key and its parent, not on any key anywhere above
 * it. Matching the whole path (as SECRET_PATH_RE did) masked and flagged
 * `capabilities.drop[0]` under `redisSecretInit`, `matchLabels.app` under
 * `apiKey`, `tokenizer.flavor`, and the `type`/`description` of every CRD
 * schema property called `clientSecret` (#248). So:
 *
 * - own key names a credential (whole word, or ending in one), unless its last
 *   word is metadata (`secretName`, `passwordPolicy`, `tokenTTL`)
 * - or the parent does (`sharedSecret.value`, `secrets.db`), unless the leaf is
 *   structural (`name`, `key`, `type`, `audience`, ...)
 *
 * A credential stored deeper, or under an innocuous name, is the value
 * detector's job; it runs on every value regardless.
 *
 * Lives here rather than beside either caller because there are two of them —
 * the renderer masking a diff for display, and the snapshot store masking a
 * state for a commit — and a store that recognized fewer key names than the
 * terminal did would write into git history exactly the values the terminal
 * thought were too sensitive to print.
 * @param {string} path
 * @returns {boolean}
 */
export function looksLikeSecretPath(path) {
  const keys = pathKeys(path);
  const own = keys.at(-1);
  if (own === undefined) return false;
  if (secretWordIndex(keyWords(own)) >= 0) return namesCredential(own);
  // Walk up to the nearest key that names a credential. A Secret's `data` /
  // `stringData` (and the like) are looked through, and make the leaf a secret
  // whatever it is called: `encryptedSecret.stringData.key1`. Otherwise the leaf
  // must not be structural (`password.key` is a reference), and the walk stops
  // at a key that is structure or metadata (`apiKey.selector.matchLabels.app`,
  // `credentials.authorizationHeader.prefix`), which is where matching any
  // ancestor went wrong. `secrets.prod.db` still counts.
  const leafIsStructural = STRUCTURAL_KEYS.has(normalizeKey(own));
  let throughData = false;
  for (let i = keys.length - 2; i >= 0; i--) {
    const key = keys[i];
    if (TRANSPARENT_KEYS.has(key.toLowerCase())) {
      throughData = true;
      continue;
    }
    if (namesCredential(key)) return throughData || !leafIsStructural;
    if (isStructureOrMetadata(key)) return false;
  }
  return false;
}

/**
 * Keys that hold the *name* of a secret, not the secret: `existingSecret`,
 * `existingSecretPasswordKey`, `tlsSecretName`, `envSecretRef`,
 * `adminPasswordKey`. The Helm convention for "the credential lives in a
 * Kubernetes Secret, and this is where". Deliberately not `*SecretKey`:
 * `minio.secretKey` is the credential itself.
 */
const REFERENCE_KEY_RE = /^(?:existingSecret\w*|\w*Secret(?:Name|Ref)|\w*PasswordKey)$/i;
const SECRET_KEY_REF_RE = /secretKeyRef\.(?:name|key)$/i;
// A Kubernetes object name or a Secret key, which is what a reference holds.
const REFERENCE_VALUE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/;
// `KEY=VALUE`, as Compose writes an environment list entry.
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_.-]*=(.+)$/s;
/**
 * Placeholders that can only be references, for values under a key that names
 * a credential. Stricter than PLACEHOLDER_RE, which serves value-shape
 * detection: there, `$uperSecret1` reading as `$NAME` costs a missed entropy
 * hit; here it would print a password. So `${NAME}`, `${NAME:-}` and
 * `${NAME:?message}` but not `${NAME:-literal}` (the literal is a default
 * credential), `$(NAME)`, `{{ ... }}` with no quoted literal inside, and an
 * already-masked `***`.
 */
const KEY_PLACEHOLDER_RE = /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*(?::?\?[^}]*|:-)?\}|\$\([A-Za-z_][A-Za-z0-9_]*\)|\{\{[^}"'`]*\}\}|\*{3})$/;

/**
 * The last key of a diff path: `a.b.c` -> `c`, `env["X_TOKEN"]` -> `X_TOKEN`.
 * @param {string} path
 * @returns {string}
 */
function lastPathSegment(path) {
  const quoted = /\[("(?:[^"\\]|\\.)*")\]$/.exec(path);
  if (quoted) {
    try {
      return JSON.parse(quoted[1]);
    } catch {
      return quoted[1];
    }
  }
  return path.slice(path.lastIndexOf('.') + 1);
}

/**
 * Could this scalar, sitting under a secret-sounding key, be the secret?
 *
 * Key-name masking used to answer yes for anything, which hid the values a
 * reviewer most needed (#224): `secretCreatePolicy: { enabled: true }` printed
 * as `***`, and `adminPasswordKey: keycloak-admin-password` — the name of a key
 * inside a Secret — raised an error. No, then, for:
 *
 * - booleans, null, and an empty string: nothing to hide
 * - a placeholder (`${X}`, `$(X)`, `{{ ... }}`), alone or as `KEY=<placeholder>`
 * - a reference: a key that names a Secret, holding a plain identifier that the
 *   value detector does not flag
 *
 * Numbers stay yes (`pin: 12345` is the pin). So does `KEY=` with an empty
 * right side: base64 padding (`c2VjcmV0=`) has exactly that shape.
 *
 * Shared by display masking, the committed snapshot store, and the
 * `secret-key-changed` rule, so the three cannot disagree.
 * @param {unknown} value
 * @param {string} [path] the configuration path, document prefix stripped
 * @returns {boolean}
 */
export function isSecretCandidate(value, path = '') {
  if (!looksLikeSecretPath(path)) return false;
  if (value === null || value === undefined || typeof value === 'boolean') return false;
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed || KEY_PLACEHOLDER_RE.test(trimmed)) return false;
  // YAML 1.1 booleans that arrive as strings (`server-tokens: "false"`).
  if (/^(?:true|false|yes|no|on|off)$/i.test(trimmed)) return false;
  const assignment = ASSIGNMENT_RE.exec(trimmed);
  if (assignment && KEY_PLACEHOLDER_RE.test(assignment[1].trim())) return false;
  const isReference = REFERENCE_KEY_RE.test(lastPathSegment(path)) || SECRET_KEY_REF_RE.test(path);
  if (isReference && REFERENCE_VALUE_RE.test(trimmed) && !looksLikeSecret(trimmed)) return false;
  return true;
}

/**
 * True when any scalar inside `value` could be a secret (see
 * `isSecretCandidate`), each judged at its own path.
 * @param {unknown} value
 * @param {string} [path]
 * @returns {boolean}
 */
export function holdsSecretCandidate(value, path = '') {
  if (Array.isArray(value)) return value.some((entry, index) => holdsSecretCandidate(entry, `${path}[${index}]`));
  if (
    value
    && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    return Object.entries(value).some(([key, entry]) => holdsSecretCandidate(entry, path ? `${path}.${key}` : key));
  }
  return isSecretCandidate(value, path);
}

/**
 * True when a value — or any string nested inside a plain object or array —
 * looks like a secret.
 * @param {unknown} value
 * @returns {boolean}
 */
export function containsSecret(value) {
  if (typeof value === 'string') return looksLikeSecret(value);
  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry));
  if (
    value
    && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    return Object.values(value).some((entry) => containsSecret(entry));
  }
  return false;
}
