import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import fg from 'fast-glob';
import yaml from 'js-yaml';

const RC_CANDIDATES = ['.driffrc', '.driffrc.json', '.driffrc.yaml', '.driffrc.yml'];

/**
 * @typedef {{
 *  defaults?: Record<string, unknown>,
 *  profiles?: Record<string, Record<string, unknown>>,
 *  files?: string[],
 *  include?: string[],
 *  exclude?: string[]
 * }} DriffRc
 */

/**
 * @param {string} cwd
 * @returns {{ path: string | null, config: DriffRc | null }}
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
 * Resolve effective options with optional profile and CLI overrides.
 * @param {DriffRc | null} config
 * @param {string | undefined} profile
 * @param {Record<string, unknown>} cliOverrides
 */
export function resolveEffectiveOptions(config, profile, cliOverrides = {}) {
  const defaults = config?.defaults ?? {};
  const profileOptions = profile && config?.profiles?.[profile] ? config.profiles[profile] : {};
  return { ...defaults, ...profileOptions, ...cliOverrides };
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
  const path = resolve(cwd, '.driffrc.json');
  if (existsSync(path)) return path;
  const starter = {
    defaults: {
      mode: 'compact',
      interval: 100,
      ignore: ['**.updated_at'],
      deliveryMode: 'best-effort',
      onAlertFailure: 'warn',
    },
    profiles: {
      dev: { mode: 'verbose' },
      ci: { failOn: 'policy,error' },
    },
    files: ['config/**/*.yaml', '.env'],
    exclude: ['**/node_modules/**'],
  };
  writeFileSync(path, JSON.stringify(starter, null, 2), 'utf8');
  return path;
}

