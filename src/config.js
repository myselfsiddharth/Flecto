import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, sep } from 'path';
import fg from 'fast-glob';
import yaml from 'js-yaml';

const RC_CANDIDATES = ['.flectorc', '.flectorc.json', '.flectorc.yaml', '.flectorc.yml'];

/**
 * @typedef {{
 *  defaults?: Record<string, unknown>,
 *  profiles?: Record<string, Record<string, unknown>>,
 *  files?: string[],
 *  include?: string[],
 *  exclude?: string[]
 * }} FlectoRc
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
 * Has the operator explicitly opted in to plugins declared in `.flectorc`?
 * @returns {boolean}
 */
function rcPluginsAllowed() {
  const raw = process.env.FLECTO_ALLOW_RC_PLUGINS;
  return raw === '1' || String(raw).toLowerCase() === 'true';
}

/**
 * Split a policy list that may arrive as an array or a comma-separated string.
 * @param {unknown} raw
 * @param {string[]} fallback
 * @returns {string[]}
 */
function toList(raw, fallback) {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return fallback;
}

/**
 * Normalize policy-related effective options.
 *
 * Plugins execute code, and `.flectorc` is attacker-controlled on an untrusted
 * pull request, so a plugin that came from the rc file rather than an explicit
 * `--plugins` flag is refused unless the operator opts in with
 * `FLECTO_ALLOW_RC_PLUGINS=1`. Refusing loudly rather than skipping silently is
 * deliberate: a plugin that stops running without saying so would weaken a
 * policy gate the operator believes is in place. (GHSA-wq8m-fc3q-8m5x, backported
 * from 3.0.1.)
 * @param {Record<string, unknown>} effective
 * @param {{ pluginsFromCli?: boolean, cwd?: string }} [provenance]
 */
export function resolvePolicyOptions(effective, provenance = {}) {
  const severityRemapRaw = effective.severityRemap;
  const policies = toList(effective.policies, ['default']);
  const plugins = toList(effective.plugins, []);

  if (plugins.length > 0 && !provenance.pluginsFromCli) {
    if (!rcPluginsAllowed()) {
      throw new Error(
        'Refusing to load policy plugins declared in .flectorc: plugins execute code, '
        + 'and a config file can come from an untrusted pull request.\n'
        + `Declared: ${plugins.join(', ')}\n`
        + 'Pass them on the command line with --plugins instead, or set '
        + 'FLECTO_ALLOW_RC_PLUGINS=1 if this config is trusted.',
      );
    }
    // Opted in, but the rc file may still be attacker-authored. Keep rc-declared
    // plugins inside the project so `../../../../tmp/x.mjs` cannot reach a module
    // planted elsewhere on the runner. An explicit --plugins is operator intent
    // and stays unrestricted: shared policies outside the cwd are a real setup.
    const root = resolve(provenance.cwd ?? process.cwd());
    for (const pluginPath of plugins) {
      const abs = resolve(root, pluginPath);
      if (abs !== root && !abs.startsWith(root + sep)) {
        throw new Error(
          `Policy plugin declared in .flectorc is outside the project: ${pluginPath}\n`
          + 'Plugins execute code, so an rc-declared plugin must live inside the '
          + 'directory Flecto is running in.',
        );
      }
    }
  }
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
 * Scaffold a starter rc file if missing.
 * @param {string} cwd
 * @returns {string}
 */
export function initRcFile(cwd = process.cwd()) {
  const path = resolve(cwd, '.flectorc.json');
  if (existsSync(path)) return path;
  const starter = {
    defaults: {
      mode: 'compact',
      interval: 100,
      ignore: ['**.updated_at'],
      deliveryMode: 'best-effort',
      onAlertFailure: 'warn',
      policies: ['default'],
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
        policies: ['default', 'strict-prod'],
        severityRemap: { 'pool-size-jump': 'error' },
        maskSecrets: true,
      },
    },
    files: ['config/**/*.{yaml,yml,json,toml,ini}', '.env', '.env.*', '*.env'],
    exclude: ['**/node_modules/**'],
  };
  writeFileSync(path, JSON.stringify(starter, null, 2), 'utf8');
  return path;
}
