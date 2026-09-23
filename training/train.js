#!/usr/bin/env node
/**
 * Train the secret classifier and write `src/classifier-weights.json`.
 *
 *   node training/train.js            # train, evaluate, write weights
 *   node training/train.js --dry-run  # train and evaluate, write nothing
 *
 * Logistic regression over character 3-grams plus named shape features,
 * optimized with plain batch gradient descent. No dependency is added: the
 * model class is simple enough that the optimizer is thirty lines, and a
 * security tool should not grow a numerical stack to classify short strings.
 *
 * **Determinism is a requirement, not a nicety.** Teams gate merges on Flecto's
 * exit code, so identical input must produce an identical finding on every run
 * and every machine. There is no shuffling, no sampling, no dropout, and no
 * early stopping on a random split -- a fixed corpus, a fixed feature order, a
 * fixed iteration count. Re-running this script on a clean checkout reproduces
 * the shipped weights byte for byte, and `npm test` asserts exactly that.
 *
 * Nothing in `training/` is published.
 */

import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { NGRAM_N, SHAPE_FEATURE_NAMES, ngrams, shapeVector } from '../src/classifier-features.js';
import { MIN_CLASSIFIER_LENGTH, benignHoldout, secretHoldout, trainingSet } from './corpus.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEIGHTS_PATH = join(ROOT, 'src', 'classifier-weights.json');

// Kept small on purpose. The budget in #136 is < 500 KB added to the published
// package; 3,000 n-grams lands around 60 KB, which leaves the promise intact
// with room to spare and keeps the file reviewable in a diff.
const VOCAB_SIZE = 3000;
const MIN_NGRAM_COUNT = 3;
const ITERATIONS = 3000;
const LEARNING_RATE = 4;
const L2 = 1e-4;

/**
 * The n-gram vocabulary: the most frequent n-grams across the whole corpus,
 * ordered by count then lexically so ties cannot reorder between runs.
 * @param {string[]} values
 * @returns {string[]}
 */
function buildVocabulary(values) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const value of values) {
    for (const gram of new Set(ngrams(value))) {
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= MIN_NGRAM_COUNT)
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, VOCAB_SIZE)
    .map(([gram]) => gram);
}

/**
 * Feature vector: shape features, then one entry per vocabulary n-gram,
 * normalized by the token's n-gram count so length does not dominate.
 * @param {string} value
 * @param {Map<string, number>} vocabIndex
 * @param {number} dim
 * @returns {Float64Array}
 */
function featurize(value, vocabIndex, dim) {
  const vector = new Float64Array(dim);
  const shape = shapeVector(value);
  for (let i = 0; i < shape.length; i += 1) vector[i] = shape[i];

  const grams = ngrams(value);
  const scale = grams.length > 0 ? 1 / grams.length : 0;
  for (const gram of grams) {
    const index = vocabIndex.get(gram);
    if (index !== undefined) vector[shape.length + index] += scale;
  }
  return vector;
}

/** @param {number} z */
function sigmoid(z) {
  // Split by sign so neither branch overflows for large |z|.
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * Batch gradient descent on the logistic loss with L2 regularization.
 * @param {Float64Array[]} vectors
 * @param {number[]} labels
 * @param {number} dim
 * @returns {{ weights: Float64Array, bias: number }}
 */
function train(vectors, labels, dim) {
  const weights = new Float64Array(dim);
  let bias = 0;
  const n = vectors.length;

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const grad = new Float64Array(dim);
    let biasGrad = 0;

    for (let i = 0; i < n; i += 1) {
      const vector = vectors[i];
      let z = bias;
      for (let j = 0; j < dim; j += 1) z += weights[j] * vector[j];
      const error = sigmoid(z) - labels[i];
      if (error !== 0) {
        for (let j = 0; j < dim; j += 1) grad[j] += error * vector[j];
        biasGrad += error;
      }
    }

    for (let j = 0; j < dim; j += 1) {
      weights[j] -= LEARNING_RATE * (grad[j] / n + L2 * weights[j]);
    }
    bias -= LEARNING_RATE * (biasGrad / n);
  }

  return { weights, bias };
}

/**
 * Pick the lowest threshold that still produces zero false positives on the
 * benign evaluation set.
 *
 * This is the ship criterion from #136 and it is not negotiable: the entire
 * reason the existing gates are conservative is that masking a real hostname
 * in someone's terminal is worse than missing an unusual secret. So the
 * threshold is *derived from* the zero-FP constraint rather than chosen and
 * then checked -- and a margin is added on top, because a benign corpus is a
 * sample and the next value Flecto sees is not in it.
 * @param {number[]} benignScores
 * @returns {number}
 */
function thresholdForZeroFalsePositives(benignScores) {
  const worst = benignScores.reduce((max, score) => (score > max ? score : max), 0);
  // Halfway between the most secret-looking benign value and certainty, floored
  // at 0.90 so the threshold can never drift down to something permissive.
  return Math.max(0.9, Math.min(0.999, Number(((worst + 1) / 2).toFixed(4))));
}

function main() {
  const dryRun = process.argv.includes('--dry-run');

  const { values, labels } = trainingSet();
  const vocabulary = buildVocabulary(values);
  const vocabIndex = new Map(vocabulary.map((gram, index) => [gram, index]));
  const dim = SHAPE_FEATURE_NAMES.length + vocabulary.length;

  process.stderr.write(`corpus: ${values.length} values (${labels.filter(Boolean).length} secret)\n`);
  process.stderr.write(`vocabulary: ${vocabulary.length} ${NGRAM_N}-grams, dim ${dim}\n`);

  const vectors = values.map((value) => featurize(value, vocabIndex, dim));
  const { weights, bias } = train(vectors, labels, dim);

  // Evaluate on held-out data only. The hand-written benign list and the
  // differently-seeded secret list were never trained on.
  const long = (value) => value.length >= MIN_CLASSIFIER_LENGTH;
  const benign = benignHoldout().filter(long);
  const secrets = secretHoldout().filter(long);
  const score = (value) => {
    const vector = featurize(value, vocabIndex, dim);
    let z = bias;
    for (let j = 0; j < dim; j += 1) z += weights[j] * vector[j];
    return sigmoid(z);
  };
  const benignScores = benign.map(score);
  const secretScores = secrets.map(score);
  const threshold = thresholdForZeroFalsePositives(benignScores);

  const falsePositives = benignScores.filter((s) => s >= threshold).length;
  const truePositives = secretScores.filter((s) => s >= threshold).length;
  process.stderr.write(
    `threshold ${threshold}: ${falsePositives} false positives / ${benign.length} benign, `
    + `${truePositives}/${secrets.length} secrets caught (${((truePositives / secrets.length) * 100).toFixed(1)}%)\n`,
  );
  if (falsePositives > 0) {
    process.stderr.write('REFUSING to write weights: the zero-false-positive criterion failed.\n');
    process.exitCode = 1;
    return;
  }

  // Rounded to 6 decimals: enough precision that the decision is unchanged,
  // few enough digits that the file is a readable diff and identical across
  // platforms whose last-bit float formatting might differ.
  const round = (n) => Number(n.toFixed(6));
  const model = {
    // Bumping this is a breaking change, treated with the same care as changing
    // a policy pack default. It travels in the JSON envelope beside
    // schema_version so a finding can always be traced to the model that made it.
    modelVersion: '1.0.0',
    ngramN: NGRAM_N,
    shapeFeatures: SHAPE_FEATURE_NAMES,
    threshold,
    bias: round(bias),
    vocabulary,
    weights: Array.from(weights, round),
  };

  if (dryRun) {
    process.stderr.write('--dry-run: weights not written\n');
    return;
  }
  writeFileSync(WEIGHTS_PATH, `${JSON.stringify(model)}\n`, 'utf8');
  const bytes = Buffer.byteLength(JSON.stringify(model));
  process.stderr.write(`wrote ${WEIGHTS_PATH} (${(bytes / 1024).toFixed(1)} KB)\n`);
}

main();
