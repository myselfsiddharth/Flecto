#!/usr/bin/env node

import { program } from 'commander';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, relative, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import chalk from 'chalk';

import { parseFile, isSupported, parseContent } from './src/parser.js';
import { diffTrees } from './src/differ.js';
import { startWatcher } from './src/watcher.js';
import {
  renderChanges,
  renderDiff,
  renderError,
  renderInfo,
  renderWarn,
  renderPolicyFindings,
  maskChangeEvent,
} from './src/renderer.js';
import { fireAlerts } from './src/alerter.js';
import { createEnvelope } from './src/envelope.js';
import { evaluatePolicies, highestSeverity, listPolicyPacks } from './src/policy.js';
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

function hasSnapshotHistoryForFile(absPath) {
  if (!existsSync(SNAPSHOT_DIR)) return false;
  const id = snapshotIdForPath(absPath);
  return readdirSync(SNAPSHOT_DIR).some((name) => new RegExp(`^${id}\\.\\d+\\.json$`).test(name));
}

function preserveLegacySnapshotForHistory(absPath, snapshotPath) {
  if (!existsSync(snapshotPath) || hasSnapshotHistoryForFile(absPath)) return;

  const legacy = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  writeFileSync(
    snapshotHistoryPathForFile(absPath),
    JSON.stringify({
      file: legacy.file ?? absPath,
      state: legacy.state ?? legacy,
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
    const state = snapshot?.state ?? snapshot;
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
      summaries.push({
        ...records[index],
        changeCount: index === 0
          ? 0
          : diffTrees(records[index - 1].state, records[index].state, diffOpts).length,
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
    files: rcConfig?.files ?? rcConfig?.include ?? [],
    exclude: rcConfig?.exclude ?? [],
  });
}

function readSnapshotStateFromFile(snapshotPath) {
  const snap = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  return snap?.state ?? snap;
}

function readSnapshotStateFromRef(filePath, snapshotRef) {
  if (!snapshotRef) return readSnapshotStateFromFile(snapshotPathForFile(filePath));
  const maybePath = resolve(snapshotRef);
  if (existsSync(maybePath)) {
    return readSnapshotStateFromFile(maybePath);
  }

  const rel = relative(process.cwd(), filePath).replaceAll('\\', '/');
  const raw = execFileSync('git', ['show', `${snapshotRef}:${rel}`], { encoding: 'utf8' });
  return parseContent(filePath, raw);
}

function shouldFailFromPolicy(findings, failOn) {
  if (failOn.has('policy') && findings.length > 0) return true;
  if (failOn.has('error') && highestSeverity(findings) === 'error') return true;
  if (failOn.has('warn') && (highestSeverity(findings) === 'warn' || highestSeverity(findings) === 'error')) return true;
  return false;
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
      const effective = resolveEffectiveOptions(config, profile, stripUnsetCliOverrides(opts, command));
      const { policies, plugins, severityRemap } = resolvePolicyOptions(effective);
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
      const dOpts = diffOptionsFromEffective(effective, ignorePaths);

      if (effective.snapshot) {
        mkdirSync(SNAPSHOT_DIR, { recursive: true });
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
          preserveLegacySnapshotForHistory(filepath, snapshotPath);
          const snapshot = { file: filepath, state, createdAt: new Date().toISOString() };
          writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
          writeFileSync(snapshotHistoryPathForFile(filepath), JSON.stringify(snapshot, null, 2), 'utf8');
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
              renderPolicyFindings(policyFindings);
              if (effective.command || effective.webhook) {
                const outboundChanges = maybeMaskChanges(event.events, maskSecretsWebhooks);
                const envelope = createEnvelope({
                  source: 'watch',
                  file: event.filepath,
                  changes: outboundChanges,
                  policies: policyFindings,
                });
                await fireAlerts({
                  command: effective.command,
                  webhook: effective.webhook,
                  webhookHeaders,
                  webhookTimeoutMs: parseInt(String(effective.webhookTimeout ?? '5000'), 10),
                  webhookRetries: parseInt(String(effective.webhookRetries ?? '2'), 10),
                  deliveryMode: effective.deliveryMode,
                  onAlertFailure: effective.onAlertFailure,
                }, envelope);
              }
            } else {
              renderInfo(`[lifecycle] ${event.filepath}: ${event.lifecycle.type} - ${event.lifecycle.message}`);
              if (effective.command || effective.webhook) {
                const envelope = createEnvelope({
                  source: 'watch',
                  file: event.filepath,
                  lifecycle: event.lifecycle,
                });
                await fireAlerts({
                  command: effective.command,
                  webhook: effective.webhook,
                  webhookHeaders,
                  webhookTimeoutMs: parseInt(String(effective.webhookTimeout ?? '5000'), 10),
                  webhookRetries: parseInt(String(effective.webhookRetries ?? '2'), 10),
                  deliveryMode: effective.deliveryMode,
                  onAlertFailure: effective.onAlertFailure,
                }, envelope);
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

      const closeAll = async (exitCode) => {
        await Promise.all(watchers.map((w) => w.close()));
        if (exitCode === 0) {
          console.log(chalk.dim('\nflecto stopped.'));
        }
        process.exit(exitCode);
      };
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
      const effective = resolveEffectiveOptions(config, profile, stripUnsetCliOverrides(opts, command));
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
  .command('ci [files...]')
  .description('Run semantic diff in CI mode')
  .option('-p, --profile <name>', 'Use profile from .flectorc (else FLECTO_PROFILE)')
  .option('--snapshot-ref <ref>', 'Snapshot reference: snapshot path or git ref')
  .option('--format <type>', 'Output format: json | ndjson | github-annotations', 'json')
  .option('--fail-on <rules>', 'Comma-separated fail rules: changed,added,removed,policy,error,warn', 'changed,policy,error')
  .option('--ignore <keys>', 'Comma-separated key paths to ignore')
  .option('--policies <ids>', 'Comma-separated policy pack ids')
  .option('--plugins <paths>', 'Comma-separated local ESM plugin paths')
  .option('--array-id-key <key>', 'Diff arrays by this object identity key')
  .option('--no-array-id', 'Diff arrays by index instead of object identity')
  .option('--array-ignore-order', 'Treat array order as insignificant', false)
  .option('--mask-secrets', 'Mask secret-like values in CI output', false)
  .option('--allow-empty', 'Allow CI to succeed when no files were diffed', false)
  .action(async (files, opts, command) => {
    try {
      const { config } = loadRcConfig(process.cwd());
      const profile = resolveProfileName(opts.profile);
      const effective = resolveEffectiveOptions(config, profile, stripUnsetCliOverrides(opts, command));
      const { policies: packIds, plugins, severityRemap } = resolvePolicyOptions(effective);
      const targets = (await resolveTargetFiles(files, config)).map((f) => resolve(f));
      if (targets.length === 0) {
        throw new Error('No files matched. Provide files or configure .flectorc files/include.');
      }

      const ignorePaths = parseCsv(effective.ignore);
      const failOn = new Set(parseCsv(effective.failOn ?? 'changed,policy,error'));
      const format = String(effective.format ?? 'json');
      if (!['json', 'ndjson', 'github-annotations'].includes(format)) {
        throw new Error('--format must be json, ndjson, or github-annotations');
      }
      const maskSecrets = Boolean(effective.maskSecrets);
      const dOpts = diffOptionsFromEffective(effective, ignorePaths);

      /** @type {any[]} */
      const results = [];
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
        const policyFindings = await evaluatePolicies(events, {
          cwd: process.cwd(),
          file: filepath,
          profile: profile ?? null,
          source: 'ci',
          policies: packIds,
          plugins,
          severityRemap,
        });
        const outboundChanges = maybeMaskChanges(events, maskSecrets);
        const envelope = createEnvelope({
          source: 'ci',
          file: filepath,
          changes: outboundChanges,
          policies: policyFindings,
        });
        results.push({ file: filepath, envelope, policies: policyFindings });
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

      printCiOutput(results, format);
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
        console.log('id\tsource path\trules\toverrides builtin');
        for (const pack of packs) {
          console.log(
            `${pack.id}\t${pack.sourcePath}\t${pack.ruleCount}\t${pack.overridesBuiltin ? 'yes' : 'no'}`,
          );
        }
      } catch (err) {
        renderError(err.message);
        process.exit(1);
      }
    });
}

program
  .command('init')
  .description('Create starter .flectorc configuration')
  .action(() => {
    const path = initRcFile(process.cwd());
    renderInfo(`Initialized config: ${path}`);
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
