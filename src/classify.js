import { createRequire } from 'module';
import { MIN_CLASSIFIER_LENGTH, SHAPE_FEATURE_NAMES, ngrams, shapeVector } from './classifier-features.js';

/**
 * The opt-in second-stage secret detector (#136).
 *
 * `src/secrets.js` buys its zero-false-positive floor with recall, and says so:
 * on the measured corpus it flags no benign value, misses roughly 5% of random
 * tokens, and misses standard-base64 secrets containing `/` **by construction**,
 * because the charset gate excludes `/` so that hostnames, URLs, and paths can
 * never be candidates. This is the second stage that closes part of that gap.
 *
 * Three properties hold it in place, and none of them is optional:
 *
 * 1. **It may only add detections.** It runs after every existing detector and
 *    its output is unioned with theirs. A known vendor format is a secret and
 *    the classifier is not consulted; the entropy gate passing is a secret and
 *    the classifier cannot un-flag it. A model that can *suppress* a detection
 *    is a model that can leak a credential on a version bump. Union-only also
 *    bounds the failure mode to false positives, which are visible and
 *    annoying, rather than silent exposure.
 * 2. **It is deterministic.** Teams gate merges on Flecto's exit code, so the
 *    same value must produce the same answer on every run and every machine.
 *    Inference is a dot product over a pinned weight file; there is no
 *    sampling, no time, no locale, no floating-point tolerance anywhere near
 *    the decision.
 * 3. **It is offline, and the model is the one that shipped.** Flecto reads
 *    `.env` files, SOPS documents, and Terraform plans; #113 was a
 *    sensitive-value leak. Nothing is sent anywhere. There is deliberately no
 *    `--classify-model <path>` option: `.flectorc` is attacker-controlled on an
 *    untrusted pull request, and deserializing an attacker-supplied model is the
 *    same class of hole as loading their plugin (GHSA-wq8m-fc3q-8m5x).
 *
 * The model is character 3-gram logistic regression -- the right class for
 * deciding whether a short opaque string is key material, and small enough that
 * the weights are a 48 KB JSON file anyone can read in a diff.
 */

// JSON is loaded through createRequire rather than an import attribute so the
// module works identically on every supported Node without a flag.
const require = createRequire(import.meta.url);
/** @type {{ modelVersion: string, ngramN: number, shapeFeatures: string[], threshold: number, bias: number, vocabulary: string[], weights: number[] }} */
const MODEL = require('./classifier-weights.json');

/**
 * A feature order mismatch would score nonsense rather than fail, so it is
 * checked once at load. This can only fire if `classifier-features.js` was
 * edited without retraining -- exactly the mistake that would otherwise ship
 * quietly.
 */
if (
  MODEL.shapeFeatures.length !== SHAPE_FEATURE_NAMES.length
  || MODEL.shapeFeatures.some((name, index) => name !== SHAPE_FEATURE_NAMES[index])
) {
  throw new Error(
    'Secret classifier weights were trained on different shape features than this build computes.'
    + ' Re-run `node training/train.js` after changing src/classifier-features.js.',
  );
}

/** @type {Map<string, number>} */
const VOCAB_INDEX = new Map(MODEL.vocabulary.map((gram, index) => [gram, index]));
const SHAPE_COUNT = SHAPE_FEATURE_NAMES.length;

/** The version of the shipped model, for the JSON envelope. */
export const CLASSIFIER_MODEL_VERSION = MODEL.modelVersion;

/**
 * Whether the classifier is enabled for this process.
 *
 * Module-level rather than threaded through every call: `looksLikeSecret` and
 * `containsSecret` are pure helpers reached from the renderer, the policy
 * engine, and the snapshot store, and plumbing an options object through all
 * three for one boolean would be a worse trade than this. It is set once, from
 * the CLI, before any diffing starts.
 */
let enabled = false;

/**
 * Turn the classifier on or off for this process.
 *
 * `FLECTO_CLASSIFY_SECRETS=0` is a hard kill switch that overrides both the
 * flag and `.flectorc`, for a runner that must not run it at all.
 * @param {boolean} on
 */
export function configureSecretClassifier(on) {
  const killed = process.env.FLECTO_CLASSIFY_SECRETS;
  if (killed === '0' || String(killed).toLowerCase() === 'false') {
    enabled = false;
    return;
  }
  enabled = Boolean(on);
}

/** @returns {boolean} */
export function secretClassifierEnabled() {
  return enabled;
}

/**
 * The model's probability that a value is key material, in [0, 1].
 *
 * Exported for the benchmark and the tests; the detection path uses
 * `classifiesAsSecret`.
 * @param {string} value
 * @returns {number}
 */
export function classifierScore(value) {
  let z = MODEL.bias;
  const shape = shapeVector(value);
  for (let i = 0; i < SHAPE_COUNT; i += 1) z += MODEL.weights[i] * shape[i];

  const grams = ngrams(value);
  const scale = grams.length > 0 ? 1 / grams.length : 0;
  for (const gram of grams) {
    const index = VOCAB_INDEX.get(gram);
    if (index !== undefined) z += MODEL.weights[SHAPE_COUNT + index] * scale;
  }
  // Split by sign so neither branch overflows.
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * True when the classifier is enabled and judges this value to be key material.
 *
 * The length floor matches the entropy gate's: below it a configuration is full
 * of `RollingUpdate`, `IfNotPresent`, and `ap-southeast-2`, which are opaque,
 * word-shaped, and not credentials. Scoring only what the gate would have
 * scored is what keeps the false-positive floor reachable.
 * @param {string} value
 * @returns {boolean}
 */
export function classifiesAsSecret(value) {
  if (!enabled) return false;
  if (typeof value !== 'string' || value.length < MIN_CLASSIFIER_LENGTH) return false;
  return classifierScore(value) >= MODEL.threshold;
}

export { MIN_CLASSIFIER_LENGTH };
