#!/usr/bin/env node

import { program } from 'commander';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, realpathSync } from 'fs';
import { resolve, relative, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import chalk from 'chalk';

import { parseFile, isSupported, parseContent } from './src/parser.js';
import { diffTrees, secretMatchPath } from './src/differ.js';
import { documentKeysOf, withDocumentKeys } from './src/documents.js';
import { startWatcher } from './src/watcher.js';
import {
  renderChanges,
  renderDiff,
  renderError,
  renderInfo,
  renderNote,
  renderWarn,
  renderPolicyFindings,
  maskChangeEvent,
  maskSensitiveValue,
} from './src/renderer.js';
import { deliverPrComment, renderPrComment } from './src/pr-comment.js';
import { PR_PROVIDER_IDS } from './src/pr-providers.js';
import {
  diffTerraformPlan,
  formatPlanSummary,
  readTerraformPlanFile,
} from './src/terraform.js';
import { renderReportHtml } from './src/report.js';
import { redactSecretString } from './src/secrets.js';
import { fireAlerts } from './src/alerter.js';
import { resolveWebhookFormat, WEBHOOK_FORMAT_CHOICES } from './src/notifiers.js';
import { createEnvelope } from './src/envelope.js';
import { buildSarif } from './src/sarif.js';
import {
  loadBaseline,
  applyBaseline,
  buildBaselineFile,
  writeBaselineFile,
  baselineRelativePath,
} from './src/baseline.js';
import {
  suppressionFormat,
  parseSuppressions,
  applySuppressions,
} from './src/suppressions.js';
import {
  evaluatePolicies,
  highestSeverity,
  listPolicyPacks,
  addPolicyPackFromPackage,
} from './src/policy.js';
import { testPolicyFixture } from './src/policy-test.js';
import {
  loadRcConfig,
  resolveEffectiveOptions,
  resolveFiles,
  initRcFile,
  resolveProfileName,
  resolvePolicyOptions,
  assertTargetContained,
} from './src/config.js';

const PKG = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'),
);

const SNAPSHOT_DIR = '.flecto-snapshots';
const FAIL_ON_CHOICES = ['changed', 'added', 'removed', 'policy', 'error', 'warn'];

/**
 * `flecto plan` defaults. A plan is expected to contain changes — that is the
 * point of running one — so gating on `changed` the way `ci` does would fail
 * every non-empty plan. The `terraform` pack reserves `error` for the patterns
 * that genuinely should block a merge and leaves cost and sizing advice at
 * `warn`, so `error` is the default gate; `--fail-on policy` or `warn` widens it.
 */
const PLAN_DEFAULT_FAIL_ON = 'error';
const PLAN_DEFAULT_POLICIES = 'terraform';

function snapshotIdForPath(absPath) {
  const normalized = absPath.replaceAll('\\', '/');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function snapshotPathForFile(absPath) {
  const id = snapshotIdForPath(absPath);
  return resolve(`${SNAPSHOT_DIR}/${id}.json`);
}

function snapshotHistoryPathForFile(absPath) {
  const id = snapshotIdForPath(absPath);
  let timestamp = Date.now();
  let path = resolve(`${SNAPSHOT_DIR}/${id}.${timestamp}.json`);
  while (existsSync(path)) {
    timestamp += 1;
    path = resolve(`${SNAPSHOT_DIR}/${id}.${timestamp}.json`);
  }
  return path;
}

/**
 * Snapshot ids that already have at least one timestamped history entry.
 *
 * Listed once per run and threaded through the snapshot loop: probing the
 * directory per file made writing N baselines cost N listings of O(N) entries
 * each, which is quadratic in the number of tracked files.
 * @returns {Set<string>}
 */
function snapshotIdsWithHistory() {
  /** @type {Set<string>} */
  const ids = new Set();
  if (!existsSync(SNAPSHOT_DIR)) return ids;
  for (const name of readdirSync(SNAPSHOT_DIR)) {
    const match = /^([a-f0-9]{16})\.\d+\.json$/.exec(name);
    if (match) ids.add(match[1]);
  }
  return ids;
}

function preserveLegacySnapshotForHistory(absPath, snapshotPath, idsWithHistory) {
  if (!existsSync(snapshotPath) || idsWithHistory.has(snapshotIdForPath(absPath))) return;

  const legacy = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  writeFileSync(
    snapshotHistoryPathForFile(absPath),
    JSON.stringify({
      file: legacy.file ?? absPath,
      state: legacy.state ?? legacy,
      ...(Array.isArray(legacy.documents) ? { documents: legacy.documents } : {}),
      createdAt: legacy.createdAt ?? statSync(snapshotPath).mtime.toISOString(),
    }, null, 2),
    'utf8',
  );
}

function readLocalSnapshotHistory() {
  if (!existsSync(SNAPSHOT_DIR)) return [];

  const entries = readdirSync(SNAPSHOT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  const historyEntries = entries.filter((entry) => /^[a-f0-9]{16}\.\d+\.json$/.test(entry.name));
  const historyIds = new Set(historyEntries.map((entry) => entry.name.slice(0, 16)));
  const legacyEntries = entries.filter((entry) =>
    /^[a-f0-9]{16}\.json$/.test(entry.name) && !historyIds.has(entry.name.slice(0, 16)));
  const snapshotEntries = [...historyEntries, ...legacyEntries];

  return snapshotEntries.map((entry) => {
    const path = resolve(SNAPSHOT_DIR, entry.name);
    const snapshot = JSON.parse(readFileSync(path, 'utf8'));
    const state = restoreSnapshotDocumentKeys(snapshot?.state ?? snapshot, snapshot);
    if (typeof snapshot?.file !== 'string') {
      throw new Error(`Invalid snapshot file: ${path}`);
    }
    return {
      file: snapshot.file,
      state,
      createdAt: snapshot.createdAt ?? statSync(path).mtime.toISOString(),
    };
  });
}

function summarizeSnapshotHistory(snapshots, limit, diffOpts = {}) {
  const byFile = new Map();
  for (const snapshot of snapshots) {
    const records = byFile.get(snapshot.file) ?? [];
    records.push(snapshot);
    byFile.set(snapshot.file, records);
  }

  const summaries = [];
  for (const records of byFile.values()) {
    records.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    for (let index = 0; index < records.length; index += 1) {
      // The previous snapshot of the *same file* is the baseline, and it may
      // fall outside the limit window — so carry it here rather than letting
      // callers infer it from the truncated result.
      const previous = index === 0 ? null : records[index - 1];
      const changes = previous
        ? diffTrees(previous.state, records[index].state, diffOpts)
        : [];
      summaries.push({
        ...records[index],
        previousCreatedAt: previous ? previous.createdAt : null,
        changes,
        changeCount: changes.length,
      });
    }
  }

  return summaries
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
}

function parseCsv(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function parseFailOn(value) {
  const rules = parseCsv(value);
  const invalid = rules.filter((rule) => !FAIL_ON_CHOICES.includes(rule));
  if (invalid.length > 0) {
    throw new Error(
      `--fail-on contains unknown trigger${invalid.length === 1 ? '' : 's'}: ${invalid.join(', ')}. `
      + `Valid triggers: ${FAIL_ON_CHOICES.join(', ')}`,
    );
  }
  return new Set(rules);
}

function parseHeaders(headerList) {
  const webhookHeaders = {};
  if (!Array.isArray(headerList)) return webhookHeaders;
  for (const h of headerList) {
    const idx = String(h).indexOf(':');
    if (idx > 0) {
      const k = String(h).slice(0, idx).trim();
      const v = String(h).slice(idx + 1).trim();
      if (k) webhookHeaders[k] = v;
    }
  }
  return webhookHeaders;
}

function validateMode(mode) {
  if (!['compact', 'verbose'].includes(mode)) {
    throw new Error('--mode must be "compact" or "verbose"');
  }
}

function validateInterval(interval) {
  if (Number.isNaN(interval) || interval < 10) {
    throw new Error('--interval must be a number >= 10');
  }
}

function stripUnsetCliOverrides(opts, command) {
  return Object.fromEntries(
    Object.entries(opts).filter(([key]) => command.getOptionValueSource(key) === 'cli'),
  );
}

function diffOptionsFromEffective(effective, ignorePaths) {
  const arrayIdKey = effective.arrayIdKey || null;
  return {
    ignorePaths,
    arrayIdKey,
    // Explicit --array-id-key / arrayIdKey enables identity matching even when
    // .flectorc sets arrayId:false (index escape hatch for auto-detect only).
    arrayIdentity: arrayIdKey ? true : effective.arrayId !== false,
    arrayIgnoreOrder: Boolean(effective.arrayIgnoreOrder),
  };
}

function maybeMaskChanges(events, maskSecrets) {
  if (!maskSecrets) return events;
  return events.map(maskChangeEvent);
}

/**
 * Redact secret-shaped text from policy messages. A rule using
 * `messageTemplate` can interpolate `{before}` / `{after}`, so a finding can
 * carry a credential even when the change events beside it are masked. Replace
 * exact interpolated values using the same path-aware masking as change events,
 * then catch any other recognizable secret fragments in free-form messages.
 * @param {import('./src/policy.js').PolicyFinding[]} findings
 * @param {import('./src/differ.js').ChangeEvent[]} changes
 * @param {boolean} maskSecrets
 * @returns {import('./src/policy.js').PolicyFinding[]}
 */
function maybeMaskFindings(findings, changes, maskSecrets) {
  if (!maskSecrets) return findings;
  return findings.map((finding) => {
    let message = String(finding.message ?? '');
    for (const change of changes.filter((event) => event.path === finding.path)) {
      for (const value of [change.before, change.after]) {
        const original = String(value);
        const masked = String(maskSensitiveValue(value, secretMatchPath(change)));
        if (original && original !== masked) message = message.replaceAll(original, masked);
      }
    }
    return { ...finding, message: redactSecretString(message) };
  });
}

/**
 * Every command's targets pass through here, which makes it the one place the
 * symlink-escape check has to run: a target that leaves the project through a
 * link is refused before anything reads it.
 * @param {string[]} files
 * @returns {string[]} the same list
 */
function assertTargetsContained(files) {
  for (const file of files) assertTargetContained(file, process.cwd());
  return files;
}

async function resolveTargetFiles(cliFiles, rcConfig) {
  if (cliFiles && cliFiles.length > 0) {
    const direct = [];
    const globPatterns = [];
    for (const entry of cliFiles) {
      if (/[*?[\]{}]/.test(entry)) {
        globPatterns.push(entry);
      } else {
        direct.push(resolve(entry));
      }
    }
    let expanded = [];
    if (globPatterns.length > 0) {
      expanded = await resolveFiles({
        cwd: process.cwd(),
        files: globPatterns,
        exclude: rcConfig?.exclude ?? [],
      });
    }
    return assertTargetsContained([...new Set([...direct, ...expanded])]);
  }

  return assertTargetsContained(await resolveFiles({
    cwd: process.cwd(),
    files: rcConfig?.files ?? [],
    include: rcConfig?.include ?? [],
    exclude: rcConfig?.exclude ?? [],
  }));
}

/**
 * Restore the parser's multi-document signal onto a state read back from a
 * snapshot. A snapshot is plain JSON, so the in-memory marking is gone; a
 * snapshot written before this field existed simply leaves the provenance
 * unknown, which is what it is.
 * @param {unknown} state
 * @param {unknown} snapshot the parsed snapshot envelope
 * @returns {unknown} the same state
 */
function restoreSnapshotDocumentKeys(state, snapshot) {
  const documents = /** @type {{ documents?: unknown }} */ (snapshot)?.documents;
  if (!Array.isArray(documents)) return state;
  return withDocumentKeys(state, documents.map(String));
}

function readSnapshotStateFromFile(snapshotPath) {
  const snap = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  return restoreSnapshotDocumentKeys(snap?.state ?? snap, snap);
}

/**
 * Resolve a file to a path relative to its git repository root.
 *
 * `git show <rev>:<path>` interprets <path> from the repository root, so a
 * cwd-relative path breaks whenever Flecto runs from a subdirectory. Both sides
 * are canonicalized first: process.cwd() reports a symlink-resolved path while
 * CLI arguments keep the symlinks the user typed, and on macOS /tmp and
 * /var/folders are symlinks, so comparing the two forms directly misresolves.
 * @param {string} filePath
 * @returns {string} POSIX-style path relative to the repository root
 */
function gitRepoRelativePath(filePath) {
  const top = execFileSync('git', ['-C', dirname(filePath), 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  return relative(canonicalPath(top), canonicalPath(filePath)).replaceAll('\\', '/');
}

/**
 * Resolve symlinks where possible, falling back to the input when the path does
 * not exist on disk.
 *
 * `realpathSync.native` is tried first because on Windows it asks the OS for the
 * final path, which resolves 8.3 short names and normalizes case. Those are not
 * cosmetic here: `git rev-parse --show-toplevel` reports the long form, while
 * `os.tmpdir()` and many shells hand Flecto the short one
 * (`C:\Users\RUNNER~1\...`). The JS `realpathSync` leaves both as written, so
 * the two spellings of one directory compare as different and `relative()`
 * produces a path that climbs out of the repository -- making
 * `--snapshot-ref <git-ref>` fail on a file that is plainly tracked.
 *
 * On Linux and macOS the two agree for any path that exists, so this only ever
 * changes the Windows result.
 * @param {string} path
 * @returns {string}
 */
function canonicalPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    // Falls back for a path that does not exist yet, and for the rare platform
    // where the native call is unavailable.
  }
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function readSnapshotStateFromRef(filePath, snapshotRef) {
  if (!snapshotRef) {
    const snapshotPath = snapshotPathForFile(filePath);
    // Failing closed here is right — a diff with no baseline is not a clean
    // diff — but an ENOENT on a hashed filename explains nothing. Snapshot
    // history is local to the working directory, so this is what an ephemeral
    // CI runner hits on every run (#141).
    if (!existsSync(snapshotPath)) {
      throw new Error(
        `no local snapshot has been saved for this file (${SNAPSHOT_DIR}/ holds none).`
          + ' Save one with "flecto watch <file> --snapshot", or pass --snapshot-ref'
          + ' <git-ref> to diff against a committed revision instead',
      );
    }
    return readSnapshotStateFromFile(snapshotPath);
  }
  const maybePath = resolve(snapshotRef);
  if (existsSync(maybePath)) {
    return readSnapshotStateFromFile(maybePath);
  }

  const rel = gitRepoRelativePath(filePath);
  const raw = execFileSync('git', ['show', `${snapshotRef}:${rel}`], { encoding: 'utf8' });
  return parseContent(filePath, raw);
}

function shouldFailFromPolicy(findings, failOn) {
  if (failOn.has('policy') && findings.length > 0) return true;
  if (failOn.has('error') && highestSeverity(findings) === 'error') return true;
  if (failOn.has('warn') && (highestSeverity(findings) === 'warn' || highestSeverity(findings) === 'error')) return true;
  return false;
}

/**
 * Parse a file's inline suppressions and split its findings into active and
 * suppressed. A directive missing its mandatory reason is a hard error: applying
 * it would hide a finding with no justification, and skipping it silently would
 * fail the build confusingly.
 *
 * A directive that resolves to nothing — an array element, or a file type with
 * no comment syntax — is a warning instead of an error. It already fails closed,
 * because the finding it meant to accept still fires and still gates, so failing
 * the build a second time adds nothing; what was missing was any signal at all
 * that the directive did not take effect.
 * @param {string} filepath
 * @param {import('./src/policy.js').PolicyFinding[]} findings
 * @returns {{ active: any[], suppressed: Array<{ finding: any, reason: string }> }}
 */
function resolveSuppressed(filepath, findings) {
  const format = suppressionFormat(filepath);

  let raw;
  try {
    raw = readFileSync(filepath, 'utf8');
  } catch {
    return { active: findings, suppressed: [] };
  }
  const { suppressions, errors, warnings } = parseSuppressions(raw, format);
  const rel = relative(process.cwd(), filepath) || filepath;
  if (errors.length > 0) {
    const detail = errors.map((e) => `  ${rel}:${e.line}: ${e.message}`).join('\n');
    throw new Error(`Inline suppression is missing a required reason:\n${detail}`);
  }
  for (const warning of warnings) renderNote(`${rel}:${warning.line}: ${warning.message}`);
  return applySuppressions(findings, suppressions);
}

function shouldFailFromChanges(events, failOn) {
  if (events.length === 0) return false;
  if (failOn.has('changed') && events.some((e) => e.type === 'changed')) return true;
  if (failOn.has('added') && events.some((e) => e.type === 'added')) return true;
  if (failOn.has('removed') && events.some((e) => e.type === 'removed')) return true;
  return false;
}

function escapeWorkflowCommandData(value) {
  return String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

function escapeWorkflowCommandProperty(value) {
  return escapeWorkflowCommandData(value)
    .replaceAll(':', '%3A')
    .replaceAll(',', '%2C');
}

/**
 * Write to stdout and resolve only once the bytes have actually left.
 *
 * `process.exit()` does not flush a pending stdout write, and Node writes to a
 * pipe asynchronously. So `flecto ci --format json | jq`, or any CI harness
 * capturing stdout, silently lost everything past the 64 KB pipe buffer -- and
 * still saw exit 0. A truncated envelope stream that reports success is the
 * worst shape a machine consumer can be handed: it does not look like a
 * failure, it looks like a clean run over fewer files.
 *
 * Redirecting to a file hid this, because Node writes to a file descriptor
 * synchronously. It only appeared through a pipe, which is how every consumer
 * that matters reads it.
 *
 * The callback form fires when that specific chunk drains, and stream writes
 * are ordered, so awaiting the last one means every earlier one is out too.
 *
 * The trailing newline is appended unconditionally, which is exactly what
 * `console.log` did. Adding it only when one is missing would silently drop a
 * byte from any payload that already ends in a newline -- `--format pr-comment`
 * does -- and the point of this change is that the rendered output is identical.
 * @param {string} text
 * @returns {Promise<void>}
 */
function writeStdout(text) {
  return new Promise((resolveWrite) => {
    process.stdout.write(`${text}\n`, () => resolveWrite());
  });
}

/**
 * Collapse the envelopes for files that were scanned and had nothing to report
 * into a single manifest entry.
 *
 * `ci` emits one envelope per *scanned* file rather than per *changed* file, so
 * the output grows with the size of the repository instead of the size of the
 * change -- measured on 250 service configs with one file edited, 113.4 KB of
 * output for 0.2 KB of semantic content. For a human that is invisible, because
 * the renderer already prints only what changed; it is the machine consumers
 * (webhooks, NDJSON sinks, and any agent handed the JSON) that pay for it.
 *
 * Dropping those files outright is not safe. An envelope for a scanned but
 * unchanged file is *evidence Flecto looked*, and a consumer diffing two runs
 * can tell "checked and clean" from "not checked at all" -- silently removing
 * that distinction would weaken a gate someone relies on, in the same way a
 * silently skipped plugin would. So the evidence is kept, in the one place it
 * costs almost nothing: a single `lifecycle` envelope carrying the list of
 * paths, instead of a full envelope with its own pair of UUIDs, timestamp, and
 * absolute path for every file.
 *
 * The path list rides on the result wrapper rather than the envelope, which is
 * closed by schemas/flecto-envelope-2.0.json -- the same arrangement `baseline`
 * already uses. Nothing about schema 2.0 changes, and the default output is
 * untouched, so this is opt-in rather than a reshaping of a documented contract.
 *
 * Each envelope keeps its own `batch_id`: that field is documented as grouping
 * the events from one file change, not one run.
 * @param {any[]} results
 * @returns {any[]}
 */
function collapseUnchangedResults(results) {
  const reported = [];
  /** @type {string[]} */
  const scanned = [];

  for (const result of results) {
    const hasChanges = (result.envelope.changes?.length ?? 0) > 0;
    const hasFindings = (result.envelope.policies?.length ?? 0) > 0;
    if (hasChanges || hasFindings) reported.push(result);
    else scanned.push(result.file);
  }

  if (scanned.length === 0) return reported;
  return [
    ...reported,
    {
      // No `file`: this entry is not about one file. Consumers discriminate on
      // `envelope.event_type === "lifecycle"`, which schema 2.0 already carries.
      scanned,
      envelope: createEnvelope({
        source: 'ci',
        file: '',
        lifecycle: {
          type: 'scanned',
          message:
            `${scanned.length} file${scanned.length === 1 ? '' : 's'} scanned `
            + 'with no changes and no policy findings',
        },
      }),
      policies: [],
    },
  ];
}

/**
 * Render the machine-readable CI output and wait for it to flush.
 *
 * The payload is assembled and written once rather than line by line, so a
 * caller has a single write to await -- see {@link writeStdout} for why that
 * matters. The rendered bytes are unchanged.
 * @param {any[]} results
 * @param {string} format
 * @returns {Promise<void>}
 */
async function printCiOutput(results, format) {
  if (format === 'json') {
    await writeStdout(JSON.stringify(results, null, 2));
    return;
  }
  if (format === 'ndjson') {
    if (results.length === 0) return;
    await writeStdout(results.map((result) => JSON.stringify(result)).join('\n'));
    return;
  }
  if (format === 'sarif') {
    const sarif = buildSarif(results, { cwd: process.cwd(), toolVersion: PKG.version });
    await writeStdout(JSON.stringify(sarif, null, 2));
    return;
  }
  if (format === 'github-annotations') {
    const lines = [];
    for (const result of results) {
      for (const event of result.envelope.changes) {
        const title = `flecto ${event.type}`;
        const detail = event.note ? `${event.path} (${event.note})` : event.path;
        lines.push(`::warning file=${escapeWorkflowCommandProperty(result.file)},title=${escapeWorkflowCommandProperty(title)}::${escapeWorkflowCommandData(detail)}`);
      }
      for (const finding of result.policies) {
        const level = finding.severity === 'error' ? 'error' : 'warning';
        const pack = finding.pack ? ` [${finding.pack}]` : '';
        const title = `flecto policy ${finding.id}${pack}`;
        const detail = `${finding.path}: ${finding.message}`;
        lines.push(`::${level} file=${escapeWorkflowCommandProperty(result.file)},title=${escapeWorkflowCommandProperty(title)}::${escapeWorkflowCommandData(detail)}`);
      }
    }
    if (lines.length === 0) return;
    await writeStdout(lines.join('\n'));
  }
}

/**
 * Deliver the sticky PR comment without ever changing the CI outcome: a
 * delivery problem warns, and the exit code stays with the diff/policy result.
 * @param {string} body
 * @param {boolean} enabled
 * @param {string} [provider] force a delivery adapter instead of detecting one
 */
async function deliverPrCommentSafely(body, enabled, provider) {
  if (!enabled) return;
  try {
    const result = await deliverPrComment(body, { enabled: true, provider });
    if (result.posted) {
      renderNote(`PR comment ${result.action}${result.url ? `: ${result.url}` : ''}`);
      return;
    }
    renderWarn(`Could not post the PR comment: ${result.reason}`);
  } catch (err) {
    renderWarn(`Could not post the PR comment: ${err.message}`);
  }
}

program
  .name('flecto')
  .description('Flecto — semantic config watcher for meaningful structured file changes')
  .version(PKG.version);

program
  .command('watch [files...]')
  .description('Watch config files/globs for semantic changes')
  .option('-p, --profile <name>', 'Use profile from .flectorc (else FLECTO_PROFILE)')
  .option('-i, --interval <ms>', 'Polling fallback interval in ms', '100')
  .option('--polling', 'Force polling mode (useful on network drives / some editors)', false)
  .option('-m, --mode <mode>', 'Output mode: compact | verbose', 'compact')
  .option('-c, --command <cmd>', 'Shell command to run on every change')
  .option('-w, --webhook <url>', 'POST change payload to this URL on change')
  .option('--webhook-header <header>', 'Extra webhook header (repeatable), e.g. "Authorization: Bearer TOKEN"', (v, acc) => {
    acc.push(v);
    return acc;
  }, [])
  .option('--webhook-format <service>', `Webhook payload format: ${WEBHOOK_FORMAT_CHOICES.join(' | ')}`)
  .option('--delivery-mode <mode>', 'Alert delivery mode: best-effort | at-least-once', 'best-effort')
  .option('--on-alert-failure <mode>', 'Alert failure behavior: warn | exit | retry', 'warn')
  .option('--webhook-timeout <ms>', 'Webhook timeout in ms', '5000')
  .option('--webhook-retries <n>', 'Webhook retries', '2')
  .option('--ignore <keys>', 'Comma-separated key paths to ignore (e.g. "updated_at,meta.ts")')
  .option('--policies <ids>', 'Comma-separated policy pack ids (default: default)')
  .option('--plugins <paths>', 'Comma-separated local ESM plugin paths')
  .option('--array-id-key <key>', 'Diff arrays by this object identity key')
  .option('--no-array-id', 'Diff arrays by index instead of object identity')
  .option('--array-ignore-order', 'Treat array order as insignificant', false)
  .option('--mask-secrets', 'Mask secret-like values in human output', false)
  .option('--mask-secrets-webhooks', 'Also mask secrets in webhook payloads', false)
  .option('--snapshot', 'Save current state as baseline instead of watching')
  .option('--diff', 'Diff current file against saved baseline and exit')
  .option('--allow-empty', 'Allow --snapshot to succeed when nothing was written', false)
  .action(async (files, opts, command) => {
    try {
      const { config } = loadRcConfig(process.cwd());
      const profile = resolveProfileName(opts.profile);
      const cliOverrides = stripUnsetCliOverrides(opts, command);
      const effective = resolveEffectiveOptions(config, profile, cliOverrides);
      const { policies, plugins, severityRemap } = resolvePolicyOptions(effective, { pluginsFromCli: cliOverrides.plugins !== undefined });
      const targets = (await resolveTargetFiles(files, config)).map((f) => resolve(f));
      if (targets.length === 0) {
        throw new Error('No files matched. Provide files or configure .flectorc files/include.');
      }

      const ignorePaths = parseCsv(effective.ignore);
      const webhookHeaders = parseHeaders(effective.webhookHeader);
      const interval = parseInt(String(effective.interval ?? '100'), 10);
      validateInterval(interval);
      const mode = String(effective.mode ?? 'compact');
      validateMode(mode);
      const maskSecrets = Boolean(effective.maskSecrets);
      const maskSecretsWebhooks = Boolean(effective.maskSecretsWebhooks);
      const webhookFormat = resolveWebhookFormat(effective.webhookFormat, effective.webhook);
      const dOpts = diffOptionsFromEffective(effective, ignorePaths);

      if (effective.snapshot) {
        mkdirSync(SNAPSHOT_DIR, { recursive: true });
        // Snapshots carry config values, so a .flecto-snapshots/ that is itself a
        // link out of the project would write them somewhere the repository does
        // not control. Same rule as a target, checked after mkdir so an existing
        // link is seen rather than a path that does not exist yet.
        assertTargetContained(resolve(SNAPSHOT_DIR), process.cwd());
        const idsWithHistory = snapshotIdsWithHistory();
        let written = 0;
        for (const filepath of targets) {
          if (!existsSync(filepath)) {
            renderWarn(`Skipping missing file: ${filepath}`);
            continue;
          }
          if (!isSupported(filepath)) {
            renderWarn(`Skipping unsupported file: ${filepath}`);
            continue;
          }
          const state = parseFile(filepath);
          const snapshotPath = snapshotPathForFile(filepath);
          preserveLegacySnapshotForHistory(filepath, snapshotPath, idsWithHistory);
          // Only a multi-document file records `documents`, so an ordinary
          // snapshot is byte-for-byte what it was before this field existed.
          const documents = documentKeysOf(state) ?? [];
          const snapshot = {
            file: filepath,
            state,
            ...(documents.length > 0 ? { documents: [...documents] } : {}),
            createdAt: new Date().toISOString(),
          };
          writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
          writeFileSync(snapshotHistoryPathForFile(filepath), JSON.stringify(snapshot, null, 2), 'utf8');
          // Keep the set in step with what this run has written, so a repeated
          // target behaves exactly as it did when the check hit the disk.
          idsWithHistory.add(snapshotIdForPath(filepath));
          console.log(chalk.green(`✓ Snapshot saved: ${snapshotPath}`));
          written += 1;
        }
        if (written === 0 && !effective.allowEmpty) {
          throw new Error(
            'No snapshots written — all targets were missing or unsupported.' +
              ' Pass --allow-empty to allow an empty snapshot run.',
          );
        }
        return;
      }

      if (effective.diff) {
        let hasChanges = false;
        let compared = 0;
        let missing = 0;
        for (const filepath of targets) {
          const snapshotPath = snapshotPathForFile(filepath);
          if (!existsSync(snapshotPath)) {
            renderWarn(`No snapshot found for "${filepath}"`);
            missing += 1;
            continue;
          }
          const before = readSnapshotStateFromFile(snapshotPath);
          const after = parseFile(filepath);
          const events = diffTrees(before, after, dOpts);
          renderDiff(filepath, events, { maskSecrets });
          compared += 1;
          if (events.length > 0) hasChanges = true;
        }
        // Exiting 0 having compared nothing is the worst answer available: the
        // caller reads it as "no drift" when the truth is "no baseline to drift
        // from" (#141). Snapshot history lives in the working directory, so this
        // is the normal state of a fresh CI runner.
        if (compared === 0) {
          throw new Error(
            'No snapshot found for any target, so nothing was compared.'
              + ' Run "flecto watch <file> --snapshot" first — no history is not no drift.',
          );
        }
        if (missing > 0) {
          renderNote(
            `${missing} of ${targets.length} targets had no snapshot and were not compared.`,
          );
        }
        process.exit(hasChanges ? 1 : 0);
      }

      const watchers = [];
      let closing = false;
      const closeAll = async (exitCode) => {
        if (closing) return;
        closing = true;
        await Promise.all(watchers.map((w) => w.close()));
        if (exitCode === 0) {
          console.log(chalk.dim('\nflecto stopped.'));
        }
        process.exit(exitCode);
      };
      const alertOptions = {
        command: effective.command,
        webhook: effective.webhook,
        webhookHeaders,
        webhookTimeoutMs: parseInt(String(effective.webhookTimeout ?? '5000'), 10),
        webhookRetries: parseInt(String(effective.webhookRetries ?? '2'), 10),
        webhookFormat,
        deliveryMode: effective.deliveryMode,
        onAlertFailure: effective.onAlertFailure,
      };
      const deliverAlert = async (envelope) => {
        const result = await fireAlerts(alertOptions, envelope);
        if (!result.ok && effective.onAlertFailure === 'exit') {
          await closeAll(1);
        }
      };

      for (const filepath of targets) {
        if (!existsSync(filepath)) {
          renderWarn(`Skipping missing file: ${filepath}`);
          continue;
        }
        if (!isSupported(filepath)) {
          renderWarn(`Skipping unsupported file: ${filepath}`);
          continue;
        }

        renderInfo(`flecto watching ${chalk.cyan(filepath)}`);
        const watcher = startWatcher(
          filepath,
          { interval, mode, ignorePaths, polling: Boolean(effective.polling), ...dOpts },
          async (event) => {
            if (event.kind === 'changes') {
              renderChanges(event.filepath, event.events, mode, { maskSecrets });
              let policyFindings = [];
              try {
                policyFindings = await evaluatePolicies(event.events, {
                  cwd: process.cwd(),
                  file: event.filepath,
                  profile: profile ?? null,
                  source: 'watch',
                  policies,
                  plugins,
                  severityRemap,
                });
              } catch (err) {
                renderError(`policy evaluation failed: ${err.message}`);
                process.exit(1);
              }
              renderPolicyFindings(maybeMaskFindings(policyFindings, event.events, maskSecrets));
              if (effective.command || effective.webhook) {
                const outboundChanges = maybeMaskChanges(event.events, maskSecretsWebhooks);
                const envelope = createEnvelope({
                  source: 'watch',
                  file: event.filepath,
                  changes: outboundChanges,
                  policies: maybeMaskFindings(
                    policyFindings,
                    event.events,
                    maskSecretsWebhooks,
                  ),
                });
                await deliverAlert(envelope);
              }
            } else {
              renderInfo(`[lifecycle] ${event.filepath}: ${event.lifecycle.type} - ${event.lifecycle.message}`);
              if (effective.command || effective.webhook) {
                const envelope = createEnvelope({
                  source: 'watch',
                  file: event.filepath,
                  lifecycle: event.lifecycle,
                });
                await deliverAlert(envelope);
              }
            }
          }
        );
        watchers.push(watcher);
      }

      if (watchers.length === 0) {
        throw new Error('No valid files to watch.');
      }
      renderInfo('Press Ctrl+C to stop.\n');

      process.on('SIGINT', () => void closeAll(0));
      process.on('SIGTERM', () => void closeAll(0));
    } catch (err) {
      renderError(err.message);
      process.exit(1);
    }
  });

program
  .command('history [files...]')
  .description('Summarize drift across local snapshots')
  .option('-l, --limit <n>', 'Number of recent snapshots to show', '10')
  .option('-p, --profile <name>', 'Use profile from .flectorc (else FLECTO_PROFILE)')
  .option('--ignore <keys>', 'Comma-separated key paths to ignore (e.g. "updated_at,meta.ts")')
  .option('--array-id-key <key>', 'Diff arrays by this object identity key (opt-in)')
  .option('--array-ignore-order', 'Treat array order as insignificant', false)
  .action(async (files, opts, command) => {
    try {
      const limit = Number.parseInt(String(opts.limit), 10);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error('--limit must be a positive integer');
      }

      const { config } = loadRcConfig(process.cwd());
      const profile = resolveProfileName(opts.profile);
      const cliOverrides = stripUnsetCliOverrides(opts, command);
      const effective = resolveEffectiveOptions(config, profile, cliOverrides);
      const ignorePaths = parseCsv(effective.ignore);
      const dOpts = diffOptionsFromEffective(effective, ignorePaths);

      const allSnapshots = readLocalSnapshotHistory();
      let snapshots = allSnapshots;
      if (files.length > 0) {
        const targets = new Set((await resolveTargetFiles(files, config)).map((file) => resolve(file)));
        snapshots = snapshots.filter((snapshot) => targets.has(resolve(snapshot.file)));
      }

      const summaries = summarizeSnapshotHistory(snapshots, limit, dOpts);
      if (summaries.length === 0) {
        if (files.length > 0 && allSnapshots.length > 0) {
          throw new Error(
            'No local snapshots matched the given files. Omit files to view all saved snapshot history.',
          );
        }
        throw new Error('No local snapshots found. Run "flecto watch <file> --snapshot" first.');
      }

      console.log(`Local snapshot history (${summaries.length} snapshots)`);
      let baselines = 0;
      for (const snapshot of summaries) {
        const file = relative(process.cwd(), snapshot.file) || snapshot.file;
        // A snapshot with nothing before it was never compared, so printing
        // "0 changes" for it states a result that was never computed (#141).
        if (!snapshot.previousCreatedAt) baselines += 1;
        const changes = snapshot.previousCreatedAt
          ? `${snapshot.changeCount} change${snapshot.changeCount === 1 ? '' : 's'}`
          : 'baseline (no earlier snapshot to compare against)';
        console.log(`${snapshot.createdAt}  ${file} — ${changes}`);
      }
      if (baselines === summaries.length) {
        renderNote(
          'Nothing was compared: every snapshot shown is the first of its file.'
            + ' That is no history, not no drift.',
        );
      } else if (baselines > 0) {
        renderNote(
          `${baselines} of ${summaries.length} snapshots shown are the first of their file`
            + ' and were not compared against anything.',
        );
      }
    } catch (err) {
      renderError(err.message);
      process.exit(1);
    }
  });

program
  .command('report [files...]')
  .description('Render local snapshot history as a self-contained HTML report')
  .option('-o, --output <path>', 'Write the report to this path', 'flecto-report.html')
  .option('-l, --limit <n>', 'Number of recent snapshots to include', '10')
  .option('-p, --profile <name>', 'Use profile from .flectorc (else FLECTO_PROFILE)')
  .option('--ignore <keys>', 'Comma-separated key paths to ignore (e.g. "updated_at,meta.ts")')
  .option('--policies <ids>', 'Comma-separated policy pack ids (default: default)')
  .option('--plugins <paths>', 'Comma-separated local ESM plugin paths')
  .option('--array-id-key <key>', 'Diff arrays by this object identity key')
  .option('--no-array-id', 'Diff arrays by index instead of object identity')
  .option('--array-ignore-order', 'Treat array order as insignificant', false)
  .option('--mask-secrets', 'Mask secret-like values in the report', false)
  .action(async (files, opts, command) => {
    try {
      const { config } = loadRcConfig(process.cwd());
      const profile = resolveProfileName(opts.profile);
      const cliOverrides = stripUnsetCliOverrides(opts, command);
      const effective = resolveEffectiveOptions(config, profile, cliOverrides);
      const { policies: packIds, plugins, severityRemap } = resolvePolicyOptions(effective, { pluginsFromCli: cliOverrides.plugins !== undefined });

      const limit = Number.parseInt(String(effective.limit ?? '10'), 10);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error('--limit must be a positive integer');
      }
      const ignorePaths = parseCsv(effective.ignore);
      const dOpts = diffOptionsFromEffective(effective, ignorePaths);
      const maskSecrets = Boolean(effective.maskSecrets);
      const outputPath = resolve(String(effective.output ?? 'flecto-report.html'));

      // Same snapshot source, filtering, and errors as `flecto history` — this
      // command only changes how that history is rendered.
      const allSnapshots = readLocalSnapshotHistory();
      let snapshots = allSnapshots;
      if (files.length > 0) {
        const targets = new Set((await resolveTargetFiles(files, config)).map((file) => resolve(file)));
        snapshots = snapshots.filter((snapshot) => targets.has(resolve(snapshot.file)));
      }

      const summaries = summarizeSnapshotHistory(snapshots, limit, dOpts);
      if (summaries.length === 0) {
        if (files.length > 0 && allSnapshots.length > 0) {
          throw new Error(
            'No local snapshots matched the given files. Omit files to report on all saved snapshot history.',
          );
        }
        throw new Error('No local snapshots found. Run "flecto watch <file> --snapshot" first.');
      }

      const reportSnapshots = [];
      for (const summary of summaries) {
        // Policies run on the unmasked events: masking first would hide the
        // very values the secret rules match on. Redaction happens after, on
        // everything that reaches the page.
        const findings = await evaluatePolicies(summary.changes, {
          cwd: process.cwd(),
          file: summary.file,
          profile: profile ?? null,
          source: 'diff',
          policies: packIds,
          plugins,
          severityRemap,
        });
        reportSnapshots.push({
          file: summary.file,
          createdAt: summary.createdAt,
          previousCreatedAt: summary.previousCreatedAt,
          changeCount: summary.changeCount,
          changes: maybeMaskChanges(summary.changes, maskSecrets),
          policies: maybeMaskFindings(findings, summary.changes, maskSecrets),
        });
      }

      const html = renderReportHtml({
        snapshots: reportSnapshots,
        generatedAt: new Date().toISOString(),
        cwd: process.cwd(),
        version: PKG.version,
        limit,
        maskSecrets,
      });
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, html, 'utf8');
      console.log(chalk.green(
        `✓ Report written: ${outputPath} (${summaries.length} snapshot${summaries.length === 1 ? '' : 's'})`,
      ));
    } catch (err) {
      renderError(err.message);
      process.exit(1);
    }
  });

program
  .command('ci [files...]')
  .description('Run semantic diff in CI mode')
  .option('-p, --profile <name>', 'Use profile from .flectorc (else FLECTO_PROFILE)')
  .option('--snapshot-ref <ref>', 'Snapshot reference: snapshot path or git ref')
  .option('--format <type>', 'Output format: json | ndjson | sarif | github-annotations | pr-comment', 'json')
  .option('--pr-comment-post', 'With --format pr-comment, upsert the comment on the PR (needs a token + merge request context)', false)
  .option('--pr-provider <name>', `Force the comment delivery target: ${PR_PROVIDER_IDS.join(' | ')} (default: detect from CI)`)
  .option('--fail-on <rules>', 'Comma-separated fail rules: changed,added,removed,policy,error,warn', 'changed,policy,error')
  .option('--baseline <file>', 'Gate only on findings not already recorded in this baseline file')
  .option('--update-baseline', 'Rewrite the --baseline file from the current findings (explicit, never automatic)', false)
  .option('--ignore <keys>', 'Comma-separated key paths to ignore')
  .option('--policies <ids>', 'Comma-separated policy pack ids')
  .option('--plugins <paths>', 'Comma-separated local ESM plugin paths')
  .option('--array-id-key <key>', 'Diff arrays by this object identity key')
  .option('--no-array-id', 'Diff arrays by index instead of object identity')
  .option('--array-ignore-order', 'Treat array order as insignificant', false)
  .option('--mask-secrets', 'Mask secret-like values in CI output', false)
  .option('--show-suppressed', 'List inline-suppressed findings instead of only counting them', false)
  .option('--changed-only', 'With --format json|ndjson, replace envelopes for unchanged files with one scanned manifest', false)
  .option('--allow-empty', 'Allow CI to succeed when no files were diffed', false)
  .action(async (files, opts, command) => {
    try {
      const { config } = loadRcConfig(process.cwd());
      const profile = resolveProfileName(opts.profile);
      const cliOverrides = stripUnsetCliOverrides(opts, command);
      const effective = resolveEffectiveOptions(config, profile, cliOverrides);
      const { policies: packIds, plugins, severityRemap } = resolvePolicyOptions(effective, { pluginsFromCli: cliOverrides.plugins !== undefined });
      const targets = (await resolveTargetFiles(files, config)).map((f) => resolve(f));
      if (targets.length === 0) {
        throw new Error('No files matched. Provide files or configure .flectorc files/include.');
      }

      const ignorePaths = parseCsv(effective.ignore);
      const failOn = parseFailOn(effective.failOn ?? 'changed,policy,error');
      const format = String(effective.format ?? 'json');
      if (!['json', 'ndjson', 'sarif', 'github-annotations', 'pr-comment'].includes(format)) {
        throw new Error('--format must be json, ndjson, sarif, github-annotations, or pr-comment');
      }
      const prCommentPost = Boolean(effective.prCommentPost);
      if (effective.prProvider && !PR_PROVIDER_IDS.includes(String(effective.prProvider))) {
        throw new Error(`--pr-provider must be one of: ${PR_PROVIDER_IDS.join(', ')}`);
      }
      if (prCommentPost && format !== 'pr-comment') {
        renderWarn('Ignoring --pr-comment-post: it only applies to --format pr-comment.');
      }
      const maskSecrets = Boolean(effective.maskSecrets);
      const showSuppressed = Boolean(effective.showSuppressed);
      const changedOnly = Boolean(effective.changedOnly);
      // github-annotations and pr-comment already render only what changed, so
      // there is nothing for the flag to collapse there. Say so rather than
      // accepting it and quietly doing nothing.
      if (changedOnly && format !== 'json' && format !== 'ndjson') {
        renderWarn(`Ignoring --changed-only: it only applies to --format json or ndjson (got ${format}).`);
      }
      const dOpts = diffOptionsFromEffective(effective, ignorePaths);

      const cwd = process.cwd();
      const baselinePath = effective.baseline ? resolve(cwd, String(effective.baseline)) : null;
      const updateBaseline = Boolean(effective.updateBaseline);
      if (updateBaseline && !baselinePath) {
        throw new Error('--update-baseline requires --baseline <file> naming the file to write.');
      }

      /** @type {Array<{ filepath: string, relFile: string, outboundChanges: any[], outboundFindings: any[], changesFail: boolean }>} */
      const perFile = [];
      /** @type {Array<{ file: string, finding: any, reason: string }>} */
      const allSuppressed = [];
      let diffed = 0;

      for (const filepath of targets) {
        if (!existsSync(filepath)) {
          renderWarn(`Skipping missing file: ${filepath}`);
          continue;
        }
        if (!isSupported(filepath)) {
          renderWarn(`Skipping unsupported file: ${filepath}`);
          continue;
        }
        const after = parseFile(filepath);
        let before;
        try {
          before = readSnapshotStateFromRef(filepath, effective.snapshotRef);
        } catch (err) {
          throw new Error(
            `Failed to resolve snapshot baseline for "${filepath}"` +
            `${effective.snapshotRef ? ` (ref: ${effective.snapshotRef})` : ''}: ${err.message}`
          );
        }
        const events = diffTrees(before, after, dOpts);
        const rawFindings = await evaluatePolicies(events, {
          cwd,
          file: filepath,
          profile: profile ?? null,
          source: 'ci',
          policies: packIds,
          plugins,
          severityRemap,
        });

        // Inline suppressions run first: a deliberately-accepted finding is
        // removed before the baseline, the gate, and the output ever see it, so
        // it is never also counted by a baseline. A directive missing its
        // mandatory reason is refused loudly rather than applied.
        const { active: policyFindings, suppressed } = resolveSuppressed(filepath, rawFindings);
        for (const item of suppressed) {
          allSuppressed.push({ file: filepath, finding: item.finding, reason: item.reason });
        }

        perFile.push({
          filepath,
          relFile: baselineRelativePath(filepath, cwd),
          outboundChanges: maybeMaskChanges(events, maskSecrets),
          outboundFindings: maybeMaskFindings(policyFindings, events, maskSecrets),
          changesFail: shouldFailFromChanges(events, failOn),
        });
        diffed += 1;
      }

      if (diffed === 0 && !effective.allowEmpty) {
        throw new Error(
          'No files were diffed — all targets were missing or unsupported.' +
            ' Pass --allow-empty to allow an empty CI run.',
        );
      }

      // Suppressed findings are still surfaced — a count by default, the full
      // list with --show-suppressed — so a gate you cannot see the shape of does
      // not quietly grow. All of this goes to stderr, leaving machine output clean.
      if (allSuppressed.length > 0) {
        renderNote(
          `${allSuppressed.length} finding${allSuppressed.length === 1 ? '' : 's'} suppressed inline`
          + `${showSuppressed ? ':' : ' (use --show-suppressed to list them).'}`,
        );
        if (showSuppressed) {
          for (const { file, finding, reason } of allSuppressed) {
            const rel = relative(cwd, file) || file;
            renderNote(`  ${rel} ${finding.path}: ${finding.id} — ${reason}`);
          }
        }
      }

      // Every finding this run produced, paired with its repo-relative file, so
      // the baseline can be matched, updated, and stale-checked on stable keys.
      const located = perFile.flatMap((f) =>
        f.outboundFindings.map((finding) => ({ file: f.relFile, finding })));

      // Without a baseline, every finding is active — behavior is unchanged.
      let activeByFile = new Map(perFile.map((f) => [f.relFile, f.outboundFindings]));
      let baselineSummary = null;
      if (baselinePath) {
        const { entries: recorded } = loadBaseline(baselinePath);

        if (updateBaseline) {
          // Recording the current state accepts all of it: the file is rewritten
          // from every finding, and nothing is "new" relative to what was just
          // written, so the gate passes on the policy axis.
          writeBaselineFile(baselinePath, buildBaselineFile(located, recorded));
          renderNote(
            `Baseline updated: ${baselineRelativePath(baselinePath, cwd)} `
            + `(${located.length} finding${located.length === 1 ? '' : 's'} recorded)`,
          );
          activeByFile = new Map();
          baselineSummary = { active: 0, accepted: located.length, stale: [] };
        } else {
          const { active, accepted, stale } = applyBaseline(located, recorded);
          const activeMap = new Map();
          for (const { file, finding } of active) {
            if (!activeMap.has(file)) activeMap.set(file, []);
            activeMap.get(file).push(finding);
          }
          activeByFile = activeMap;
          baselineSummary = { active: active.length, accepted: accepted.length, stale };
        }
      }

      // Results reflect the *active* findings: with a baseline in effect, an
      // accepted finding is suppressed from output as well as from the gate, so a
      // green run is not buried under hundreds of already-accepted findings.
      const results = perFile.map((f) => {
        const active = activeByFile.get(f.relFile) ?? [];
        return {
          file: f.filepath,
          envelope: createEnvelope({
            source: 'ci',
            file: f.filepath,
            changes: f.outboundChanges,
            policies: active,
          }),
          policies: active,
        };
      });

      // With --update-baseline everything is now accepted, so there are no active
      // findings to gate on; the policy gate simply passes. Change-based triggers
      // are about the diff, not the findings, so they still apply.
      const activeFindings = results.flatMap((r) => r.policies);
      const shouldFail = perFile.some((f) => f.changesFail)
        || shouldFailFromPolicy(activeFindings, failOn);

      if (baselineSummary) {
        const parts = [`${baselineSummary.active} new`, `${baselineSummary.accepted} baselined`];
        if (baselineSummary.stale.length > 0) parts.push(`${baselineSummary.stale.length} stale`);
        renderNote(`Baseline: ${parts.join(', ')}.`);
        if (baselineSummary.stale.length > 0 && !updateBaseline) {
          renderWarn(
            `${baselineSummary.stale.length} baseline `
            + `${baselineSummary.stale.length === 1 ? 'entry no longer occurs' : 'entries no longer occur'}; `
            + 're-run with --update-baseline to prune.',
          );
        }
      }

      if (format === 'pr-comment') {
        const body = renderPrComment(results, { cwd, failed: shouldFail });
        await writeStdout(body);
        await deliverPrCommentSafely(body, prCommentPost, effective.prProvider);
      } else {
        const collapsible = changedOnly && (format === 'json' || format === 'ndjson');
        await printCiOutput(collapsible ? collapseUnchangedResults(results) : results, format);
      }
      process.exit(shouldFail ? 1 : 0);
    } catch (err) {
      renderError(err.message);
      process.exit(1);
    }
  });

program
  .command('plan <planFiles...>')
  .description('Diff Terraform plan JSON (terraform show -json) and run policies on it')
  .option('-p, --profile <name>', 'Use profile from .flectorc (else FLECTO_PROFILE)')
  .option('--format <type>', 'Output format: human | json | ndjson | github-annotations | pr-comment', 'human')
  .option('--pr-comment-post', 'With --format pr-comment, upsert the comment on the PR (needs a token + merge request context)', false)
  .option('--pr-provider <name>', `Force the comment delivery target: ${PR_PROVIDER_IDS.join(' | ')} (default: detect from CI)`)
  .option('--fail-on <rules>', 'Comma-separated fail rules: changed,added,removed,policy,error,warn', PLAN_DEFAULT_FAIL_ON)
  .option('--ignore <keys>', 'Comma-separated key paths to ignore, e.g. "**.tags_all,**.#action"')
  .option('--policies <ids>', `Comma-separated policy pack ids (default: ${PLAN_DEFAULT_POLICIES})`)
  .option('--plugins <paths>', 'Comma-separated local ESM plugin paths')
  .option('--mask-secrets', 'Also mask Flecto-detected secret-like values (Terraform-sensitive values are always redacted)', false)
  .action(async (planFiles, opts, command) => {
    try {
      const { config } = loadRcConfig(process.cwd());
      const profile = resolveProfileName(opts.profile);
      const cliOverrides = stripUnsetCliOverrides(opts, command);
      const effective = resolveEffectiveOptions(config, profile, cliOverrides);
      // A plan carries Terraform-shaped paths, so the config-file packs are not
      // the useful default here; `terraform` is. An explicit --policies or a
      // .flectorc entry still wins.
      const { policies: packIds, plugins, severityRemap } = resolvePolicyOptions(
        effective.policies === undefined
          ? { ...effective, policies: PLAN_DEFAULT_POLICIES }
          : effective,
        { pluginsFromCli: cliOverrides.plugins !== undefined },
      );

      const ignorePaths = parseCsv(effective.ignore);
      const failOn = new Set(parseCsv(effective.failOn ?? PLAN_DEFAULT_FAIL_ON));
      const format = String(effective.format ?? 'human');
      if (!['human', 'json', 'ndjson', 'github-annotations', 'pr-comment'].includes(format)) {
        throw new Error('--format must be human, json, ndjson, github-annotations, or pr-comment');
      }
      const prCommentPost = Boolean(effective.prCommentPost);
      if (effective.prProvider && !PR_PROVIDER_IDS.includes(String(effective.prProvider))) {
        throw new Error(`--pr-provider must be one of: ${PR_PROVIDER_IDS.join(', ')}`);
      }
      if (prCommentPost && format !== 'pr-comment') {
        renderWarn('Ignoring --pr-comment-post: it only applies to --format pr-comment.');
      }
      const maskSecrets = Boolean(effective.maskSecrets);

      /** @type {any[]} */
      const results = [];
      let shouldFail = false;

      for (const planFile of planFiles) {
        const filepath = resolve(planFile);
        if (!existsSync(filepath)) {
          throw new Error(`File not found: ${filepath}`);
        }
        const plan = readTerraformPlanFile(filepath);
        const { changes, summary, formatVersion, terraformVersion, warnings } =
          diffTerraformPlan(plan, { ignorePaths });
        for (const warning of warnings) renderWarn(warning);

        // Terraform-sensitive values were already replaced during conversion,
        // so policies never see them. --mask-secrets adds Flecto's own
        // value-shaped detection on top, for credentials Terraform did not mark.
        const policyFindings = await evaluatePolicies(changes, {
          cwd: process.cwd(),
          file: filepath,
          profile: profile ?? null,
          source: 'ci',
          policies: packIds,
          plugins,
          severityRemap,
        });
        const outboundChanges = maybeMaskChanges(changes, maskSecrets);
        const envelope = createEnvelope({
          source: 'ci',
          file: filepath,
          changes: outboundChanges,
          policies: maybeMaskFindings(policyFindings, maskSecrets),
        });
        results.push({ file: filepath, envelope, policies: envelope.policies });

        if (format === 'human') {
          const version = [
            formatVersion ? `plan format ${formatVersion}` : null,
            terraformVersion ? `terraform ${terraformVersion}` : null,
          ].filter(Boolean).join(', ');
          renderInfo(`${filepath}${version ? ` — ${version}` : ''}`);
          renderInfo(formatPlanSummary(summary));
          renderDiff(filepath, outboundChanges, { maskSecrets, baseline: 'the current state' });
          renderPolicyFindings(envelope.policies);
        }

        if (shouldFailFromChanges(changes, failOn) || shouldFailFromPolicy(policyFindings, failOn)) {
          shouldFail = true;
        }
      }

      if (format === 'pr-comment') {
        const body = renderPrComment(results, { cwd: process.cwd(), failed: shouldFail });
        await writeStdout(body);
        await deliverPrCommentSafely(body, prCommentPost, effective.prProvider);
      } else if (format !== 'human') {
        await printCiOutput(results, format);
      }
      process.exit(shouldFail ? 1 : 0);
    } catch (err) {
      renderError(err.message);
      process.exit(1);
    }
  });

program
  .command('compare <fileA> <fileB>')
  .description('Diff two config files against each other (fileA is the baseline)')
  .option('-p, --profile <name>', 'Use profile from .flectorc (else FLECTO_PROFILE)')
  .option('--format <type>', 'Output format: human | json | ndjson | github-annotations', 'human')
  .option('--fail-on <rules>', 'Comma-separated fail rules: changed,added,removed,policy,error,warn', 'changed,added,removed,policy,error')
  .option('--ignore <keys>', 'Comma-separated key paths to ignore')
  .option('--policies <ids>', 'Comma-separated policy pack ids')
  .option('--plugins <paths>', 'Comma-separated local ESM plugin paths')
  .option('--array-id-key <key>', 'Diff arrays by this object identity key')
  .option('--no-array-id', 'Diff arrays by index instead of object identity')
  .option('--array-ignore-order', 'Treat array order as insignificant', false)
  .option('--mask-secrets', 'Mask secret-like values in output', false)
  .action(async (fileA, fileB, opts, command) => {
    try {
      const { config } = loadRcConfig(process.cwd());
      const profile = resolveProfileName(opts.profile);
      const cliOverrides = stripUnsetCliOverrides(opts, command);
      const effective = resolveEffectiveOptions(config, profile, cliOverrides);
      const { policies: packIds, plugins, severityRemap } = resolvePolicyOptions(effective, { pluginsFromCli: cliOverrides.plugins !== undefined });

      const ignorePaths = parseCsv(effective.ignore);
      const failOn = parseFailOn(effective.failOn ?? 'changed,added,removed,policy,error');
      const format = String(effective.format ?? 'human');
      if (!['human', 'json', 'ndjson', 'github-annotations'].includes(format)) {
        throw new Error('--format must be human, json, ndjson, or github-annotations');
      }
      const maskSecrets = Boolean(effective.maskSecrets);
      const dOpts = diffOptionsFromEffective(effective, ignorePaths);

      const baselinePath = resolve(fileA);
      const targetPath = resolve(fileB);
      // Both sides are named explicitly, so a missing one is an error rather
      // than the skip-and-warn `ci` applies to expanded globs.
      for (const filepath of [baselinePath, targetPath]) {
        if (!existsSync(filepath)) {
          throw new Error(`File not found: ${filepath}`);
        }
      }

      // fileA is the baseline: "removed" is present only in fileA, "added" only
      // in fileB. Every format parses to a plain tree, so the two sides need not
      // share one — parseFile rejects unsupported extensions with the same
      // message every other command uses.
      const before = parseFile(baselinePath);
      const after = parseFile(targetPath);
      const events = diffTrees(before, after, dOpts);
      const policyFindings = await evaluatePolicies(events, {
        cwd: process.cwd(),
        file: targetPath,
        profile: profile ?? null,
        source: 'diff',
        policies: packIds,
        plugins,
        severityRemap,
      });
      const outboundFindings = maybeMaskFindings(policyFindings, events, maskSecrets);

      if (format === 'human') {
        if (events.length > 0) {
          renderInfo('"+" exists only in the compared file, "-" only in the baseline, "~" differs');
        }
        renderDiff(targetPath, events, { maskSecrets, baseline: baselinePath });
        renderPolicyFindings(outboundFindings);
      } else {
        const envelope = createEnvelope({
          source: 'diff',
          file: targetPath,
          changes: maybeMaskChanges(events, maskSecrets),
          policies: outboundFindings,
        });
        // Same envelope and printer as `ci`, so machine consumers see one shape.
        // `baseline` rides on the result wrapper rather than the envelope, which
        // is closed by schemas/flecto-envelope-2.0.json.
        await printCiOutput(
          [{ file: targetPath, baseline: baselinePath, envelope, policies: outboundFindings }],
          format,
        );
      }

      const shouldFail = shouldFailFromChanges(events, failOn)
        || shouldFailFromPolicy(policyFindings, failOn);
      process.exit(shouldFail ? 1 : 0);
    } catch (err) {
      renderError(err.message);
      process.exit(1);
    }
  });

{
  const policies = program
    .command('policies')
    .description('Work with policy packs and plugins');

  policies
    .command('test <fixtureDir>')
    .description('Assert policy findings from a fixture directory')
    .option('--config <name>', 'Fixture config file name', 'flecto-policy-test.json')
    .action(async (fixtureDir, opts) => {
      try {
        const result = await testPolicyFixture(fixtureDir, { configName: opts.config });
        console.log(chalk.green(
          `✓ Policy fixture passed: ${result.fixtureDir} (${result.findings.length} findings)`,
        ));
      } catch (err) {
        renderError(err.message);
        process.exitCode = 1;
      }
    });

  policies
    .command('list')
    .description('List built-in and local policy packs')
    .option('--json', 'Output machine-readable JSON')
    .action((opts) => {
      try {
        const packs = listPolicyPacks(process.cwd());
        if (opts.json) {
          console.log(JSON.stringify(packs, null, 2));
          return;
        }

        console.log('Resolution order: policies/<id>.json, .yaml, .yml, then built-in packs.');
        console.log('id\tsource path\trules\toverrides builtin\tpackage');
        for (const pack of packs) {
          console.log(
            `${pack.id}\t${pack.sourcePath}\t${pack.ruleCount}\t${pack.overridesBuiltin ? 'yes' : 'no'}\t${pack.package ?? '-'}`,
          );
        }
      } catch (err) {
        renderError(err.message);
        process.exit(1);
      }
    });

  policies
    .command('add <name>')
    .description('Install a policy pack from an installed flecto-pack-* npm package')
    .option('--force', 'Overwrite an existing local pack with the same id')
    .action((name, opts) => {
      try {
        const added = addPolicyPackFromPackage(name, {
          cwd: process.cwd(),
          force: Boolean(opts.force),
        });
        const version = added.packageVersion ? `@${added.packageVersion}` : '';
        const verb = added.overwritten ? 'Updated' : 'Added';
        renderInfo(
          `${verb} policy pack "${added.id}" from ${added.packageName}${version} `
          + `→ ${relative(process.cwd(), added.targetPath)} `
          + `(${added.ruleCount} rule${added.ruleCount === 1 ? '' : 's'})`,
        );
        if (added.overridesBuiltin) {
          renderWarn(`Pack "${added.id}" now overrides the built-in pack of the same id.`);
        }
        for (const path of added.shadowed) {
          renderWarn(`${relative(process.cwd(), path)} is no longer used: ${added.id}.json wins.`);
        }
        if (added.shipsCode) {
          renderInfo(
            `${added.packageName} also ships JavaScript. It was ignored: only the declarative `
            + 'pack file is read, and no package code is ever imported or run.',
          );
        }
        renderInfo(`Activate it with: flecto ci <files> --policies ${added.id}`);
      } catch (err) {
        renderError(err.message);
        process.exit(1);
      }
    });
}

program
  .command('init')
  .description('Create starter .flectorc configuration from detected stack signals')
  .action(() => {
    const { path, created, detection } = initRcFile(process.cwd());
    if (!created) {
      renderWarn(`Config already exists: ${path} (left unchanged)`);
      return;
    }
    renderInfo(`Initialized config: ${path}`);
    if (detection.signals.length === 0) {
      renderInfo('No stack signals detected — wrote the generic starter config.');
      return;
    }
    for (const signal of detection.signals) {
      renderInfo(signal.summary);
    }
    renderInfo(`Policy packs: ${detection.packs.join(', ')}`);
  });

program
  .command('doctor')
  .description('Check Flecto setup, config, and environment')
  .action(async () => {
    try {
      const { path, config } = loadRcConfig(process.cwd());
      if (path) {
        renderInfo(`config: ${path}`);
      } else {
        renderWarn('No .flectorc found (optional). Run "flecto init" to scaffold.');
      }

      const files = await resolveFiles({
        cwd: process.cwd(),
        files: config?.files ?? [],
        include: config?.include ?? [],
        exclude: config?.exclude ?? [],
      });
      renderInfo(`resolved files: ${files.length}`);
      const [major, minor] = process.versions.node.split('.').map(Number);
      if (major < 20 || (major === 20 && minor < 19)) {
        throw new Error(`Node.js ${process.versions.node} is unsupported. Use Node.js >= 20.19.0.`);
      }
      renderInfo(`node: ${process.versions.node}`);
      if (typeof fetch !== 'function') {
        throw new Error('Global fetch unavailable. Use Node.js >= 20.19.0.');
      }
      renderInfo('fetch: available');
      renderInfo(`version: ${PKG.version}`);
      renderInfo('doctor: OK');
    } catch (err) {
      renderError(`doctor failed: ${err.message}`);
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);

if (!process.argv.slice(2).length) {
  program.help();
}
