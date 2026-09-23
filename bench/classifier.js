#!/usr/bin/env node
/**
 * Precision/recall benchmark for the secret classifier (#136).
 *
 *   npm run bench:classifier
 *   npm run bench:classifier -- --markdown   # the table for docs/
 *
 * Answers the only question that decides whether this feature ships: does the
 * classifier add detections **without** adding false positives? The heuristic's
 * zero-false-positive floor is the entire reason its gates are conservative, and
 * a classifier that trades that floor for recall is a regression, not a feature.
 *
 * Everything is measured on held-out data: the hand-written benign list, and
 * secrets generated from a different seed than the training corpus. "It's ML" is
 * not a claim; a confusion matrix is.
 *
 * This never runs during `npm test` and is excluded from the published package.
 */

import { MIN_CLASSIFIER_LENGTH } from '../src/classifier-features.js';
import { CLASSIFIER_MODEL_VERSION, classifierScore, configureSecretClassifier } from '../src/classify.js';
import { detectSecretKind, looksLikeSecret } from '../src/secrets.js';
import { benignHoldout, secretHoldout } from '../training/corpus.js';

/**
 * @param {string[]} values
 * @param {(v: string) => boolean} predicate
 * @returns {number}
 */
const count = (values, predicate) => values.filter(predicate).length;

function main() {
  const markdown = process.argv.includes('--markdown');
  const benign = benignHoldout();
  const secrets = secretHoldout();

  configureSecretClassifier(false);
  const heuristic = {
    caught: count(secrets, looksLikeSecret),
    flagged: count(benign, looksLikeSecret),
  };

  configureSecretClassifier(true);
  const combined = {
    caught: count(secrets, looksLikeSecret),
    flagged: count(benign, looksLikeSecret),
  };

  // What the classifier contributes on its own, which is what the union-only
  // design makes the meaningful number.
  const addedSecrets = count(secrets, (v) => detectSecretKind(v) === 'classified');
  const addedFalse = count(benign, (v) => detectSecretKind(v) === 'classified');

  const inBand = (v) => v.length >= MIN_CLASSIFIER_LENGTH;
  const slashSecrets = secrets.filter((v) => v.includes('/') && inBand(v));
  configureSecretClassifier(false);
  const slashByHeuristic = count(slashSecrets, looksLikeSecret);
  configureSecretClassifier(true);
  const slashCombined = count(slashSecrets, looksLikeSecret);

  // Cost per value, over the whole holdout. The budget in #136 is < 1 ms.
  const sample = [...benign, ...secrets].filter(inBand);
  const start = performance.now();
  for (let i = 0; i < 20; i += 1) for (const value of sample) classifierScore(value);
  const perValueMs = (performance.now() - start) / (20 * sample.length);

  const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);

  if (markdown) {
    process.stdout.write(`Model \`${CLASSIFIER_MODEL_VERSION}\`. Held-out corpus: ${secrets.length} secrets, ${benign.length} benign values.\n\n`);
    process.stdout.write('| | Secrets caught | Benign flagged |\n|---|---|---|\n');
    process.stdout.write(`| Heuristic alone | ${heuristic.caught}/${secrets.length} (${pct(heuristic.caught, secrets.length)}) | ${heuristic.flagged}/${benign.length} |\n`);
    process.stdout.write(`| With \`--classify-secrets\` | ${combined.caught}/${secrets.length} (${pct(combined.caught, secrets.length)}) | ${combined.flagged}/${benign.length} |\n`);
    process.stdout.write(`| **Classifier's own contribution** | **+${addedSecrets}** | **+${addedFalse}** |\n\n`);
    process.stdout.write(`Standard-base64 secrets containing \`/\` — the gap the charset gate cannot see by construction: `);
    process.stdout.write(`${slashByHeuristic}/${slashSecrets.length} caught by the heuristic, ${slashCombined}/${slashSecrets.length} with the classifier.\n\n`);
    process.stdout.write(`Cost: ${perValueMs.toFixed(4)} ms per value.\n`);
    return;
  }

  process.stdout.write(`Secret classifier benchmark (model ${CLASSIFIER_MODEL_VERSION})\n`);
  process.stdout.write(`  corpus: ${secrets.length} held-out secrets, ${benign.length} held-out benign\n\n`);
  process.stdout.write(`  heuristic alone      ${String(heuristic.caught).padStart(4)}/${secrets.length} caught  ${heuristic.flagged} false positive(s)\n`);
  process.stdout.write(`  with classifier      ${String(combined.caught).padStart(4)}/${secrets.length} caught  ${combined.flagged} false positive(s)\n`);
  process.stdout.write(`  classifier added     ${String(addedSecrets).padStart(4)} detection(s)   ${addedFalse} false positive(s)\n\n`);
  process.stdout.write(`  "/"-bearing base64   ${slashByHeuristic}/${slashSecrets.length} -> ${slashCombined}/${slashSecrets.length}\n`);
  process.stdout.write(`  cost                 ${perValueMs.toFixed(4)} ms per value\n\n`);

  if (addedFalse > 0) {
    process.stdout.write('  FAIL: the classifier added a false positive. It must not ship on these weights.\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('  PASS: detections added, false-positive floor held.\n');
}

main();
