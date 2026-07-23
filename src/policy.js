import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';

/**
 * @typedef {'info' | 'warn' | 'error'} PolicySeverity
 * @typedef {{
 *   id: string,
 *   severity: PolicySeverity,
 *   path: string,
 *   message: string,
 *   pack?: string
 * }} PolicyFinding
 *
 * @typedef {{
 *   id: string,
 *   severity: PolicySeverity,
 *   when?: Array<'added' | 'removed' | 'changed'>,
 *   match?: { path?: string, pathFlags?: string, pathEquals?: string, pathPrefix?: string },
 *   beforeEquals?: unknown,
 *   afterEquals?: unknown,
 *   beforeIn?: unknown[],
 *   afterIn?: unknown[],
 *   beforeTruthy?: true,
 *   afterTruthy?: true,
 *   afterMatches?: string,
 *   numericJump?: { minMultiple: number },
 *   numericDelta?: { min: number },
 *   allOf?: PolicyMatchClause[],
 *   anyOf?: PolicyMatchClause[],
 *   message?: string,
 *   messageTemplate?: string
 * }} PolicyRule
 *
 * @typedef {{
 *   match?: { path?: string, pathFlags?: string, pathEquals?: string, pathPrefix?: string },
 *   beforeEquals?: unknown,
 *   afterEquals?: unknown,
 *   beforeIn?: unknown[],
 *   afterIn?: unknown[],
 *   beforeTruthy?: true,
 *   afterTruthy?: true,
 *   afterMatches?: string,
 *   numericJump?: { minMultiple: number },
 *   numericDelta?: { min: number }
 * }} PolicyMatchClause
 *
 * @typedef {{ id: string, rules: PolicyRule[] }} PolicyPack
 *
 * @typedef {{
 *   cwd?: string,
 *   file?: string,
 *   profile?: string | null,
 *   source?: 'watch' | 'ci' | 'diff',
 *   policies?: string[],
 *   plugins?: string[]
 * }} PolicyEvalOptions
 */

const SEVERITY_RANK = { info: 1, warn: 2, error: 3 };
const PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'packs');
const RULE_FIELDS = new Set([
  'id', 'severity', 'when', 'match', 'beforeEquals', 'afterEquals',
  'beforeIn', 'afterIn', 'beforeTruthy', 'afterTruthy', 'numericJump',
  'afterMatches', 'numericDelta', 'allOf', 'anyOf', 'message', 'messageTemplate',
]);
const CLAUSE_FIELDS = new Set([
  'match', 'beforeEquals', 'afterEquals', 'beforeIn', 'afterIn',
  'beforeTruthy', 'afterTruthy', 'afterMatches', 'numericJump', 'numericDelta',
]);
const MATCH_FIELDS = new Set(['path', 'pathFlags', 'pathEquals', 'pathPrefix']);

/**
 * @param {string} cwd
 * @param {string} packId
 * @returns {string | null}
 */
function resolvePackPath(cwd, packId) {
  const localJson = resolve(cwd, 'policies', `${packId}.json`);
  const localYaml = resolve(cwd, 'policies', `${packId}.yaml`);
  const localYml = resolve(cwd, 'policies', `${packId}.yml`);
  if (existsSync(localJson)) return localJson;
  if (existsSync(localYaml)) return localYaml;
  if (existsSync(localYml)) return localYml;

  const builtinJson = join(PACKS_DIR, `${packId}.json`);
  if (existsSync(builtinJson)) return builtinJson;
  return null;
}

/**
 * @param {string} path
 * @returns {PolicyPack}
 */
function readPackFile(path) {
  const raw = readFileSync(path, 'utf8');
  const parsed = path.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rules)) {
    throw new Error(`Invalid policy pack at ${path}: expected { id, rules[] }`);
  }
  parsed.rules.forEach((rule, index) => validateRule(rule, `rules[${index}]`));
  return {
    id: String(parsed.id ?? ''),
    rules: parsed.rules,
  };
}

/**
 * Validate a rule or composition clause so pack typos fail closed at load time.
 * @param {unknown} candidate
 * @param {string} location
 * @param {boolean} [isClause]
 */
function validateRule(candidate, location, isClause = false) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error(`Invalid policy rule at ${location}: expected an object`);
  }

  const allowedFields = isClause ? CLAUSE_FIELDS : RULE_FIELDS;
  for (const key of Object.keys(candidate)) {
    if (!allowedFields.has(key)) {
      throw new Error(`Invalid policy rule at ${location}: unknown field "${key}"`);
    }
  }

  const rule = /** @type {Record<string, unknown>} */ (candidate);
  if (!isClause && (typeof rule.id !== 'string' || !rule.id)) {
    throw new Error(`Invalid policy rule at ${location}: id is required`);
  }
  if (rule.when !== undefined
    && (!Array.isArray(rule.when) || rule.when.some((type) => !['added', 'removed', 'changed'].includes(type)))) {
    throw new Error(`Invalid policy rule at ${location}: when must contain added, removed, or changed`);
  }
  validateMatch(rule.match, location);
  validateArrayPredicate(rule.beforeIn, 'beforeIn', location);
  validateArrayPredicate(rule.afterIn, 'afterIn', location);
  validateTruthyPredicate(rule.beforeTruthy, 'beforeTruthy', location);
  validateTruthyPredicate(rule.afterTruthy, 'afterTruthy', location);
  validateRegexPredicate(rule.afterMatches, 'afterMatches', location);
  validateNumericPredicate(rule.numericJump, 'numericJump', 'minMultiple', location, true);
  validateNumericPredicate(rule.numericDelta, 'numericDelta', 'min', location, false);

  if (!isClause) {
    validateComposition(rule.allOf, 'allOf', location);
    validateComposition(rule.anyOf, 'anyOf', location);
  }
}

/** @param {unknown} match @param {string} location */
function validateMatch(match, location) {
  if (match === undefined) return;
  if (!match || typeof match !== 'object' || Array.isArray(match)) {
    throw new Error(`Invalid policy rule at ${location}: match must be an object`);
  }
  for (const key of Object.keys(match)) {
    if (!MATCH_FIELDS.has(key)) {
      throw new Error(`Invalid policy rule at ${location}: unknown match field "${key}"`);
    }
  }
  const typedMatch = /** @type {Record<string, unknown>} */ (match);
  for (const key of MATCH_FIELDS) {
    if (typedMatch[key] !== undefined && typeof typedMatch[key] !== 'string') {
      throw new Error(`Invalid policy rule at ${location}: match.${key} must be a string`);
    }
  }
  if (typedMatch.path !== undefined) {
    try {
      new RegExp(typedMatch.path, typedMatch.pathFlags ?? '');
    } catch {
      throw new Error(`Invalid policy rule at ${location}: match.path is not a valid regular expression`);
    }
  }
}

/** @param {unknown} value @param {string} name @param {string} location */
function validateArrayPredicate(value, name, location) {
  if (value !== undefined && !Array.isArray(value)) {
    throw new Error(`Invalid policy rule at ${location}: ${name} must be an array`);
  }
}

/** @param {unknown} value @param {string} name @param {string} location */
function validateTruthyPredicate(value, name, location) {
  if (value !== undefined && value !== true) {
    throw new Error(`Invalid policy rule at ${location}: ${name} must be true`);
  }
}

/** @param {unknown} value @param {string} name @param {string} location */
function validateRegexPredicate(value, name, location) {
  if (value === undefined) return;
  if (typeof value !== 'string') {
    throw new Error(`Invalid policy rule at ${location}: ${name} must be a string`);
  }
  try {
    new RegExp(value);
  } catch {
    throw new Error(`Invalid policy rule at ${location}: ${name} is not a valid regular expression`);
  }
}

/** @param {unknown} value @param {string} name @param {string} property @param {string} location @param {boolean} positive */
function validateNumericPredicate(value, name, property, location, positive) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value[property] !== 'number' || !Number.isFinite(value[property])
    || (positive ? value[property] <= 0 : value[property] < 0)) {
    throw new Error(`Invalid policy rule at ${location}: ${name}.${property} must be a ${positive ? 'positive' : 'non-negative'} finite number`);
  }
}

/** @param {unknown} clauses @param {string} name @param {string} location */
function validateComposition(clauses, name, location) {
  if (clauses === undefined) return;
  if (!Array.isArray(clauses) || clauses.length === 0) {
    throw new Error(`Invalid policy rule at ${location}: ${name} must be a non-empty array of match clauses`);
  }
  clauses.forEach((clause, index) => validateRule(clause, `${location}.${name}[${index}]`, true));
}

/**
 * Load a pack by id from policies/ then built-ins.
 * @param {string} packId
 * @param {string} [cwd]
 * @returns {PolicyPack}
 */
export function loadPack(packId, cwd = process.cwd()) {
  const id = String(packId ?? '').trim();
  if (!id) throw new Error('Policy pack id is required');
  const path = resolvePackPath(cwd, id);
  if (!path) {
    throw new Error(`Unknown policy pack "${id}". Add policies/${id}.json or use a built-in pack.`);
  }
  const pack = readPackFile(path);
  if (!pack.id) pack.id = id;
  return pack;
}

/**
 * List built-in pack ids.
 * @returns {string[]}
 */
export function listBuiltinPackIds() {
  if (!existsSync(PACKS_DIR)) return [];
  return readdirSync(PACKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

/**
 * @param {PolicyRule} rule
 * @param {import('./differ.js').ChangeEvent} change
 * @returns {boolean}
 */
function ruleMatches(rule, change) {
  const when = rule.when ?? ['added', 'removed', 'changed'];
  if (!when.includes(change.type)) return false;
  if (!matchClause(rule, change)) return false;
  if (rule.allOf?.some((clause) => !matchClause(clause, change))) return false;
  if (rule.anyOf && !rule.anyOf.some((clause) => matchClause(clause, change))) return false;
  return true;
}

/**
 * @param {PolicyMatchClause} clause
 * @param {import('./differ.js').ChangeEvent} change
 * @returns {boolean}
 */
function matchClause(clause, change) {
  const path = change.path ?? '';
  const match = clause.match;
  if (match?.path && !new RegExp(match.path, match.pathFlags ?? '').test(path)) return false;
  if (match?.pathEquals !== undefined && path !== match.pathEquals) return false;
  if (match?.pathPrefix !== undefined && !path.startsWith(match.pathPrefix)) return false;

  if (Object.prototype.hasOwnProperty.call(clause, 'beforeEquals') && change.before !== clause.beforeEquals) return false;
  if (Object.prototype.hasOwnProperty.call(clause, 'afterEquals') && change.after !== clause.afterEquals) return false;
  if (clause.beforeIn && !clause.beforeIn.includes(change.before)) return false;
  if (clause.afterIn && !clause.afterIn.includes(change.after)) return false;
  if (clause.beforeTruthy && !change.before) return false;
  if (clause.afterTruthy && !change.after) return false;
  if (clause.afterMatches && (typeof change.after !== 'string' || !new RegExp(clause.afterMatches).test(change.after))) return false;

  if (clause.numericJump) {
    const before = change.before;
    const after = change.after;
    if (typeof before !== 'number' || typeof after !== 'number') return false;
    if (!(before > 0 && after >= before * clause.numericJump.minMultiple)) return false;
  }

  if (clause.numericDelta) {
    const before = change.before;
    const after = change.after;
    if (typeof before !== 'number' || typeof after !== 'number') return false;
    if (Math.abs(after - before) < clause.numericDelta.min) return false;
  }

  return true;
}

/**
 * @param {PolicyRule} rule
 * @param {import('./differ.js').ChangeEvent} change
 * @returns {string}
 */
function formatMessage(rule, change) {
  if (rule.messageTemplate) {
    return rule.messageTemplate
      .replaceAll('{before}', String(change.before))
      .replaceAll('{after}', String(change.after))
      .replaceAll('{path}', String(change.path ?? ''));
  }
  return rule.message ?? `Policy ${rule.id} matched`;
}

/**
 * @param {PolicyPack} pack
 * @param {import('./differ.js').ChangeEvent[]} changes
 * @returns {PolicyFinding[]}
 */
export function evaluatePack(pack, changes) {
  /** @type {PolicyFinding[]} */
  const findings = [];
  for (const change of changes) {
    for (const rule of pack.rules ?? []) {
      if (!ruleMatches(rule, change)) continue;
      findings.push({
        id: String(rule.id),
        severity: rule.severity ?? 'warn',
        path: change.path ?? '',
        message: formatMessage(rule, change),
        pack: pack.id,
      });
    }
  }
  return findings;
}

/**
 * Merge findings: same id+path keeps highest severity; ties keep first.
 * @param {PolicyFinding[]} findings
 * @returns {PolicyFinding[]}
 */
export function mergeFindings(findings) {
  /** @type {Map<string, PolicyFinding>} */
  const byKey = new Map();
  for (const finding of findings) {
    const key = `${finding.id}::${finding.path}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, finding);
      continue;
    }
    const nextRank = SEVERITY_RANK[finding.severity] ?? 0;
    const prevRank = SEVERITY_RANK[existing.severity] ?? 0;
    if (nextRank > prevRank) byKey.set(key, finding);
  }
  return [...byKey.values()];
}

/**
 * @param {string} pluginPath
 * @param {string} cwd
 * @returns {string}
 */
function resolvePluginPath(pluginPath, cwd) {
  if (/^https?:\/\//i.test(pluginPath)) {
    throw new Error(`Remote plugins are not allowed: ${pluginPath}`);
  }
  return isAbsolute(pluginPath) ? pluginPath : resolve(cwd, pluginPath);
}

/**
 * @param {string} pluginPath
 * @param {import('./differ.js').ChangeEvent[]} changes
 * @param {Required<Pick<PolicyEvalOptions, 'cwd' | 'file' | 'profile' | 'source'>> & { packIds: string[] }} ctx
 * @returns {Promise<PolicyFinding[]>}
 */
async function runPlugin(pluginPath, changes, ctx) {
  const abs = resolvePluginPath(pluginPath, ctx.cwd);
  if (!existsSync(abs)) {
    throw new Error(`Policy plugin not found: ${pluginPath}`);
  }
  const mod = await import(pathToFileURL(abs).href);
  if (typeof mod.evaluate !== 'function') {
    throw new Error(`Policy plugin missing export evaluate(): ${pluginPath}`);
  }
  const result = await mod.evaluate(changes, ctx);
  if (!Array.isArray(result)) {
    throw new Error(`Policy plugin must return PolicyFinding[]: ${pluginPath}`);
  }
  return result.map((f) => ({
    id: String(f.id),
    severity: f.severity,
    path: String(f.path ?? ''),
    message: String(f.message ?? ''),
    pack: f.pack ?? `plugin:${pluginPath}`,
  }));
}

/**
 * Evaluate active packs then plugins.
 * @param {import('./differ.js').ChangeEvent[]} changes
 * @param {PolicyEvalOptions} [options]
 * @returns {Promise<PolicyFinding[]>}
 */
export async function evaluatePolicies(changes, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const packIds = options.policies?.length ? options.policies : ['default'];
  const plugins = options.plugins ?? [];

  /** @type {PolicyFinding[]} */
  const findings = [];
  for (const packId of packIds) {
    const pack = loadPack(packId, cwd);
    findings.push(...evaluatePack(pack, changes));
  }

  const ctx = {
    cwd,
    file: options.file ?? '',
    profile: options.profile ?? null,
    source: options.source ?? 'watch',
    packIds,
  };

  for (const pluginPath of plugins) {
    findings.push(...await runPlugin(pluginPath, changes, ctx));
  }

  return mergeFindings(findings);
}

/**
 * @param {PolicyFinding[]} findings
 * @returns {PolicySeverity | null}
 */
export function highestSeverity(findings) {
  if (!findings || findings.length === 0) return null;
  if (findings.some((f) => f.severity === 'error')) return 'error';
  if (findings.some((f) => f.severity === 'warn')) return 'warn';
  return 'info';
}
