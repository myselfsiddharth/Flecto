import { relative } from 'path';

/**
 * SARIF 2.1.0 output for `flecto ci --format sarif`, for upload to GitHub code
 * scanning (github/codeql-action/upload-sarif) and any other SARIF consumer.
 *
 * What Flecto emits as SARIF *results* is its policy findings — a finding has a
 * rule id, a severity, a file, and a path, which is exactly the shape SARIF
 * models. Raw change events are not results: they carry no rule id, so they have
 * nothing to be a `ruleId` of. A run that gates on changes alone (`--fail-on
 * changed`) still exits non-zero; SARIF simply reports the policy findings.
 *
 * Line numbers: Flecto reports a *semantic path* (`Deployment/prod/api.spec.
 * replicas`), not a source line, and resolving one to the other means a
 * line-tracking parser for every format. Until that exists, results are
 * file-level: the physical location is the file with `startLine: 1`, and the
 * semantic path is preserved losslessly as a SARIF `logicalLocation`. GitHub
 * still renders the alert, dedupes it, and tracks when it is fixed — the
 * file-level tradeoff the issue (#120) calls out. The logical location means the
 * path a reviewer needs is never lost, only not yet a clickable line.
 */

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const INFORMATION_URI = 'https://github.com/myselfsiddharth/Flecto';

/**
 * Map a Flecto severity to a SARIF result level.
 * @param {string} severity
 * @returns {'error' | 'warning' | 'note'}
 */
function sarifLevel(severity) {
  if (severity === 'error') return 'error';
  if (severity === 'info') return 'note';
  return 'warning';
}

/**
 * A repo-relative, POSIX-slashed URI for a file. SARIF consumers (GitHub in
 * particular) map results onto the tree by relative URI; an absolute path does
 * not resolve, so anything outside the working directory falls back to its base
 * name rather than leaking an absolute path that would not map anyway.
 * @param {string} file
 * @param {string} cwd
 * @returns {string}
 */
function artifactUri(file, cwd) {
  const rel = relative(cwd, file);
  if (!rel || rel.startsWith('..') || rel.includes(`..${'/'}`)) {
    return file.split(/[\\/]/).pop() ?? file;
  }
  return rel.split('\\').join('/');
}

/**
 * Build a SARIF 2.1.0 log from CI results.
 *
 * `results` is the same array `printCiOutput` receives: each entry is
 * `{ file, policies }`, where `policies` is the already-mask-processed finding
 * list. Because SARIF is built from that same masked list, `--mask-secrets`
 * applies to the SARIF file with no extra work — which matters, since a SARIF
 * file is uploaded to GitHub and retained.
 * @param {Array<{ file: string, policies: import('./policy.js').PolicyFinding[] }>} results
 * @param {{ cwd?: string, toolVersion?: string }} [options]
 * @returns {object}
 */
export function buildSarif(results, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const version = options.toolVersion ?? '0.0.0';

  /** @type {Map<string, { index: number, descriptor: object }>} */
  const ruleIndex = new Map();
  /** @type {object[]} */
  const sarifResults = [];

  for (const result of results) {
    for (const finding of result.policies ?? []) {
      const ruleId = String(finding.id);
      if (!ruleIndex.has(ruleId)) {
        ruleIndex.set(ruleId, {
          index: ruleIndex.size,
          descriptor: {
            id: ruleId,
            name: ruleId,
            shortDescription: { text: shortDescriptionFor(finding) },
            defaultConfiguration: { level: sarifLevel(finding.severity) },
            ...(finding.pack ? { properties: { pack: String(finding.pack) } } : {}),
          },
        });
      }
      const path = String(finding.path ?? '');
      const uri = artifactUri(result.file, cwd);
      sarifResults.push({
        ruleId,
        ruleIndex: ruleIndex.get(ruleId).index,
        level: sarifLevel(finding.severity),
        message: { text: String(finding.message ?? `Policy ${ruleId} matched`) },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri },
            region: { startLine: 1 },
          },
          ...(path
            ? { logicalLocations: [{ fullyQualifiedName: path, kind: 'member' }] }
            : {}),
        }],
        // Keeps a finding stable across runs as its line would drift, so GitHub
        // dedupes and tracks fixes by (rule, file, semantic path) rather than by
        // a line number Flecto does not have.
        partialFingerprints: { flectoPathV1: `${ruleId}::${uri}::${path}` },
      });
    }
  }

  const rules = [...ruleIndex.values()].map((entry) => entry.descriptor);

  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'Flecto',
          informationUri: INFORMATION_URI,
          version,
          rules,
        },
      },
      results: sarifResults,
    }],
  };
}

/**
 * A stable short description for a rule descriptor. The finding's message is
 * per-occurrence (it can interpolate values), so it is not ideal as a rule-level
 * description, but it is the most specific text available and reads better than a
 * generic placeholder. Trimmed to a single line.
 * @param {import('./policy.js').PolicyFinding} finding
 * @returns {string}
 */
function shortDescriptionFor(finding) {
  const message = String(finding.message ?? '').split('\n')[0].trim();
  return message || `Policy rule ${finding.id}`;
}
