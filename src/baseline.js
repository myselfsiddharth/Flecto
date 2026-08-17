import { existsSync, readFileSync, writeFileSync } from 'fs';
import { relative, resolve } from 'path';

/**
 * Adoption baseline for `flecto ci`. Records the policy findings that already
 * exist in a repository so the gate fails only on *new* ones, the way every
 * durable policy tool lets a team turn on enforcement without first fixing
 * years of accumulated config.
 *
 * The fingerprint is the crux (#118). It is `(rule id, file, path)` and
 * deliberately excludes the finding's value:
 *
 * - **Excluding the value** keeps a baseline from churning on every edit. A
 *   `pool-size-jump` that was accepted at 5→20 should stay accepted when it
 *   becomes 5→21; re-flagging it would make the file thrash and get deleted.
 * - **Including the path** — which for multi-document YAML already carries the
 *   document identity (`Deployment/prod/api.…`) — keeps two findings of the same
 *   rule in the same file distinct.
 * - **The file is stored repo-relative and POSIX-slashed**, so a baseline is
 *   portable across machines and clean in a diff.
 *
 * The tradeoff, documented for the user: renaming a file or restructuring a path
 * re-introduces its findings as new. That is the honest failure mode — a
 * fingerprint stable across a rename would have to ignore location, which would
 * make it too coarse to tell two findings apart.
 */

const BASELINE_VERSION = 1;

/**
 * @typedef {{
 *   rule: string,
 *   file: string,
 *   path: string,
 *   severity?: string,
 *   message?: string,
 *   pack?: string,
 *   acceptedAt?: string,
 *   reason?: string
 * }} BaselineEntry
 *
 * @typedef {{ version: number, generatedAt?: string, findings: BaselineEntry[] }} BaselineFile
 */

/**
 * The stable identity of a finding: rule, file, path. NUL-joined so no two
 * different triples can collide by concatenation.
 * @param {{ rule: string, file: string, path: string }} entry
 * @returns {string}
 */
export function fingerprint(entry) {
  return `${entry.rule}\u0000${entry.file}\u0000${entry.path}`;
}

/**
 * Normalize a file path to the repo-relative, POSIX form stored in a baseline.
 * @param {string} file
 * @param {string} cwd
 * @returns {string}
 */
export function baselineRelativePath(file, cwd) {
  const rel = relative(cwd, file);
  if (!rel || rel.startsWith('..')) return file.split(/[\\/]/).join('/');
  return rel.split('\\').join('/');
}

/**
 * Read and validate a baseline file. A missing file is not an error — it is the
 * first run, before anyone has recorded anything — so it reads as empty. A file
 * that exists but is malformed *is* an error: silently treating it as empty
 * would turn every recorded finding new and fail the build in a way that looks
 * like a regression.
 * @param {string} path
 * @returns {{ entries: Map<string, BaselineEntry>, existed: boolean }}
 */
export function loadBaseline(path) {
  if (!existsSync(path)) return { entries: new Map(), existed: false };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Baseline file is not valid JSON: ${path}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.findings)) {
    throw new Error(`Baseline file is malformed (expected a "findings" array): ${path}`);
  }

  /** @type {Map<string, BaselineEntry>} */
  const entries = new Map();
  for (const [index, entry] of parsed.findings.entries()) {
    for (const field of ['rule', 'file', 'path']) {
      if (typeof entry?.[field] !== 'string') {
        throw new Error(`Baseline findings[${index}].${field} must be a string: ${path}`);
      }
    }
    entries.set(fingerprint(entry), entry);
  }
  return { entries, existed: true };
}

/**
 * Partition this run's findings against a loaded baseline.
 *
 * `located` is the run's findings paired with their repo-relative file. Result:
 * - `active`   — findings not in the baseline; these still gate the build
 * - `accepted` — findings the baseline already records; suppressed from the gate
 * - `stale`    — baseline entries that did not occur this run; reported so the
 *                file shrinks rather than accreting forever
 * @param {Array<{ file: string, finding: import('./policy.js').PolicyFinding }>} located
 * @param {Map<string, BaselineEntry>} baseline
 * @returns {{
 *   active: Array<{ file: string, finding: import('./policy.js').PolicyFinding }>,
 *   accepted: Array<{ file: string, finding: import('./policy.js').PolicyFinding }>,
 *   stale: BaselineEntry[]
 * }}
 */
export function applyBaseline(located, baseline) {
  const active = [];
  const accepted = [];
  const seen = new Set();

  for (const item of located) {
    const fp = fingerprint({
      rule: String(item.finding.id),
      file: item.file,
      path: String(item.finding.path ?? ''),
    });
    seen.add(fp);
    if (baseline.has(fp)) accepted.push(item);
    else active.push(item);
  }

  const stale = [];
  for (const [fp, entry] of baseline) {
    if (!seen.has(fp)) stale.push(entry);
  }

  return { active, accepted, stale };
}

/**
 * Build the baseline file content from this run's findings, preserving the
 * `acceptedAt` and `reason` of entries that already existed so an update does
 * not reset the provenance of findings that were accepted long ago. Entries are
 * sorted by (file, rule, path) for a stable, review-friendly diff.
 * @param {Array<{ file: string, finding: import('./policy.js').PolicyFinding }>} located
 * @param {Map<string, BaselineEntry>} previous
 * @param {{ now?: string }} [options]
 * @returns {BaselineFile}
 */
export function buildBaselineFile(located, previous, options = {}) {
  const now = options.now ?? new Date().toISOString();

  /** @type {Map<string, BaselineEntry>} */
  const byFingerprint = new Map();
  for (const { file, finding } of located) {
    const entry = {
      rule: String(finding.id),
      file,
      path: String(finding.path ?? ''),
    };
    const fp = fingerprint(entry);
    // One entry per fingerprint even if a rule fires twice on the same path.
    if (byFingerprint.has(fp)) continue;
    const prior = previous.get(fp);
    byFingerprint.set(fp, {
      ...entry,
      severity: finding.severity,
      ...(finding.pack ? { pack: String(finding.pack) } : {}),
      message: String(finding.message ?? ''),
      acceptedAt: prior?.acceptedAt ?? now,
      ...(prior?.reason ? { reason: prior.reason } : {}),
    });
  }

  const findings = [...byFingerprint.values()].sort((a, b) =>
    a.file.localeCompare(b.file)
    || a.rule.localeCompare(b.rule)
    || a.path.localeCompare(b.path));

  return { version: BASELINE_VERSION, generatedAt: now, findings };
}

/**
 * Write a baseline file with a trailing newline and stable 2-space indent, so it
 * reviews and diffs cleanly.
 * @param {string} path
 * @param {BaselineFile} content
 */
export function writeBaselineFile(path, content) {
  writeFileSync(resolve(path), `${JSON.stringify(content, null, 2)}\n`, 'utf8');
}
