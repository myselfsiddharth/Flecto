import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import {
  CLASSIFIER_MODEL_VERSION,
  classifierScore,
  classifiesAsSecret,
  configureSecretClassifier,
} from '../src/classify.js';
import { MIN_CLASSIFIER_LENGTH, SHAPE_FEATURE_NAMES, ngrams, shapeVector } from '../src/classifier-features.js';
import { detectSecretKind, looksLikeSecret } from '../src/secrets.js';
import { benignHoldout, secretHoldout, seededRandom, trainingSet } from '../training/corpus.js';

const rootIndex = resolve(process.cwd(), 'index.js');

// A standard-base64 secret carrying `/`: the gap the charset gate cannot see by
// construction, and the reason this feature exists.
const SLASH_SECRET = 'rcz3EoFrRz5/qbPLEc0QzyogOsXpW/SXk2fBd';

afterEach(() => configureSecretClassifier(false));

describe('the secret classifier is opt-in and additive (#136)', () => {
  test('it is off unless turned on, so nothing changes by default', () => {
    configureSecretClassifier(false);
    assert.equal(classifiesAsSecret(SLASH_SECRET), false);
    assert.equal(looksLikeSecret(SLASH_SECRET), false, 'the heuristic misses this one by construction');
  });

  test('turned on, it closes the standard-base64 gap', () => {
    configureSecretClassifier(true);
    assert.equal(looksLikeSecret(SLASH_SECRET), true);
    assert.equal(detectSecretKind(SLASH_SECRET), 'classified', 'and says which detector found it');
  });

  test('it may only add detections, never remove one', () => {
    // A model that can suppress a detection is a model that can leak a
    // credential on a version bump. Every kind the other detectors produce must
    // survive the classifier being on, whatever the classifier thinks.
    const alreadyDetected = [
      ['AKIAIOSFODNN7EXAMPLE', 'aws-access-key-id'],
      ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github-token'],
      ['AIzaSyA1234567890abcdefghijklmnopqrstuv', 'google-api-key'],
      ['postgres://user:hunter2@db.internal:5432/app', 'url-credentials'],
    ];
    for (const [value, kind] of alreadyDetected) {
      configureSecretClassifier(false);
      assert.equal(detectSecretKind(value), kind, `${value} before`);
      configureSecretClassifier(true);
      assert.equal(detectSecretKind(value), kind, `${value} must keep its own kind`);
    }
  });

  test('a high-entropy detection keeps its kind rather than being relabelled', () => {
    const entropy = benignHoldout().concat(secretHoldout()).find((v) => {
      configureSecretClassifier(false);
      return detectSecretKind(v) === 'high-entropy';
    });
    assert.ok(entropy, 'the corpus contains a value the entropy gate catches');
    configureSecretClassifier(true);
    assert.equal(detectSecretKind(entropy), 'high-entropy');
  });

  test('it adds no false positive on the held-out benign corpus', () => {
    // The ship criterion from #136, asserted rather than trusted to the
    // training script. If this fails the feature must not ship.
    configureSecretClassifier(true);
    const added = benignHoldout().filter((v) => detectSecretKind(v) === 'classified');
    assert.deepEqual(added, [], 'the classifier flagged a benign value');
  });

  test('it ignores anything shorter than the entropy gate would consider', () => {
    configureSecretClassifier(true);
    for (const value of ['RollingUpdate', 'IfNotPresent', 'ap-southeast-2', 'P1Y2M10DT2H30M']) {
      assert.ok(value.length < MIN_CLASSIFIER_LENGTH);
      assert.equal(classifiesAsSecret(value), false, value);
    }
  });
});

describe('the classifier is deterministic and pinned', () => {
  test('the same value scores identically, every time', () => {
    // Teams gate merges on the exit code, so a float that wobbles across the
    // threshold would make a build flaky in the worst possible way.
    const first = classifierScore(SLASH_SECRET);
    for (let i = 0; i < 50; i += 1) assert.equal(classifierScore(SLASH_SECRET), first);
  });

  test('the shipped weights match the features this build computes', () => {
    // classify.js throws at import when these disagree; this asserts the
    // agreement directly so the failure names the cause.
    const model = JSON.parse(
      spawnSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify(require('./src/classifier-weights.json')))"],
        { encoding: 'utf8' }).stdout,
    );
    assert.deepEqual(model.shapeFeatures, SHAPE_FEATURE_NAMES);
    assert.equal(model.weights.length, SHAPE_FEATURE_NAMES.length + model.vocabulary.length);
    assert.equal(model.modelVersion, CLASSIFIER_MODEL_VERSION);
    assert.ok(model.threshold >= 0.9, 'the threshold may never drift down to something permissive');
  });

  test('the training corpus regenerates byte-identically', () => {
    // The weights are only an auditable artifact if the corpus behind them is
    // reproducible from a clean checkout.
    assert.deepEqual(trainingSet().values, trainingSet().values);
    const a = seededRandom(1234);
    const b = seededRandom(1234);
    for (let i = 0; i < 1000; i += 1) assert.equal(a(), b());
  });

  test('feature extraction is a pure function of the string', () => {
    for (const value of [SLASH_SECRET, 'CustomerSuccessDashboard2026', '']) {
      assert.deepEqual(shapeVector(value), shapeVector(value));
      assert.deepEqual(ngrams(value), ngrams(value));
    }
  });

  test('scoring is bounded and safe on hostile input', () => {
    configureSecretClassifier(true);
    for (const value of ['\u0000'.repeat(64), '\ud800'.repeat(32), 'a'.repeat(100_000), '\u{1F44D}'.repeat(40)]) {
      const score = classifierScore(value);
      assert.ok(score >= 0 && score <= 1, `${score} out of range`);
      assert.equal(typeof classifiesAsSecret(value), 'boolean');
    }
  });
});

describe('the classifier can be turned off by a runner that must not run it', () => {
  /**
   * @param {string[]} args
   * @param {Record<string, string>} env
   */
  function runCi(args, env = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-classify-'));
    try {
      writeFileSync(join(dir, 'app.yaml'), `conn: "${SLASH_SECRET}"\n`, 'utf8');
      writeFileSync(join(dir, 'snap.json'), JSON.stringify({ state: { conn: 'old' } }), 'utf8');
      return spawnSync(process.execPath, [rootIndex, 'ci', 'app.yaml', '--snapshot-ref', 'snap.json',
        '--mask-secrets', '--format', 'json', ...args], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, ...env },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('--classify-secrets masks the value the heuristic misses', () => {
    const run = runCi(['--classify-secrets']);
    assert.ok(!run.stdout.includes(SLASH_SECRET), 'the secret leaked into output');
    assert.match(run.stdout, /"classifier_version": *"1\.0\.0"/, 'and the envelope records the model');
  });

  test('without the flag the value is not masked, and no model version is claimed', () => {
    const run = runCi([]);
    assert.ok(run.stdout.includes(SLASH_SECRET));
    assert.doesNotMatch(run.stdout, /classifier_version/);
  });

  test('FLECTO_CLASSIFY_SECRETS=0 overrides the flag', () => {
    const run = runCi(['--classify-secrets'], { FLECTO_CLASSIFY_SECRETS: '0' });
    assert.ok(run.stdout.includes(SLASH_SECRET), 'the kill switch did not stop it');
    assert.doesNotMatch(run.stdout, /classifier_version/);
  });

  test('.flectorc can enable it, because it grants no capability', () => {
    // Unlike a plugin or an alert action, this only ever masks *more*: it
    // cannot turn a failing gate green, so it is a setting, not an action.
    const dir = mkdtempSync(join(tmpdir(), 'flecto-classify-rc-'));
    try {
      writeFileSync(join(dir, 'app.yaml'), `conn: "${SLASH_SECRET}"\n`, 'utf8');
      writeFileSync(join(dir, 'snap.json'), JSON.stringify({ state: { conn: 'old' } }), 'utf8');
      writeFileSync(join(dir, '.flectorc'), JSON.stringify({ defaults: { classifySecrets: true, maskSecrets: true } }), 'utf8');
      const run = spawnSync(process.execPath, [rootIndex, 'ci', 'app.yaml', '--snapshot-ref', 'snap.json', '--format', 'json'], {
        cwd: dir, encoding: 'utf8',
      });
      assert.ok(!run.stdout.includes(SLASH_SECRET), run.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('there is no way to load a model from disk', () => {
    // .flectorc is attacker-controlled on an untrusted pull request, and
    // deserializing an attacker-supplied model is the same class of hole as
    // loading their plugin (GHSA-wq8m-fc3q-8m5x). One shipped model, no path.
    const help = spawnSync(process.execPath, [rootIndex, 'ci', '--help'], { encoding: 'utf8' }).stdout;
    assert.doesNotMatch(help, /--classify-model|--nlp-model/);
  });
});
