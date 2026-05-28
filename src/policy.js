/**
 * @typedef {'info' | 'warn' | 'error'} PolicySeverity
 * @typedef {{ id: string, severity: PolicySeverity, path: string, message: string }} PolicyFinding
 */

const SECRET_KEY_RE = /(secret|token|password|api[_-]?key|private[_-]?key)/i;
const DANGEROUS_TOGGLE_RE = /(debug|allow_insecure|disable_tls|skip_tls_verify)/i;

/**
 * Evaluate built-in policy checks against semantic changes.
 * @param {import('./differ.js').ChangeEvent[]} changes
 * @returns {PolicyFinding[]}
 */
export function evaluatePolicies(changes) {
  /** @type {PolicyFinding[]} */
  const findings = [];

  for (const change of changes) {
    const path = change.path ?? '';
    const pathLower = path.toLowerCase();

    if (SECRET_KEY_RE.test(pathLower) && change.type === 'changed') {
      findings.push({
        id: 'secret-key-changed',
        severity: 'error',
        path,
        message: 'Sensitive-looking key changed. Confirm secret rotation and access controls.',
      });
    }

    if (DANGEROUS_TOGGLE_RE.test(pathLower) && change.type === 'changed' && change.after === true) {
      findings.push({
        id: 'dangerous-toggle-enabled',
        severity: 'error',
        path,
        message: 'Potentially dangerous toggle enabled.',
      });
    }

    if (pathLower.endsWith('pool_size') && typeof change.before === 'number' && typeof change.after === 'number') {
      if (change.before > 0 && change.after >= change.before * 2) {
        findings.push({
          id: 'pool-size-jump',
          severity: 'warn',
          path,
          message: `Pool size increased from ${change.before} to ${change.after} (>=2x).`,
        });
      }
    }
  }

  return findings;
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

