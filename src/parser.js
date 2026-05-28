import { readFileSync } from 'fs';
import { extname } from 'path';
import yaml from 'js-yaml';
import TOML from '@iarna/toml';
import dotenv from 'dotenv';

const SUPPORTED = ['.json', '.yaml', '.yml', '.toml', '.env'];

/**
 * Auto-detect the format of a file and parse it into a plain JS object.
 * @param {string} filepath
 * @param {string} raw
 * @returns {unknown}
 * @throws {Error} on unsupported format or parse failure
 */
export function parseContent(filepath, raw) {
  const ext = extname(filepath).toLowerCase();

  if (!SUPPORTED.includes(ext)) {
    const supported = SUPPORTED.join(', ');
    throw new Error(
      `Unsupported file format "${ext}" for "${filepath}".\n` +
      `Supported extensions: ${supported}`
    );
  }
  try {
    if (ext === '.json') {
      return JSON.parse(raw);
    }

    if (ext === '.yaml' || ext === '.yml') {
      const result = yaml.load(raw);
      // yaml.load can return null for empty files
      return result == null ? {} : result;
    }

    if (ext === '.toml') {
      return TOML.parse(raw);
    }

    if (ext === '.env') {
      const parsed = dotenv.parse(raw);
      return parsed;
    }
  } catch (err) {
    // Try to extract line info from error messages
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
 * Returns true if the file extension is supported.
 * @param {string} filepath
 * @returns {boolean}
 */
export function isSupported(filepath) {
  return SUPPORTED.includes(extname(filepath).toLowerCase());
}
