import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';
import { containsSecret } from './secrets.js';

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
 *   beforeLooksSecret?: true,
 *   afterLooksSecret?: true,
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
 *   beforeLooksSecret?: true,
 *   afterLooksSecret?: true,
 *   afterMatches?: string,
 *   numericJump?: { minMultiple: number },
 *   numericDelta?: { min: number }
 * }} PolicyMatchClause
 *
 * @typedef {{ id: string, expandSubtrees?: boolean, rules: PolicyRule[] }} PolicyPack
 *
 * @typedef {{
 *   id: string,
 *   packageName: string,
 *   packageVersion: string | null,
 *   packFile: string,
 *   targetPath: string,
 *   ruleCount: number,
 *   overwritten: boolean,
 *   overridesBuiltin: boolean,
 *   shadowed: string[],
 *   shipsCode: boolean
 * }} AddedPolicyPack
 *
 * @typedef {{
 *   cwd?: string,
 *   file?: string,
 *   profile?: string | null,
 *   source?: 'watch' | 'ci' | 'diff',
 *   policies?: string[],
 *   plugins?: string[],
 *   severityRemap?: Record<string, PolicySeverity | 'off'>
 * }} PolicyEvalOptions
 */

const SEVERITY_RANK = { info: 1, warn: 2, error: 3 };
const PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'packs');
const CHANGE_TYPES = new Set(['added', 'removed', 'changed']);
const RULE_FIELDS = new Set([
  'id', 'severity', 'when', 'match', 'beforeEquals', 'afterEquals',
  'beforeIn', 'afterIn', 'beforeTruthy', 'afterTruthy', 'numericJump',
  'beforeLooksSecret', 'afterLooksSecret',
  'afterMatches', 'numericDelta', 'allOf', 'anyOf', 'message', 'messageTemplate',
]);
const CLAUSE_FIELDS = new Set([
  'match', 'beforeEquals', 'afterEquals', 'beforeIn', 'afterIn',
  'beforeTruthy', 'afterTruthy', 'beforeLooksSecret', 'afterLooksSecret',
  'afterMatches', 'numericJump', 'numericDelta',
]);
const MATCH_FIELDS = new Set(['path', 'pathFlags', 'pathEquals', 'pathPrefix']);
// Community distribution convention: an npm package named flecto-pack-<id>
// carrying a declarative pack file. Nothing in such a package is ever imported.
const PACK_PACKAGE_PREFIX = 'flecto-pack-';
const PACK_FILE_CANDIDATES = ['flecto-pack.json', 'flecto-pack.yaml', 'flecto-pack.yml'];
const PACK_EXTENSIONS = ['.json', '.yaml', '.yml'];
const PACK_MANIFEST_FILE = '.flecto-packs.json';
const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * @param {string} path
 * @param {string} message
 * @returns {never}
 */
function invalidPack(path, message) {
  throw new Error(`Invalid policy pack at ${path}: ${message}`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isTruthyToggle(value) {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return ['true', '1', 'yes'].includes(value.trim().toLowerCase());
}

/**
 * Validate a parsed policy pack and reject typos before evaluation.
 * @param {unknown} pack
 * @param {string} path
 * @returns {asserts pack is PolicyPack}
 */
function validatePack(pack, path) {
  if (!isObject(pack)) invalidPack(path, 'pack must be an object');

  const packFields = new Set(['id', 'expandSubtrees', 'rules']);
  for (const field of Object.keys(pack)) {
    if (!packFields.has(field)) invalidPack(path, `pack.${field} is not allowed`);
  }
  if (Object.hasOwn(pack, 'id') && (typeof pack.id !== 'string' || !pack.id.trim())) {
    invalidPack(path, 'pack.id must be a non-empty string');
  }
  if (Object.hasOwn(pack, 'expandSubtrees') && typeof pack.expandSubtrees !== 'boolean') {
    invalidPack(path, 'pack.expandSubtrees must be a boolean');
  }
  if (!Array.isArray(pack.rules)) invalidPack(path, 'pack.rules must be an array');

  for (const [index, rule] of pack.rules.entries()) {
    try {
      validateRule(rule, `rules[${index}]`);
    } catch (error) {
      const label = isObject(rule) && typeof rule.id === 'string' && rule.id
        ? `rule "${rule.id}"`
        : `rules[${index}]`;
      const message = error.message.replace(/^Invalid policy rule at [^:]+: /, '')
        .replace(/^unknown field "([^"]+)"$/, '$1 is not allowed (unknown field "$1")')
        .replace(/^unknown match field "([^"]+)"$/, 'match.$1 is not allowed (unknown match field "$1")')
        .replace(/^match\.path is not a valid regular expression$/, 'match.path must be a valid regular expression');
      invalidPack(path, `${label}.${message}`);
    }
  }
}

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
 * @param {string} fallbackId
 * @returns {PolicyPack}
 */
function readPackFile(path, fallbackId) {
  const raw = readFileSync(path, 'utf8');
  let parsed;
  try {
    parsed = path.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);
  } catch (error) {
    invalidPack(path, `could not parse file (${error.message})`);
  }
  validatePack(parsed, path);
  return { ...parsed, id: parsed.id ?? fallbackId };
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
  if (!isClause && (!Object.hasOwn(rule, 'severity') || !Object.hasOwn(SEVERITY_RANK, rule.severity))) {
    throw new Error(`Invalid policy rule at ${location}: severity must be one of: info, warn, error`);
  }
  if (rule.when !== undefined
    && (!Array.isArray(rule.when) || rule.when.length === 0 || rule.when.some((type) => !CHANGE_TYPES.has(type)))) {
    const invalidIndex = Array.isArray(rule.when)
      ? rule.when.findIndex((type) => !CHANGE_TYPES.has(type))
      : -1;
    throw new Error(`Invalid policy rule at ${location}: when${invalidIndex >= 0 ? `[${invalidIndex}]` : ''} must be one of: added, removed, changed`);
  }
  validateMatch(rule.match, location);
  validateArrayPredicate(rule.beforeIn, 'beforeIn', location);
  validateArrayPredicate(rule.afterIn, 'afterIn', location);
  validateTruthyPredicate(rule.beforeTruthy, 'beforeTruthy', location);
  validateTruthyPredicate(rule.afterTruthy, 'afterTruthy', location);
  validateTruthyPredicate(rule.beforeLooksSecret, 'beforeLooksSecret', location);
  validateTruthyPredicate(rule.afterLooksSecret, 'afterLooksSecret', location);
  validateRegexPredicate(rule.afterMatches, 'afterMatches', location);
  validateNumericPredicate(rule.numericJump, 'numericJump', 'minMultiple', location, true);
  validateNumericPredicate(rule.numericDelta, 'numericDelta', 'min', location, false);
  for (const name of ['message', 'messageTemplate']) {
    if (rule[name] !== undefined && typeof rule[name] !== 'string') {
      throw new Error(`Invalid policy rule at ${location}: ${name} must be a string`);
    }
  }

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
      if (typedMatch.pathFlags !== undefined) {
        try {
          new RegExp('(?:)', typedMatch.pathFlags);
        } catch {
          throw new Error(`Invalid policy rule at ${location}: match.pathFlags must be valid regular expression flags`);
        }
      }
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
 * Loaded, validated, and regex-compiled packs, keyed by cwd + resolved file
 * path + that file's mtime. `evaluatePolicies()` calls loadPack() once per
 * file in `ci` and once per change event in `watch`; this cache turns every
 * repeat call for an unchanged pack file into a Map lookup instead of a
 * `readFileSync` + `JSON.parse` + full schema walk.
 *
 * The key deliberately does *not* memoize on packId alone:
 * - Including the resolved path means a local `policies/<id>.json` that
 *   starts shadowing a built-in (or stops shadowing it) after this process
 *   started is picked up on the very next call, because resolvePackPath()
 *   runs fresh every time and produces a different path.
 * - Including cwd keeps two different working directories (e.g. two
 *   in-process callers, or tests) from ever sharing a cache slot merely
 *   because they happened to load the same-named local pack.
 * - Including mtimeMs means editing policies/<id>.json mid-`watch` changes
 *   the key, so the very next change event re-reads and re-validates the
 *   file rather than serving the stale in-memory pack. A pack that fails to
 *   parse or validate throws exactly as before — nothing here catches or
 *   downgrades that error into "serve the last cached pack", which would
 *   quietly defeat watch mode's fail-closed behavior on a bad edit.
 * @type {Map<string, PolicyPack>}
 */
const packCache = new Map();

/**
 * @param {string} cwd
 * @param {string} path
 * @param {number} mtimeMs
 * @returns {string}
 */
function packCacheKey(cwd, path, mtimeMs) {
  return `${resolve(cwd)}\u0000${path}\u0000${mtimeMs}`;
}

/**
 * Load a pack by id from policies/ then built-ins.
 *
 * severityRemap is intentionally not part of this function or its cache: it
 * is applied per profile, downstream, in evaluatePack(). Caching happens at
 * this layer — below any remapping — so the object returned here is the same
 * regardless of which profile asked for it, and one profile's remap can
 * never leak into another's findings.
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

  const mtimeMs = statSync(path).mtimeMs;
  const cacheKey = packCacheKey(cwd, path, mtimeMs);
  const cached = packCache.get(cacheKey);
  if (cached) return cached;

  const pack = readPackFile(path, id);
  compilePackRegexes(pack);
  packCache.set(cacheKey, pack);
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
 * Read the sidecar record of packs installed by `flecto policies add`. The
 * record is provenance only: pack resolution never consults it.
 * @param {string} cwd
 * @returns {Record<string, { package: string, version: string | null, addedAt: string }>}
 */
function readPackManifest(cwd) {
  const manifestPath = resolve(cwd, 'policies', PACK_MANIFEST_FILE);
  if (!existsSync(manifestPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return isObject(parsed?.packs) ? parsed.packs : {};
  } catch {
    // Provenance is a nicety; a corrupt sidecar must never break listing.
    return {};
  }
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
 *   overridesBuiltin: boolean,
 *   package?: string
 * }>}
 */
export function listPolicyPacks(cwd = process.cwd()) {
  const localDir = resolve(cwd, 'policies');
  const localIds = existsSync(localDir)
    ? readdirSync(localDir)
      // Hidden files are never pack ids — this is where the sidecar lives.
      .filter((file) => !file.startsWith('.') && /\.(json|yaml|yml)$/.test(file))
      .map((file) => file.replace(/\.(json|yaml|yml)$/, ''))
    : [];
  const manifest = readPackManifest(cwd);
  const builtinIds = listBuiltinPackIds();
  const builtinIdSet = new Set(builtinIds);

  return [...new Set([...builtinIds, ...localIds])]
    .sort()
    .map((id) => {
      const sourcePath = resolvePackPath(cwd, id);
      if (!sourcePath) {
        throw new Error(`Unable to resolve policy pack "${id}"`);
      }
      const pack = readPackFile(sourcePath, id);
      const isLocal = localIds.includes(id);
      const packageName = isLocal && typeof manifest[id]?.package === 'string'
        ? manifest[id].package
        : null;
      return {
        id,
        sourcePath,
        source: isLocal ? 'local' : 'builtin',
        ruleCount: pack.rules.length,
        overridesBuiltin: isLocal && builtinIdSet.has(id),
        // Present only for packs installed from npm, so hand-written local
        // packs keep the exact shape they have always had.
        ...(packageName ? { package: packageName } : {}),
      };
    });
}

/**
 * Map either form of a pack name onto the other: the short pack id
 * (`deployment-safety`) and the npm package name
 * (`flecto-pack-deployment-safety`, optionally scoped).
 * @param {string} name
 * @returns {{ id: string, packageName: string }}
 */
export function normalizePackPackageName(name) {
  const raw = String(name ?? '').trim();
  if (!raw) throw new Error('Policy pack name is required');

  const scopeMatch = /^(@[^/]+\/)(.+)$/.exec(raw);
  const scope = scopeMatch ? scopeMatch[1] : '';
  const rest = scopeMatch ? scopeMatch[2] : raw;
  const id = rest.startsWith(PACK_PACKAGE_PREFIX) ? rest.slice(PACK_PACKAGE_PREFIX.length) : rest;

  // The id becomes a filename under policies/, so it must be a plain segment.
  if (!PACK_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid policy pack name "${raw}". Use a pack id such as "deployment-safety" or a package name such as "flecto-pack-deployment-safety".`,
    );
  }
  return { id, packageName: `${scope}${PACK_PACKAGE_PREFIX}${id}` };
}

/**
 * Locate an installed pack package without loading any of its code.
 * @param {string} packageName
 * @param {string} cwd
 * @returns {string | null} Absolute package directory, or null when not installed.
 */
function resolvePackPackageDir(packageName, cwd) {
  // resolve() only computes a path; it never evaluates the target.
  const require = createRequire(join(resolve(cwd), 'package.json'));
  try {
    return dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    // A package with an "exports" map that omits ./package.json still has one
    // on disk, so fall back to the plain node_modules lookup.
  }

  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, 'node_modules', ...packageName.split('/'), 'package.json');
    if (existsSync(candidate)) return dirname(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * @param {string} packageDir
 * @param {string} packageName
 * @returns {Record<string, unknown>}
 */
function readPackagePackageJson(packageDir, packageName) {
  try {
    const parsed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    return isObject(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(`Could not read package.json for "${packageName}": ${error.message}`);
  }
}

/**
 * Find the declarative pack file inside a pack package: a `flecto-pack.*` file
 * at the package root, or the path named by its package.json "flecto" field.
 * @param {string} packageDir
 * @param {Record<string, unknown>} packageJson
 * @param {string} packageName
 * @returns {string}
 */
function resolvePackFileInPackage(packageDir, packageJson, packageName) {
  const declared = packageJson.flecto;
  /** @type {string | null} */
  let relPath = null;
  if (typeof declared === 'string') {
    relPath = declared;
  } else if (isObject(declared)) {
    if (typeof declared.pack !== 'string' || !declared.pack.trim()) {
      throw new Error(
        `Invalid "flecto" field in ${packageName}: expected { "pack": "<path to pack file>" }.`,
      );
    }
    relPath = declared.pack;
  } else if (declared !== undefined) {
    throw new Error(
      `Invalid "flecto" field in ${packageName}: expected a pack file path or { "pack": "<path>" }.`,
    );
  }

  if (relPath) {
    const abs = resolve(packageDir, relPath);
    const inside = relative(packageDir, abs);
    if (isAbsolute(relPath) || inside.startsWith('..') || isAbsolute(inside)) {
      throw new Error(`Invalid "flecto" field in ${packageName}: "${relPath}" escapes the package directory.`);
    }
    if (!PACK_EXTENSIONS.some((ext) => abs.toLowerCase().endsWith(ext))) {
      throw new Error(
        `Invalid "flecto" field in ${packageName}: "${relPath}" must be a .json, .yaml, or .yml pack file. Flecto never loads JavaScript from a pack package.`,
      );
    }
    if (!existsSync(abs)) {
      throw new Error(`Pack file missing in ${packageName}: "${relPath}" does not exist.`);
    }
    return abs;
  }

  for (const candidate of PACK_FILE_CANDIDATES) {
    const abs = join(packageDir, candidate);
    if (existsSync(abs)) return abs;
  }
  throw new Error(
    `"${packageName}" is not a Flecto policy pack: expected ${PACK_FILE_CANDIDATES.join(', ')} at the package root, or a "flecto" field in its package.json.`,
  );
}

/**
 * @param {string} packageDir
 * @param {Record<string, unknown>} packageJson
 * @returns {boolean}
 */
function packageShipsCode(packageDir, packageJson) {
  if (packageJson.main || packageJson.exports || packageJson.bin) return true;
  try {
    return readdirSync(packageDir).some((file) => /\.(c|m)?js$/.test(file));
  } catch {
    return false;
  }
}

/**
 * @param {string} cwd
 * @param {string} id
 * @returns {string[]} Existing local pack files for this id, in resolution order.
 */
function localPackFilesForId(cwd, id) {
  return PACK_EXTENSIONS
    .map((ext) => resolve(cwd, 'policies', `${id}${ext}`))
    .filter((path) => existsSync(path));
}

/**
 * @param {string} cwd
 * @param {string} id
 * @param {{ package: string, version: string | null }} entry
 */
function writePackManifestEntry(cwd, id, entry) {
  const manifestPath = resolve(cwd, 'policies', PACK_MANIFEST_FILE);
  const packs = readPackManifest(cwd);
  packs[id] = { ...entry, addedAt: new Date().toISOString() };
  writeFileSync(manifestPath, `${JSON.stringify({ packs }, null, 2)}\n`, 'utf8');
}

/**
 * Install a policy pack from an already-installed `flecto-pack-*` npm package
 * into `policies/<id>.json`, so the normal resolution order picks it up.
 *
 * Only declarative JSON/YAML is read — no package code is imported or run.
 * @param {string} name Pack id or npm package name.
 * @param {{ cwd?: string, force?: boolean }} [options]
 * @returns {AddedPolicyPack}
 */
export function addPolicyPackFromPackage(name, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const force = Boolean(options.force);
  const { id, packageName } = normalizePackPackageName(name);

  const packageDir = resolvePackPackageDir(packageName, cwd);
  if (!packageDir) {
    throw new Error(
      `Policy pack package "${packageName}" is not installed. Install it first:\n\n  npm install --save-dev ${packageName}\n`,
    );
  }

  const packageJson = readPackagePackageJson(packageDir, packageName);
  const packFile = resolvePackFileInPackage(packageDir, packageJson, packageName);
  // Full pack validation happens here, before anything is written: a malformed
  // third-party pack fails at add time rather than during evaluation.
  const pack = readPackFile(packFile, id);
  if (pack.id !== id) {
    throw new Error(
      `Policy pack id mismatch: ${packageName} declares id "${pack.id}", but the package name implies "${id}". Rename the pack id or publish under "${PACK_PACKAGE_PREFIX}${pack.id}".`,
    );
  }

  const existingLocal = localPackFilesForId(cwd, id);
  if (existingLocal.length > 0 && !force) {
    throw new Error(
      `A local policy pack "${id}" already exists: ${existingLocal.join(', ')}. Re-run with --force to overwrite it.`,
    );
  }

  const targetPath = resolve(cwd, 'policies', `${id}.json`);
  mkdirSync(dirname(targetPath), { recursive: true });
  // Only written when the source pack opts in, so packs that never set it keep
  // byte-identical output.
  const payload = pack.expandSubtrees
    ? { id, expandSubtrees: true, rules: pack.rules }
    : { id, rules: pack.rules };
  writeFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  writePackManifestEntry(cwd, id, {
    package: packageName,
    version: typeof packageJson.version === 'string' ? packageJson.version : null,
  });

  return {
    id,
    packageName,
    packageVersion: typeof packageJson.version === 'string' ? packageJson.version : null,
    packFile,
    targetPath,
    ruleCount: pack.rules.length,
    overwritten: existingLocal.includes(targetPath),
    overridesBuiltin: existsSync(join(PACKS_DIR, `${id}.json`)),
    shadowed: existingLocal.filter((path) => path !== targetPath),
    shipsCode: packageShipsCode(packageDir, packageJson),
  };
}

/**
 * Compile each rule's `match.path` and `afterMatches` regular expressions
 * once, at pack-load time, storing them as non-enumerable properties on the
 * loaded rule/clause objects. matchClause() runs per change event — for a
 * rule with a path match, once per event per rule — so compiling here instead
 * of inside that loop turns a `new RegExp(...)` call into a property read.
 *
 * validatePack() has already proven, by this point, that every `match.path`
 * and `afterMatches` string constructs a valid RegExp, so construction here
 * cannot throw a new error the caller hasn't already seen.
 * @param {PolicyPack} pack
 */
function compilePackRegexes(pack) {
  for (const rule of pack.rules ?? []) {
    compileClauseRegexes(rule);
    for (const clause of rule.allOf ?? []) compileClauseRegexes(clause);
    for (const clause of rule.anyOf ?? []) compileClauseRegexes(clause);
  }
}

/** @param {PolicyRule | PolicyMatchClause} clause */
function compileClauseRegexes(clause) {
  if (clause.match?.path !== undefined) {
    Object.defineProperty(clause.match, '_pathRegex', {
      value: new RegExp(clause.match.path, clause.match.pathFlags ?? ''),
      enumerable: false,
    });
  }
  if (clause.afterMatches !== undefined) {
    Object.defineProperty(clause, '_afterMatchesRegex', {
      value: new RegExp(clause.afterMatches),
      enumerable: false,
    });
  }
}

/**
 * @param {{ path?: string, pathFlags?: string, _pathRegex?: RegExp }} match
 * @returns {RegExp}
 */
function pathRegexFor(match) {
  // Packs loaded via loadPack() always carry a pre-compiled regex here; the
  // fallback exists only so a pack built some other way (bypassing loadPack)
  // still behaves exactly as it did before regex compilation was hoisted.
  return match._pathRegex ?? new RegExp(match.path, match.pathFlags ?? '');
}

/**
 * @param {{ afterMatches?: string, _afterMatchesRegex?: RegExp }} clause
 * @returns {RegExp}
 */
function afterMatchesRegexFor(clause) {
  return clause._afterMatchesRegex ?? new RegExp(clause.afterMatches);
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
  if (match?.path && !pathRegexFor(match).test(path)) return false;
  if (match?.pathEquals !== undefined && path !== match.pathEquals) return false;
  if (match?.pathPrefix !== undefined && !path.startsWith(match.pathPrefix)) return false;

  if (Object.prototype.hasOwnProperty.call(clause, 'beforeEquals') && change.before !== clause.beforeEquals) return false;
  if (Object.prototype.hasOwnProperty.call(clause, 'afterEquals') && change.after !== clause.afterEquals) return false;
  if (clause.beforeIn && !clause.beforeIn.includes(change.before)) return false;
  if (clause.afterIn && !clause.afterIn.includes(change.after)) return false;
  if (clause.beforeTruthy && !isTruthyToggle(change.before)) return false;
  if (clause.afterTruthy && !isTruthyToggle(change.after)) return false;
  // Value-shaped secret detection, shared with the masking path so a rule and
  // the redaction it triggers never disagree.
  if (clause.beforeLooksSecret && !containsSecret(change.before)) return false;
  if (clause.afterLooksSecret && !containsSecret(change.after)) return false;
  if (clause.afterMatches && (typeof change.after !== 'string' || !afterMatchesRegexFor(clause).test(change.after))) return false;

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
 * Bracket segment for one array element, mirroring the differ so a synthesized
 * path is spelled the same way the differ would have spelled it: a quoted
 * identity key when every element carries a unique `id` (then `name`), an index
 * otherwise.
 * @param {unknown[]} items
 * @returns {string[]}
 */
function subtreeArraySegments(items) {
  for (const idKey of ['id', 'name']) {
    /** @type {string[]} */
    const keys = [];
    let usable = items.length > 0;
    for (const item of items) {
      if (!isObject(item) || !Object.hasOwn(item, idKey)) { usable = false; break; }
      const value = item[idKey];
      if (value == null || typeof value === 'object') { usable = false; break; }
      keys.push(JSON.stringify(String(value)));
    }
    if (usable && new Set(keys).size === keys.length) return keys;
  }
  return items.map((_, index) => String(index));
}

/**
 * Walk a value, collecting every scalar leaf with its full path.
 *
 * `ancestors` holds the containers on the path currently being walked. A
 * recursive YAML anchor (`a: &x\n  b: *x`) parses to a genuinely cyclic object,
 * and the differ never recurses into an added or removed subtree, so this walk
 * is the first thing to enter one. Revisiting an ancestor stops the descent;
 * a value merely referenced twice on separate branches is still walked twice.
 * @param {unknown} value
 * @param {string} basePath
 * @param {Array<{ path: string, value: unknown }>} out
 * @param {Set<object>} ancestors
 */
function collectLeaves(value, basePath, out, ancestors) {
  const isContainer = Array.isArray(value) || isObject(value);
  if (isContainer) {
    if (ancestors.has(/** @type {object} */ (value))) return;
    ancestors.add(/** @type {object} */ (value));
  }

  if (Array.isArray(value)) {
    const segments = subtreeArraySegments(value);
    value.forEach((item, index) => collectLeaves(item, `${basePath}[${segments[index]}]`, out, ancestors));
  } else if (isObject(value)) {
    for (const key of Object.keys(value)) {
      collectLeaves(value[key], basePath ? `${basePath}.${key}` : key, out, ancestors);
    }
  } else {
    out.push({ path: basePath, value });
  }

  if (isContainer) ancestors.delete(/** @type {object} */ (value));
}

/**
 * Expand whole-subtree additions and removals into the leaf-level changes they
 * imply, keeping the original event alongside them.
 *
 * The differ reports an added or removed key once, carrying the entire subtree
 * as the value — adding a Kubernetes `Service` document, or a container's whole
 * `securityContext` block, is a single change at the parent path. Path-anchored
 * rules cannot see inside such a value, so a pack that must reason about leaves
 * (`…securityContext.privileged`) would silently miss the exact case that
 * matters most. Expanding restores one uniform shape: a rule anchored at the
 * leaf fires whether the leaf changed in place or arrived with its parent.
 *
 * Subtrees never overlap, so the total work is linear in the size of the input.
 * @param {import('./differ.js').ChangeEvent[]} changes
 * @returns {import('./differ.js').ChangeEvent[]}
 */
export function expandChangeSubtrees(changes) {
  /** @type {import('./differ.js').ChangeEvent[]} */
  const expanded = [];
  for (const change of changes) {
    expanded.push(change);
    if (change.type !== 'added' && change.type !== 'removed') continue;
    const side = change.type === 'added' ? 'after' : 'before';
    const value = change[side];
    if (!isObject(value) && !Array.isArray(value)) continue;

    /** @type {Array<{ path: string, value: unknown }>} */
    const leaves = [];
    collectLeaves(value, change.path ?? '', leaves, new Set());
    for (const leaf of leaves) {
      expanded.push({ type: change.type, path: leaf.path, [side]: leaf.value });
    }
  }
  return expanded;
}

/**
 * @param {PolicyPack} pack
 * @param {import('./differ.js').ChangeEvent[]} changes
 * @param {Record<string, PolicySeverity | 'off'>} [severityRemap]
 * @returns {PolicyFinding[]}
 */
export function evaluatePack(pack, changes, severityRemap = {}) {
  /** @type {PolicyFinding[]} */
  const findings = [];
  // Opt-in per pack, so every existing pack sees exactly the events it always
  // saw and only packs written against leaf paths pay for the expansion.
  const effectiveChanges = pack.expandSubtrees ? expandChangeSubtrees(changes) : changes;
  for (const change of effectiveChanges) {
    for (const rule of pack.rules ?? []) {
      if (!ruleMatches(rule, change)) continue;
      const severity = severityRemap[String(rule.id)] ?? rule.severity ?? 'warn';
      if (severity === 'off') continue;
      findings.push({
        id: String(rule.id),
        severity,
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
  const severityRemap = options.severityRemap ?? {};

  /** @type {PolicyFinding[]} */
  const findings = [];
  const packs = packIds.map((packId) => loadPack(packId, cwd));
  const knownRuleIds = new Set(packs.flatMap((pack) => pack.rules.map((rule) => String(rule.id))));
  for (const ruleId of Object.keys(severityRemap)) {
    if (!knownRuleIds.has(ruleId)) {
      console.warn(`Unknown policy rule id in severityRemap: "${ruleId}"`);
    }
  }
  for (const pack of packs) {
    findings.push(...evaluatePack(pack, changes, severityRemap));
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
