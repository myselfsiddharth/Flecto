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
 *   match?: { path?: string, pathFlags?: string },
 *   afterEquals?: unknown,
 *   numericJump?: { minMultiple: number },
 *   message?: string,
 *   messageTemplate?: string
 * }} PolicyRule
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
  return {
    id: String(parsed.id ?? ''),
    rules: parsed.rules,
  };
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
 * List every policy pack resolvable from a working directory. Local packs take
 * precedence over built-ins using the same order as loadPack().
 * @param {string} [cwd]
 * @returns {Array<{
 *   id: string,
 *   sourcePath: string,
 *   source: 'builtin' | 'local',
 *   ruleCount: number,
 *   overridesBuiltin: boolean
 * }>}
 */
export function listPolicyPacks(cwd = process.cwd()) {
  const localDir = resolve(cwd, 'policies');
  const localIds = existsSync(localDir)
    ? readdirSync(localDir)
      .filter((file) => /\.(json|yaml|yml)$/.test(file))
      .map((file) => file.replace(/\.(json|yaml|yml)$/, ''))
    : [];
  const builtinIds = listBuiltinPackIds();
  const builtinIdSet = new Set(builtinIds);

  return [...new Set([...builtinIds, ...localIds])]
    .sort()
    .map((id) => {
      const sourcePath = resolvePackPath(cwd, id);
      if (!sourcePath) {
        throw new Error(`Unable to resolve policy pack "${id}"`);
      }
      const pack = readPackFile(sourcePath);
      const isLocal = localIds.includes(id);
      return {
        id,
        sourcePath,
        source: isLocal ? 'local' : 'builtin',
        ruleCount: pack.rules.length,
        overridesBuiltin: isLocal && builtinIdSet.has(id),
      };
    });
}

/**
 * @param {PolicyRule} rule
 * @param {import('./differ.js').ChangeEvent} change
 * @returns {boolean}
 */
function ruleMatches(rule, change) {
  const when = rule.when ?? ['added', 'removed', 'changed'];
  if (!when.includes(change.type)) return false;

  if (rule.match?.path) {
    const flags = rule.match.pathFlags ?? '';
    const re = new RegExp(rule.match.path, flags);
    if (!re.test(change.path ?? '')) return false;
  }

  if (Object.prototype.hasOwnProperty.call(rule, 'afterEquals')) {
    if (change.after !== rule.afterEquals) return false;
  }

  if (rule.numericJump) {
    const before = change.before;
    const after = change.after;
    if (typeof before !== 'number' || typeof after !== 'number') return false;
    if (!(before > 0 && after >= before * rule.numericJump.minMultiple)) return false;
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
