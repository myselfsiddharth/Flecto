import { readFileSync } from 'fs';
import { basename, extname } from 'path';
import yaml from 'js-yaml';
import TOML from '@iarna/toml';
import dotenv from 'dotenv';

const SUPPORTED_EXT = ['.json', '.yaml', '.yml', '.toml', '.env', '.ini'];

/**
 * True for dotenv-like names: `.env`, `.env.*`, `*.env`
 * @param {string} filepath
 */
export function isEnvFilename(filepath) {
  const base = basename(filepath);
  return base === '.env' || base.startsWith('.env.') || base.endsWith('.env');
}

/**
 * True for INI files.
 * @param {string} filepath
 */
export function isIniFilename(filepath) {
  return extname(filepath).toLowerCase() === '.ini';
}

/**
 * Minimal INI parser: [section] + key=value.
 * Root keys are top-level; sectioned keys nest under the section name.
 * @param {string} raw
 * @returns {Record<string, unknown>}
 */
export function parseIni(raw) {
  /** @type {Record<string, unknown>} */
  const out = {};
  let section = null;

  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      if (!isPlainObject(out[section])) out[section] = {};
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (section == null) {
      out[key] = value;
    } else {
      /** @type {Record<string, string>} */
      const bucket = /** @type {any} */ (out[section]);
      bucket[key] = value;
    }
  }
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Auto-detect the format of a file and parse it into a plain JS object.
 * @param {string} filepath
 * @param {string} raw
 * @returns {unknown}
 * @throws {Error} on unsupported format or parse failure
 */
export function parseContent(filepath, raw) {
  const ext = extname(filepath).toLowerCase();
  const envLike = isEnvFilename(filepath);
  const iniLike = isIniFilename(filepath);

  if (!envLike && !iniLike && !SUPPORTED_EXT.includes(ext)) {
    const supported = [...SUPPORTED_EXT, '.env.*', '*.env'].join(', ');
    throw new Error(
      `Unsupported file format "${ext || '(none)'}" for "${filepath}".\n` +
      `Supported extensions: ${supported}`
    );
  }
  try {
    if (envLike || ext === '.env') {
      return dotenv.parse(raw);
    }

    if (iniLike) {
      return parseIni(raw);
    }

    if (ext === '.json') {
      return JSON.parse(raw);
    }

    if (ext === '.yaml' || ext === '.yml') {
      const result = yaml.load(raw);
      return result == null ? {} : result;
    }

    if (ext === '.toml') {
      return TOML.parse(raw);
    }
  } catch (err) {
    const lineMatch = err.message?.match(/line (\d+)/i);
    const lineInfo = lineMatch ? ` (line ${lineMatch[1]})` : '';
    throw new Error(
      `Parse error in "${filepath}"${lineInfo}: ${err.message}`
    );
  }
}

/**
 * Auto-detect the format of a file and parse it into a plain JS value.
 * @param {string} filepath
 * @returns {unknown}
 */
export function parseFile(filepath) {
  let raw;
  try {
    raw = readFileSync(filepath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read file "${filepath}": ${err.message}`);
  }
  return parseContent(filepath, raw);
}

/**
 * Returns true if the file format is supported.
 * @param {string} filepath
 * @returns {boolean}
 */
export function isSupported(filepath) {
  if (isEnvFilename(filepath) || isIniFilename(filepath)) return true;
  return SUPPORTED_EXT.includes(extname(filepath).toLowerCase());
}
