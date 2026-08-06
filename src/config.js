import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import fg from 'fast-glob';
import yaml from 'js-yaml';
import { isEnvFilename } from './parser.js';

const RC_CANDIDATES = ['.flectorc', '.flectorc.json', '.flectorc.yaml', '.flectorc.yml'];
const COMPOSE_FILENAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const CONFIG_DIR_PATTERN = 'config/**/*.{yaml,yml,json,toml,ini}';
const ENV_FILE_PATTERNS = ['.env', '.env.*', '*.env'];
const GENERIC_FILE_PATTERNS = [CONFIG_DIR_PATTERN, ...ENV_FILE_PATTERNS];

/**
 * @typedef {{
 *  defaults?: Record<string, unknown>,
 *  profiles?: Record<string, Record<string, unknown>>,
 *  files?: string[],
 *  include?: string[],
 *  exclude?: string[]
 * }} FlectoRc
 *
 * @typedef {{
 *  id: string,
 *  evidence: string[],
 *  pack: string | null,
 *  summary: string
 * }} StackSignal
 *
 * @typedef {{ signals: StackSignal[], packs: string[], files: string[] }} StackDetection
 */

/**
 * @param {string} cwd
 * @returns {{ path: string | null, config: FlectoRc | null }}
 */
export function loadRcConfig(cwd = process.cwd()) {
  for (const candidate of RC_CANDIDATES) {
    const fullPath = resolve(cwd, candidate);
    if (!existsSync(fullPath)) continue;
    const raw = readFileSync(fullPath, 'utf8');
    let parsed;
    try {
      if (candidate.endsWith('.yaml') || candidate.endsWith('.yml')) {
        parsed = yaml.load(raw);
      } else {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = yaml.load(raw);
        }
      }
    } catch (err) {
      throw new Error(`Failed to parse ${candidate}: ${err.message}`);
    }
    return { path: fullPath, config: parsed ?? {} };
  }
  return { path: null, config: null };
}

/**
 * Resolve profile name: CLI > FLECTO_PROFILE > none.
 * @param {string | undefined} cliProfile
 * @returns {string | undefined}
 */
export function resolveProfileName(cliProfile) {
  if (cliProfile) return String(cliProfile);
  if (process.env.FLECTO_PROFILE) return String(process.env.FLECTO_PROFILE);
  return undefined;
}

/**
 * Resolve effective options with optional profile and CLI overrides.
 * @param {FlectoRc | null} config
 * @param {string | undefined} profile
 * @param {Record<string, unknown>} cliOverrides
 */
export function resolveEffectiveOptions(config, profile, cliOverrides = {}) {
  const defaults = config?.defaults ?? {};
  const profileOptions = profile && config?.profiles?.[profile] ? config.profiles[profile] : {};
  return { ...defaults, ...profileOptions, ...cliOverrides };
}

/**
 * Normalize policy-related effective options.
 * @param {Record<string, unknown>} effective
 */
export function resolvePolicyOptions(effective) {
  const policiesRaw = effective.policies;
  const pluginsRaw = effective.plugins;
  const severityRemapRaw = effective.severityRemap;
  const policies = Array.isArray(policiesRaw)
    ? policiesRaw.map(String)
    : typeof policiesRaw === 'string'
      ? String(policiesRaw).split(',').map((s) => s.trim()).filter(Boolean)
      : ['default'];
  const plugins = Array.isArray(pluginsRaw)
    ? pluginsRaw.map(String)
    : typeof pluginsRaw === 'string'
      ? String(pluginsRaw).split(',').map((s) => s.trim()).filter(Boolean)
      : [];
  if (
    severityRemapRaw !== undefined
    && (severityRemapRaw === null || Array.isArray(severityRemapRaw) || typeof severityRemapRaw !== 'object')
  ) {
    throw new Error('severityRemap must be an object mapping rule ids to info, warn, error, or off');
  }
  const severityRemap = {};
  for (const [ruleId, severity] of Object.entries(severityRemapRaw ?? {})) {
    if (!['info', 'warn', 'error', 'off'].includes(severity)) {
      throw new Error(
        `severityRemap for "${ruleId}" must be one of: info, warn, error, off`,
      );
    }
    severityRemap[ruleId] = severity;
  }
  return { policies, plugins, severityRemap };
}

/**
 * Expand file patterns from rc include/files and direct CLI inputs.
 * @param {{ cwd?: string, files?: string[], include?: string[], exclude?: string[] }} input
 * @returns {Promise<string[]>}
 */
export async function resolveFiles(input) {
  const cwd = input.cwd ?? process.cwd();
  const files = input.files ?? [];
  const include = input.include ?? [];
  const exclude = input.exclude ?? [];
  const patterns = [...files, ...include].filter(Boolean);
  if (patterns.length === 0) return [];
  const matches = await fg(patterns, {
    cwd,
    absolute: true,
    onlyFiles: true,
    unique: true,
    ignore: exclude,
    dot: true,
  });
  return matches.map((p) => resolve(p));
}

/**
 * Detect stack signals in a directory and map them to policy packs and file
 * patterns. Only built-in pack ids and patterns Flecto can actually parse are
 * ever returned, so a config built from this stays loadable by every command.
 * Terraform files are reported as context only: no `terraform` pack ships yet,
 * and `.tf` is not a supported parse format.
 * @param {string} cwd
 * @returns {StackDetection}
 */
export function detectStack(cwd = process.cwd()) {
  /** @type {StackSignal[]} */
  const signals = [];
  const packs = ['default'];
  /** @type {string[]} */
  const files = [];

  let entries = [];
  try {
    entries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    return { signals, packs, files };
  }
  const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const dirNames = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const fileNameSet = new Set(fileNames);

  const composeFiles = COMPOSE_FILENAMES.filter((name) => fileNameSet.has(name));
  if (composeFiles.length > 0) {
    packs.push('compose');
    files.push(...composeFiles);
    signals.push({
      id: 'compose',
      evidence: composeFiles,
      pack: 'compose',
      summary: `Detected ${composeFiles.join(', ')} → enabled the \`compose\` policy pack and watched ${composeFiles.length === 1 ? 'it' : 'them'}`,
    });
  }

  if (fileNameSet.has('package.json')) {
    packs.push('node-runtime');
    files.push('package.json');
    signals.push({
      id: 'node',
      evidence: ['package.json'],
      pack: 'node-runtime',
      summary: 'Detected package.json → enabled the `node-runtime` policy pack and watched it',
    });
  }

  const terraformFiles = fileNames.filter((name) => name.toLowerCase().endsWith('.tf')).sort();
  if (terraformFiles.length > 0) {
    signals.push({
      id: 'terraform',
      evidence: terraformFiles,
      pack: null,
      summary: `Detected Terraform files (${terraformFiles.join(', ')}) → no terraform pack ships yet and .tf is not a parseable format, so nothing was enabled`,
    });
  }

  if (dirNames.has('config')) {
    files.push(CONFIG_DIR_PATTERN);
    signals.push({
      id: 'config-dir',
      evidence: ['config/'],
      pack: null,
      summary: `Detected config/ → watched ${CONFIG_DIR_PATTERN}`,
    });
  }

  const envFiles = fileNames.filter((name) => isEnvFilename(name)).sort();
  if (envFiles.length > 0) {
    files.push(...ENV_FILE_PATTERNS);
    signals.push({
      id: 'dotenv',
      evidence: envFiles,
      pack: null,
      summary: `Detected ${envFiles.join(', ')} → watched ${ENV_FILE_PATTERNS.join(', ')}`,
    });
  }

  return { signals, packs, files: [...new Set(files)] };
}

/**
 * Scaffold a starter rc file if missing, pre-selecting policy packs and file
 * patterns from the stack signals found in `cwd`. Never overwrites an existing
 * config: any of the four `.flectorc` candidates is reported back untouched.
 * @param {string} cwd
 * @returns {{ path: string, created: boolean, detection: StackDetection }}
 */
export function initRcFile(cwd = process.cwd()) {
  const detection = detectStack(cwd);
  const existingPath = RC_CANDIDATES
    .map((candidate) => resolve(cwd, candidate))
    .find((candidate) => existsSync(candidate));
  if (existingPath) return { path: existingPath, created: false, detection };

  const path = resolve(cwd, '.flectorc.json');
  const starter = {
    defaults: {
      mode: 'compact',
      interval: 100,
      ignore: ['**.updated_at'],
      deliveryMode: 'best-effort',
      onAlertFailure: 'warn',
      policies: detection.packs,
      plugins: [],
      arrayIdKey: null,
      arrayId: true,
      arrayIgnoreOrder: false,
      maskSecrets: false,
    },
    profiles: {
      dev: { mode: 'verbose' },
      ci: { failOn: 'policy,error' },
      prod: {
        policies: [...detection.packs, 'strict-prod'],
        severityRemap: { 'pool-size-jump': 'error' },
        maskSecrets: true,
      },
    },
    files: detection.files.length > 0 ? detection.files : [...GENERIC_FILE_PATTERNS],
    exclude: ['**/node_modules/**'],
  };
  writeFileSync(path, JSON.stringify(starter, null, 2), 'utf8');
  return { path, created: true, detection };
}
