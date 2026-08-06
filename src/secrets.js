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
  // PEM private key blocks, including PGP blocks and unterminated fragments.
  {
    kind: 'private-key-block',
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
];

/** Credentials embedded in a URL authority: scheme://user:PASSWORD@host. */
const URL_CREDENTIALS_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/gi;

/**
 * Values that only *reference* a secret. Redacting these adds noise and, worse,
 * would make the policy rule fire on configs that correctly keep secrets out of
 * the file.
 */
const PLACEHOLDER_RE = /^(?:\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z0-9_]+%|<[^>]*>|\*+)$/;

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
 * and a hand-built corpus of benign config values: 0 false positives, ~5% of
 * random tokens missed (worst at length 24, ~7%). Standard-base64 secrets that
 * contain "/" are always missed by this fallback by construction — the known
 * formats above are what covers those.
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
