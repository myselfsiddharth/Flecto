/**
 * Feature extraction for the secret classifier.
 *
 * Shared by training (`training/train.js`) and inference (`src/classify.js`)
 * so the two cannot drift. A feature computed one way at training time and
 * another at inference is the classic way a model becomes quietly wrong, and
 * for a detector whose whole promise is "0 false positives" that would not
 * show up as a crash -- it would show up as a masked hostname in someone's
 * terminal, or a leaked credential.
 *
 * Two feature families:
 *
 *   1. **Character n-grams** (n = 3), over a vocabulary fixed at training time.
 *      This is the part that reads shape: `tio`, `ing`, `-pr` are word-ish;
 *      random key material produces n-grams that appear once each and match
 *      nothing in the vocabulary.
 *   2. **Shape features**, hand-chosen and named. Length, character-class
 *      ratios, run lengths, entropy. These carry most of the signal and stay
 *      legible in a diff, which matters for a weight file a reviewer has to be
 *      able to reason about.
 *
 * Everything is a pure function of the string. No randomness, no locale, no
 * clock: identical input gives an identical vector on every machine, which is
 * what lets the exit code be reproducible.
 */

/** n for the character n-grams. */
export const NGRAM_N = 3;

/**
 * The minimum length the classifier considers, matching the entropy gate's.
 *
 * The classifier is a second stage over the *same* candidate population as the
 * gate, not a wider one. Below 24 characters a configuration is full of values
 * like `RollingUpdate`, `IfNotPresent`, `ap-southeast-2`, and `P1Y2M10DT2H30M`
 * -- opaque, word-shaped, and emphatically not credentials -- while a
 * 20-character secret carries little enough entropy that catching it is not
 * worth what flagging those would cost. Scoring only what the gate would have
 * scored is what keeps the zero-false-positive floor reachable at all.
 *
 * Lives here rather than in `training/` because `training/` is not published.
 */
export const MIN_CLASSIFIER_LENGTH = 24;

/** Boundary marker, so a token's first and last characters carry position. */
const BOUNDARY = '\u0001';

/**
 * The n-grams of a value, with boundaries.
 * @param {string} value
 * @returns {string[]}
 */
export function ngrams(value) {
  const padded = BOUNDARY + value + BOUNDARY;
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i + NGRAM_N <= padded.length; i += 1) {
    out.push(padded.slice(i, i + NGRAM_N));
  }
  return out;
}

/**
 * Shannon entropy in bits per character.
 *
 * Duplicated from `secrets.js` rather than imported: that copy is part of the
 * entropy *gate*, and the two must be free to change independently -- retuning
 * the gate's threshold should never silently move the classifier's decision
 * boundary, which is pinned by the shipped weights.
 * @param {string} value
 * @returns {number}
 */
function entropyBits(value) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Longest run of consecutive characters from one class.
 * @param {string} value
 * @param {RegExp} charClass
 * @returns {number}
 */
function longestRun(value, charClass) {
  let longest = 0;
  let run = 0;
  for (const char of value) {
    if (charClass.test(char)) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

/**
 * The named shape features, in a fixed order.
 *
 * Order is part of the model: the weight file indexes into this array, so
 * inserting a feature anywhere but the end invalidates existing weights. The
 * training script writes the names into the weight file and `classify.js`
 * checks them, so a mismatch fails loudly rather than scoring nonsense.
 * @type {Array<{ name: string, of: (value: string) => number }>}
 */
export const SHAPE_FEATURES = [
  { name: 'len', of: (v) => Math.min(v.length, 96) / 96 },
  { name: 'entropy', of: (v) => Math.min(entropyBits(v), 6.5) / 6.5 },
  { name: 'upperRatio', of: (v) => ratio(v, /[A-Z]/) },
  { name: 'lowerRatio', of: (v) => ratio(v, /[a-z]/) },
  { name: 'digitRatio', of: (v) => ratio(v, /[0-9]/) },
  { name: 'symbolRatio', of: (v) => ratio(v, /[^A-Za-z0-9]/) },
  // The charset gate in secrets.js excludes these outright, which is exactly
  // why the classifier must weigh them rather than inherit that rule: `/` in a
  // standard-base64 secret is the gap, and `/` in a path is the reason for it.
  { name: 'hasSlash', of: (v) => (v.includes('/') ? 1 : 0) },
  { name: 'hasPlus', of: (v) => (v.includes('+') ? 1 : 0) },
  { name: 'hasDot', of: (v) => (v.includes('.') ? 1 : 0) },
  { name: 'hasDash', of: (v) => (v.includes('-') ? 1 : 0) },
  { name: 'hasUnderscore', of: (v) => (v.includes('_') ? 1 : 0) },
  { name: 'hasColon', of: (v) => (v.includes(':') ? 1 : 0) },
  { name: 'hasEquals', of: (v) => (v.includes('=') ? 1 : 0) },
  { name: 'hasSpace', of: (v) => (/\s/.test(v) ? 1 : 0) },
  { name: 'maxLowerRun', of: (v) => Math.min(longestRun(v, /[a-z]/), 16) / 16 },
  { name: 'maxUpperRun', of: (v) => Math.min(longestRun(v, /[A-Z]/), 16) / 16 },
  { name: 'maxDigitRun', of: (v) => Math.min(longestRun(v, /[0-9]/), 16) / 16 },
  // A word-shaped identifier alternates case at word boundaries only; random
  // key material flips every couple of characters.
  { name: 'caseFlips', of: (v) => Math.min(caseFlips(v), 32) / 32 },
  { name: 'distinctRatio', of: (v) => (v.length === 0 ? 0 : new Set(v).size / v.length) },
  { name: 'allHex', of: (v) => (/^[0-9a-f]+$/i.test(v) ? 1 : 0) },
  { name: 'startsUpper', of: (v) => (/^[A-Z]/.test(v) ? 1 : 0) },
  { name: 'endsDigit', of: (v) => (/[0-9]$/.test(v) ? 1 : 0) },
];

/** @param {string} value @param {RegExp} charClass */
function ratio(value, charClass) {
  if (value.length === 0) return 0;
  let n = 0;
  for (const char of value) if (charClass.test(char)) n += 1;
  return n / value.length;
}

/** @param {string} value */
function caseFlips(value) {
  let flips = 0;
  let previous = null;
  for (const char of value) {
    const kind = /[a-z]/.test(char) ? 'lower' : /[A-Z]/.test(char) ? 'upper' : null;
    if (kind && previous && kind !== previous) flips += 1;
    if (kind) previous = kind;
  }
  return flips;
}

/**
 * The shape-feature vector, in `SHAPE_FEATURES` order.
 * @param {string} value
 * @returns {number[]}
 */
export function shapeVector(value) {
  return SHAPE_FEATURES.map((feature) => feature.of(value));
}

/** The feature names, for the compatibility check in the weight file. */
export const SHAPE_FEATURE_NAMES = SHAPE_FEATURES.map((f) => f.name);
