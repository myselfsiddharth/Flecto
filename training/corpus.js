import { MIN_CLASSIFIER_LENGTH } from '../src/classifier-features.js';

/**
 * Deterministic synthesis of the training corpus for the secret classifier.
 *
 * There is no corpus to train on and we cannot collect one: user configuration
 * files are the last thing this project should be gathering (#136, and #113 was
 * a sensitive-value leak). So every example here is either synthesized from a
 * seeded generator or written out by hand, and the file is the provenance
 * record -- if a class of value is in the model, it is visible here.
 *
 * Everything is seeded and ordered. Running this on any machine, at any time,
 * produces byte-identical output, which is what lets the shipped weights be
 * regenerated from a clean checkout and diffed.
 *
 * Nothing in `training/` is published; see the `files` field in package.json.
 */

/**
 * xorshift128, seeded. Node's Math.random cannot be seeded, and a corpus that
 * changes between runs makes the weights unreproducible -- which for a security
 * tool is the difference between an auditable artifact and a magic number.
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
export function seededRandom(seed = 0x5eed1234) {
  let x = seed >>> 0 || 1;
  let y = 0x9e3779b9;
  let z = 0x243f6a88;
  let w = 0xb7e15162;
  return () => {
    const t = x ^ (x << 11);
    x = y; y = z; z = w;
    w = (w ^ (w >>> 19)) ^ (t ^ (t >>> 8));
    return (w >>> 0) / 0x100000000;
  };
}

const ALPHABETS = {
  // Standard base64, including `+` and `/`. The `/` is the point: the entropy
  // gate's charset check excludes it so that hostnames and paths can never be
  // candidates, which means these secrets are missed *by construction*. They
  // are the single largest known gap the classifier exists to close.
  base64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  base64url: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
  base62: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  hex: '0123456789abcdef',
  hexUpper: '0123456789ABCDEF',
  base32: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
};

/**
 * @param {() => number} rand
 * @param {string} alphabet
 * @param {number} length
 * @returns {string}
 */
function randomFrom(rand, alphabet, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}

/** @param {() => number} rand @param {number} min @param {number} max */
function randInt(rand, min, max) {
  return min + Math.floor(rand() * (max - min + 1));
}

/** @param {() => number} rand @param {string[]} list */
function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

const WORDS = [
  'prod', 'staging', 'dev', 'customer', 'success', 'dashboard', 'gateway', 'vpn',
  'acme', 'service', 'cluster', 'region', 'east', 'west', 'north', 'south',
  'config', 'settings', 'primary', 'replica', 'backup', 'ingress', 'egress',
  'payments', 'billing', 'identity', 'search', 'catalog', 'inventory', 'orders',
  'analytics', 'reporting', 'scheduler', 'worker', 'queue', 'cache', 'session',
  'frontend', 'backend', 'internal', 'external', 'public', 'private', 'shared',
  'metrics', 'logging', 'tracing', 'alerting', 'monitor', 'health', 'probe',
];

const IMAGE_NAMES = ['nginx', 'redis', 'postgres', 'node', 'python', 'golang', 'alpine', 'ubuntu', 'busybox'];
const REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-2', 'eu-central-1'];
const TLDS = ['com', 'io', 'net', 'org', 'internal', 'local', 'svc.cluster.local'];

/**
 * Key material, in the encodings that actually appear in configuration.
 *
 * Deliberately *not* prefixed with a vendor marker: anything carrying a known
 * prefix is already caught by the format detectors, never reaches the
 * classifier, and training on it would only teach the model to recognize
 * something it is never shown.
 *
 * **Hex and base32 are deliberately excluded**, although #136 lists them.
 * A 40-character lowercase-hex secret and a git SHA are the same alphabet, the
 * same length, and the same entropy; an uppercase base32 secret and a TOTP seed
 * likewise. They are not hard to tell apart -- they are *undecidable* from the
 * value alone, and the issue's own negatives list names git SHAs. Training on
 * them could only buy recall by spending the zero-false-positive floor, which
 * is the one thing #136 says not to trade. The entropy gate excludes them for
 * exactly the same reason (its "needs upper and lower and digit" rule), and
 * this is that judgement being kept rather than quietly reversed.
 *
 * What is left is the genuinely decidable gap: mixed-case base64 shapes, above
 * all the standard-base64 ones carrying `/` that the charset gate cannot see.
 * @param {() => number} rand
 * @param {number} count
 * @returns {string[]}
 */
export function generateSecrets(rand, count) {
  /** @type {string[]} */
  const out = [];
  const kinds = ['base64', 'base64url', 'base62'];
  for (let i = 0; i < count; i += 1) {
    const kind = kinds[i % kinds.length];
    // Short tokens are where the entropy gate's recall is worst (~7% missed at
    // 24), so the corpus is weighted toward them rather than spread evenly.
    const length = rand() < 0.55 ? randInt(rand, 20, 32) : randInt(rand, 33, 64);
    let value = randomFrom(rand, ALPHABETS[kind], length);
    // Real base64 is padded about as often as not.
    if ((kind === 'base64' || kind === 'base64url') && rand() < 0.3) {
      value = `${value}${rand() < 0.5 ? '=' : '=='}`;
    }
    out.push(value);
  }
  return out;
}

/**
 * Benign configuration values, concentrated on the shapes that are hardest to
 * tell from key material.
 *
 * The three named in the issue header as the residual false-positive classes of
 * the current heuristic -- `CustomerSuccessDashboard2026`,
 * `AcmeVpnGateway01Prod`, `PRODUCTION_us_east_1_Config2024` -- are generated
 * here as families rather than as three literals, so the model is pushed on the
 * whole shape and not on three strings it could memorize.
 * @param {() => number} rand
 * @param {number} count
 * @returns {string[]}
 */
export function generateBenign(rand, count) {
  /** @type {string[]} */
  const out = [];
  /** @type {Array<(r: () => number) => string>} */
  const shapes = [
    // PascalCase identifiers with a year: CustomerSuccessDashboard2026
    (r) => `${pick(r, WORDS)}${cap(pick(r, WORDS))}${cap(pick(r, WORDS))}${randInt(r, 2019, 2030)}`,
    // Vendor-ish product names with an ordinal: AcmeVpnGateway01Prod
    (r) => `${cap(pick(r, WORDS))}${cap(pick(r, WORDS))}${String(randInt(r, 0, 99)).padStart(2, '0')}${cap(pick(r, WORDS))}`,
    // SCREAMING_SNAKE with embedded region: PRODUCTION_us_east_1_Config2024
    (r) => `${pick(r, WORDS).toUpperCase()}_${pick(r, REGIONS).replaceAll('-', '_')}_${cap(pick(r, WORDS))}${randInt(r, 2019, 2030)}`,
    // UUIDs, both cases
    (r) => uuid(r),
    (r) => uuid(r).toUpperCase(),
    // Subresource integrity
    (r) => `sha512-${randomFrom(r, ALPHABETS.base64, 86)}==`,
    (r) => `sha256-${randomFrom(r, ALPHABETS.base64, 43)}=`,
    // git SHAs
    (r) => randomFrom(r, ALPHABETS.hex, 40),
    (r) => randomFrom(r, ALPHABETS.hex, 7),
    // container image refs, with and without digest
    (r) => `${pick(r, IMAGE_NAMES)}:${randInt(r, 1, 24)}.${randInt(r, 0, 20)}.${randInt(r, 0, 9)}-alpine`,
    (r) => `${pick(r, IMAGE_NAMES)}@sha256:${randomFrom(r, ALPHABETS.hex, 64)}`,
    (r) => `registry.${pick(r, TLDS)}/${pick(r, WORDS)}/${pick(r, IMAGE_NAMES)}:${randInt(r, 1, 9)}.${randInt(r, 0, 20)}`,
    // ARNs
    (r) => `arn:aws:iam::${randInt(r, 100000000000, 999999999999)}:role/${cap(pick(r, WORDS))}${cap(pick(r, WORDS))}`,
    (r) => `arn:aws:s3:::${pick(r, WORDS)}-${pick(r, WORDS)}-${randInt(r, 1, 999)}`,
    // ISO-8601 timestamps
    (r) => `${randInt(r, 2019, 2030)}-${pad2(randInt(r, 1, 12))}-${pad2(randInt(r, 1, 28))}T${pad2(randInt(r, 0, 23))}:${pad2(randInt(r, 0, 59))}:${pad2(randInt(r, 0, 59))}Z`,
    // hostnames and URLs
    (r) => `${pick(r, WORDS)}-${pick(r, WORDS)}.${pick(r, WORDS)}.${pick(r, TLDS)}`,
    (r) => `https://${pick(r, WORDS)}.${pick(r, TLDS)}/${pick(r, WORDS)}/${pick(r, WORDS)}`,
    (r) => `postgres://${pick(r, WORDS)}.${pick(r, TLDS)}:5432/${pick(r, WORDS)}`,
    // filesystem paths
    (r) => `/var/lib/${pick(r, WORDS)}/${pick(r, WORDS)}/${pick(r, WORDS)}.conf`,
    (r) => `./${pick(r, WORDS)}/${pick(r, WORDS)}-${pick(r, WORDS)}.yaml`,
    // versions and semver ranges
    (r) => `${randInt(r, 0, 12)}.${randInt(r, 0, 40)}.${randInt(r, 0, 20)}`,
    (r) => `^${randInt(r, 0, 12)}.${randInt(r, 0, 40)}.${randInt(r, 0, 20)}-rc.${randInt(r, 1, 9)}`,
    // kebab and snake identifiers
    (r) => `${pick(r, WORDS)}-${pick(r, WORDS)}-${pick(r, WORDS)}-${randInt(r, 1, 99)}`,
    (r) => `${pick(r, WORDS)}_${pick(r, WORDS)}_${pick(r, WORDS)}_${randInt(r, 1, 99)}`,
    // camelCase config keys and values
    (r) => `${pick(r, WORDS)}${cap(pick(r, WORDS))}${cap(pick(r, WORDS))}`,
    // base64 of ordinary text -- an encoded config blob, not key material
    (r) => Buffer.from(`${pick(r, WORDS)} ${pick(r, WORDS)} ${pick(r, WORDS)} ${pick(r, WORDS)} ${randInt(r, 1, 9999)}`).toString('base64'),
    // JSON-ish and templated values
    (r) => `\${${pick(r, WORDS).toUpperCase()}_${pick(r, WORDS).toUpperCase()}}`,
    (r) => `${pick(r, WORDS)}.${pick(r, WORDS)}.${pick(r, WORDS)}`,
    // email-ish and k8s resource names
    (r) => `${pick(r, WORDS)}-${pick(r, WORDS)}@${pick(r, WORDS)}.${pick(r, TLDS)}`,
    (r) => `${pick(r, WORDS)}-${randomFrom(r, ALPHABETS.base32.toLowerCase(), 10)}-${randomFrom(r, 'abcdefghijklmnopqrstuvwxyz', 5)}`,
    // --- Hard negatives, all >= 24 characters -----------------------------
    // These are the shapes that survive into the classifier's operating band
    // and still look like key material. Found by scoring the holdout and
    // reading what came out on top, which is the only honest way to pick them.
    //
    // Opaque public identifiers: a Google Place ID is mixed-case base64url of
    // exactly the length and charset of a token, and is not a credential. The
    // existing entropy gate flags these too.
    (r) => `ChIJ${randomFrom(r, ALPHABETS.base64url, randInt(r, 19, 23))}`,
    (r) => `EAI${randomFrom(r, ALPHABETS.base64url, randInt(r, 21, 30))}`,
    // Long PascalCase and SCREAMING_SNAKE names that clear the length gate.
    (r) => `${cap(pick(r, WORDS))}${cap(pick(r, WORDS))}${cap(pick(r, WORDS))}${cap(pick(r, WORDS))}`,
    (r) => `${pick(r, WORDS).toUpperCase()}_${pick(r, WORDS).toUpperCase()}_${pick(r, WORDS).toUpperCase()}_${randInt(r, 2019, 2030)}`,
    // A bare JWT header, which is base64 of JSON rather than key material.
    (r) => Buffer.from(JSON.stringify({ alg: pick(r, ['HS256', 'RS256', 'ES256']), typ: 'JWT' })).toString('base64url'),
    // Long dotted / slashed identifiers: the charset gate excludes these, so
    // the classifier is the only thing that could wrongly flag them.
    (r) => `${pick(r, WORDS)}/${pick(r, WORDS)}/${pick(r, WORDS)}/${pick(r, WORDS)}`,
    (r) => `${pick(r, WORDS)}.${pick(r, WORDS)}.${pick(r, WORDS)}.${pick(r, WORDS)}.${pick(r, WORDS)}`,
    (r) => `/api/v${randInt(r, 1, 3)}/${pick(r, WORDS)}/${pick(r, WORDS)}/${pick(r, WORDS)}`,
    // Base64 of readable text, at classifier length.
    (r) => Buffer.from(`${pick(r, WORDS)}-${pick(r, WORDS)}-${pick(r, WORDS)}-${pick(r, WORDS)}`).toString('base64'),
    // Long cron, duration, and range expressions.
    (r) => `${randInt(r, 0, 59)} ${randInt(r, 0, 23)} * * ${randInt(r, 0, 6)} ${pick(r, WORDS)}-${pick(r, WORDS)}`,
    // Connection strings without credentials.
    (r) => `mongodb://${pick(r, WORDS)}.${pick(r, TLDS)}:27017/${pick(r, WORDS)}?replicaSet=${pick(r, WORDS)}`,
  ];
  for (let i = 0; i < count; i += 1) {
    out.push(shapes[i % shapes.length](rand));
  }
  return out;
}

/** @param {string} word */
function cap(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** @param {number} n */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** @param {() => number} rand */
function uuid(rand) {
  const h = (n) => randomFrom(rand, ALPHABETS.hex, n);
  return `${h(8)}-${h(4)}-4${h(3)}-a${h(3)}-${h(12)}`;
}

/**
 * Hand-written values that must never be flagged, whatever the model learns.
 *
 * These are the cases a reviewer would name if asked "what would embarrass us",
 * so they are asserted directly rather than trusted to the generated
 * distribution. They are held out of training and used only for evaluation --
 * a model that gets these right because it memorized them proves nothing.
 * @returns {string[]}
 */
export function benignHoldout() {
  return [
    'CustomerSuccessDashboard2026',
    'AcmeVpnGateway01Prod',
    'PRODUCTION_us_east_1_Config2024',
    'ThisIsAVeryLongDescriptiveSettingName',
    'kubernetes.default.svc.cluster.local',
    'sha512-K7l9YJdCPDKPmSIGdlDZLjvXvHPDDTjqqyMMDpJHnyqxyrTVLSVDCUdhAydAeSGNVlBRqVbqNdlBH1qBxPGEKw==',
    'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    '2026-09-22T07:57:47.138Z',
    'arn:aws:iam::123456789012:role/FlectoDeploymentRole',
    'registry.example.com/platform/api-gateway:2.14.3-alpine',
    'postgres://reporting.internal:5432/analytics',
    '/var/lib/flecto/snapshots/production.json',
    'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    'ap-southeast-2',
    'application/vnd.api+json',
    'no-cache, no-store, must-revalidate',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'ChIJN1t_tDeuEmsRUsoyG83frY4',
    'us-east-1a,us-east-1b,us-east-1c',
    'HorizontalPodAutoscaler',
    'IfNotPresent',
    'RollingUpdate',
    '0 */6 * * *',
    'P1Y2M10DT2H30M',
    '255.255.255.0',
    'fe80::1ff:fe23:4567:890a',
    'text/html; charset=utf-8',
  ];
}

/**
 * Key material that must be caught, held out of training.
 *
 * Generated with a different seed from the training set so it is genuinely
 * unseen, and weighted toward the two gaps the issue names: standard base64
 * carrying `/`, and short tokens.
 * @returns {string[]}
 */
export function secretHoldout() {
  const rand = seededRandom(0xc0ffee42);
  /** @type {string[]} */
  const out = [];
  // The `/`-containing shapes the charset gate can never see.
  for (let i = 0; i < 150; i += 1) {
    let value = randomFrom(rand, ALPHABETS.base64, randInt(rand, 24, 48));
    if (!value.includes('/')) {
      const at = randInt(rand, 1, value.length - 2);
      value = `${value.slice(0, at)}/${value.slice(at + 1)}`;
    }
    out.push(value);
  }
  out.push(...generateSecrets(rand, 350));
  return out;
}



/**
 * The full training set, labelled. Ordered and deterministic.
 *
 * Filtered to the operating band: a model is trained on the population it will
 * be asked about, or its decision boundary is fitted to values it will never
 * see.
 * @param {{ secrets?: number, benign?: number, seed?: number }} [options]
 * @returns {{ values: string[], labels: number[] }}
 */
export { MIN_CLASSIFIER_LENGTH };

export function trainingSet(options = {}) {
  const rand = seededRandom(options.seed ?? 0x5eed1234);
  const long = (value) => value.length >= MIN_CLASSIFIER_LENGTH;
  const secrets = generateSecrets(rand, options.secrets ?? 8000).filter(long);
  const benign = generateBenign(rand, options.benign ?? 12000).filter(long);
  return {
    values: [...secrets, ...benign],
    labels: [...secrets.map(() => 1), ...benign.map(() => 0)],
  };
}
