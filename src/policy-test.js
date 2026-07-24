import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

import { diffTrees } from './differ.js';
import { parseFile } from './parser.js';
import { evaluatePolicies } from './policy.js';

const DEFAULT_CONFIG_NAME = 'flecto-policy-test.json';

function readJson(path, label) {
  if (!existsSync(path)) {
    throw new Error(`Policy fixture ${label} not found: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Policy fixture ${label} is not valid JSON: ${path}: ${err.message}`);
  }
}

function validateExpectedFinding(finding, index) {
  if (!finding || typeof finding !== 'object') {
    throw new Error(`Policy fixture expected[${index}] must be an object`);
  }
  for (const field of ['id', 'severity', 'path']) {
    if (typeof finding[field] !== 'string' || !finding[field]) {
      throw new Error(`Policy fixture expected[${index}].${field} must be a non-empty string`);
    }
  }
}

function findingKey(finding) {
  return `${finding.id}\u0000${finding.severity}\u0000${finding.path}`;
}

function displayFinding(finding) {
  return `${finding.severity} ${finding.id} at ${finding.path}`;
}

/**
 * Compare findings by id, severity, and path, ignoring messages and pack labels.
 * @param {import('./policy.js').PolicyFinding[]} actual
 * @param {Array<{id: string, severity: string, path: string}>} expected
 */
export function assertExpectedFindings(actual, expected) {
  const expectedByKey = new Map();
  const actualByKey = new Map();
  for (const finding of expected) {
    const key = findingKey(finding);
    expectedByKey.set(key, (expectedByKey.get(key) ?? 0) + 1);
  }
  for (const finding of actual) {
    const key = findingKey(finding);
    actualByKey.set(key, (actualByKey.get(key) ?? 0) + 1);
  }

  const missing = [];
  const unexpected = [];
  for (const finding of expected) {
    const key = findingKey(finding);
    if ((actualByKey.get(key) ?? 0) > 0) {
      actualByKey.set(key, actualByKey.get(key) - 1);
    } else {
      missing.push(finding);
    }
  }
  for (const finding of actual) {
    const key = findingKey(finding);
    if ((expectedByKey.get(key) ?? 0) > 0) {
      expectedByKey.set(key, expectedByKey.get(key) - 1);
    } else {
      unexpected.push(finding);
    }
  }

  if (missing.length === 0 && unexpected.length === 0) return;

  const lines = ['Policy fixture findings did not match.'];
  if (missing.length > 0) {
    lines.push('Missing findings:');
    lines.push(...missing.map((finding) => `  - ${displayFinding(finding)}`));
  }
  if (unexpected.length > 0) {
    lines.push('Unexpected findings:');
    lines.push(...unexpected.map((finding) => `  - ${displayFinding(finding)}`));
  }
  throw new Error(lines.join('\n'));
}

/**
 * Run a policy fixture stored in a directory.
 * @param {string} fixtureDir
 * @param {{ configName?: string }} [options]
 */
export async function testPolicyFixture(fixtureDir, options = {}) {
  const dir = resolve(fixtureDir);
  const configName = options.configName ?? DEFAULT_CONFIG_NAME;
  const configPath = join(dir, configName);
  const config = readJson(configPath, 'config');
  if (!Array.isArray(config.expected)) {
    throw new Error(`Policy fixture config must contain an expected array: ${configPath}`);
  }
  config.expected.forEach(validateExpectedFinding);

  const baselinePath = resolve(dir, config.baseline ?? 'baseline.json');
  const currentPath = resolve(dir, config.current ?? 'current.json');
  const baseline = readJson(baselinePath, 'baseline');
  if (!existsSync(currentPath)) {
    throw new Error(`Policy fixture current file not found: ${currentPath}`);
  }

  const changes = diffTrees(baseline.state ?? baseline, parseFile(currentPath));
  const findings = await evaluatePolicies(changes, {
    cwd: dir,
    file: currentPath,
    profile: config.profile ?? null,
    source: config.source ?? 'ci',
    policies: config.policies,
    plugins: config.plugins,
  });
  assertExpectedFindings(findings, config.expected);

  return { fixtureDir: dir, changes, findings };
}
