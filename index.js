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
    return [...new Set([...direct, ...expanded])];
  }

  return resolveFiles({
    cwd: process.cwd(),
    files: rcConfig?.files ?? [],
    include: rcConfig?.include ?? [],
    exclude: rcConfig?.exclude ?? [],
  });
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
 * @param {string} path
 * @returns {string}
 */
function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function readSnapshotStateFromRef(filePath, snapshotRef) {
  if (!snapshotRef) return readSnapshotStateFromFile(snapshotPathForFile(filePath));
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
 * fail the build confusingly. JSON (no comment syntax) has no suppressions.
 * @param {string} filepath
 * @param {import('./src/policy.js').PolicyFinding[]} findings
 * @returns {{ active: any[], suppressed: Array<{ finding: any, reason: string }> }}
 */
function resolveSuppressed(filepath, findings) {
  const format = suppressionFormat(filepath);
  if (!format) return { active: findings, suppressed: [] };

  let raw;
  try {
    raw = readFileSync(filepath, 'utf8');
  } catch {
    return { active: findings, suppressed: [] };
  }
  const { suppressions, errors } = parseSuppressions(raw, format);
  if (errors.length > 0) {
    const rel = relative(process.cwd(), filepath) || filepath;
    const detail = errors.map((e) => `  ${rel}:${e.line}: ${e.message}`).join('\n');
    throw new Error(`Inline suppression is missing a required reason:\n${detail}`);
  }
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

function printCiOutput(results, format) {
  if (format === 'json') {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (format === 'ndjson') {
    for (const result of results) {
      console.log(JSON.stringify(result));
    }
    return;
  }
  if (format === 'github-annotations') {
    for (const result of results) {
      for (const event of result.envelope.changes) {
        const title = `flecto ${event.type}`;
        const detail = event.note ? `${event.path} (${event.note})` : event.path;
        console.log(`::warning file=${escapeWorkflowCommandProperty(result.file)},title=${escapeWorkflowCommandProperty(title)}::${escapeWorkflowCommandData(detail)}`);
      }
      for (const finding of result.policies) {
        const level = finding.severity === 'error' ? 'error' : 'warning';
        const pack = finding.pack ? ` [${finding.pack}]` : '';
        const title = `flecto policy ${finding.id}${pack}`;
        const detail = `${finding.path}: ${finding.message}`;
        console.log(`::${level} file=${escapeWorkflowCommandProperty(result.file)},title=${escapeWorkflowCommandProperty(title)}::${escapeWorkflowCommandData(detail)}`);
      }
    }
  }
}

/**
 * Deliver the sticky PR comment without ever changing the CI outcome: a
 * delivery problem warns, and the exit code stays with the diff/policy result.
 * @param {string} body
 * @param {boolean} enabled
 */
async function deliverPrCommentSafely(body, enabled) {
  if (!enabled) return;
  try {
    const result = await deliverPrComment(body, { enabled: true });
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
        for (const filepath of targets) {
          const snapshotPath = snapshotPathForFile(filepath);
          if (!existsSync(snapshotPath)) {
            renderWarn(`No snapshot found for "${filepath}"`);
            continue;
          }
          const before = readSnapshotStateFromFile(snapshotPath);
          const after = parseFile(filepath);
          const events = diffTrees(before, after, dOpts);
          renderDiff(filepath, events, { maskSecrets });
          if (events.length > 0) hasChanges = true;
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
      for (const snapshot of summaries) {
        const file = relative(process.cwd(), snapshot.file) || snapshot.file;
        const changes = `${snapshot.changeCount} change${snapshot.changeCount === 1 ? '' : 's'}`;
        console.log(`${snapshot.createdAt}  ${file} — ${changes}`);
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
  .option('--format <type>', 'Output format: json | ndjson | github-annotations | pr-comment', 'json')
  .option('--pr-comment-post', 'With --format pr-comment, upsert the comment on the PR (needs GITHUB_TOKEN + PR context)', false)
  .option('--fail-on <rules>', 'Comma-separated fail rules: changed,added,removed,policy,error,warn', 'changed,policy,error')
  .option('--ignore <keys>', 'Comma-separated key paths to ignore')
  .option('--policies <ids>', 'Comma-separated policy pack ids')
  .option('--plugins <paths>', 'Comma-separated local ESM plugin paths')
  .option('--array-id-key <key>', 'Diff arrays by this object identity key')
  .option('--no-array-id', 'Diff arrays by index instead of object identity')
  .option('--array-ignore-order', 'Treat array order as insignificant', false)
  .option('--mask-secrets', 'Mask secret-like values in CI output', false)
  .option('--show-suppressed', 'List inline-suppressed findings instead of only counting them', false)
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
      if (!['json', 'ndjson', 'github-annotations', 'pr-comment'].includes(format)) {
        throw new Error('--format must be json, ndjson, github-annotations, or pr-comment');
      }
      const prCommentPost = Boolean(effective.prCommentPost);
      if (prCommentPost && format !== 'pr-comment') {
        renderWarn('Ignoring --pr-comment-post: it only applies to --format pr-comment.');
      }
      const maskSecrets = Boolean(effective.maskSecrets);
      const showSuppressed = Boolean(effective.showSuppressed);
      const dOpts = diffOptionsFromEffective(effective, ignorePaths);

      /** @type {any[]} */
      const results = [];
      /** @type {Array<{ file: string, finding: any, reason: string }>} */
      const allSuppressed = [];
      let shouldFail = false;
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
          cwd: process.cwd(),
          file: filepath,
          profile: profile ?? null,
          source: 'ci',
          policies: packIds,
          plugins,
          severityRemap,
        });

        // Inline suppressions remove a deliberately-accepted finding before the
        // gate and the output see it. A directive missing its mandatory reason is
        // refused loudly rather than applied — resolveSuppressed throws.
        const { active: policyFindings, suppressed } = resolveSuppressed(filepath, rawFindings);
        for (const item of suppressed) {
          allSuppressed.push({ file: filepath, finding: item.finding, reason: item.reason });
        }

        const outboundChanges = maybeMaskChanges(events, maskSecrets);
        const outboundFindings = maybeMaskFindings(policyFindings, events, maskSecrets);
        const envelope = createEnvelope({
          source: 'ci',
          file: filepath,
          changes: outboundChanges,
          policies: outboundFindings,
        });
        results.push({ file: filepath, envelope, policies: outboundFindings });
        diffed += 1;

        if (shouldFailFromChanges(events, failOn) || shouldFailFromPolicy(policyFindings, failOn)) {
          shouldFail = true;
        }
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
            const rel = relative(process.cwd(), file) || file;
            renderNote(`  ${rel} ${finding.path}: ${finding.id} — ${reason}`);
          }
        }
      }

      if (format === 'pr-comment') {
        const body = renderPrComment(results, { cwd: process.cwd(), failed: shouldFail });
        console.log(body);
        await deliverPrCommentSafely(body, prCommentPost);
      } else {
        printCiOutput(results, format);
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
  .option('--pr-comment-post', 'With --format pr-comment, upsert the comment on the PR (needs GITHUB_TOKEN + PR context)', false)
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
        console.log(body);
        await deliverPrCommentSafely(body, prCommentPost);
      } else if (format !== 'human') {
        printCiOutput(results, format);
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
        printCiOutput(
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
