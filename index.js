#!/usr/bin/env node

import { program } from 'commander';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
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
import { evaluatePolicies, highestSeverity } from './src/policy.js';
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
  return {
    ignorePaths,
    arrayIdKey: effective.arrayIdKey || null,
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
        console.log(`::warning file=${result.file},title=${title}::${detail}`);
      }
      for (const finding of result.policies) {
        const level = finding.severity === 'error' ? 'error' : 'warning';
        const pack = finding.pack ? ` [${finding.pack}]` : '';
        const title = `flecto policy ${finding.id}${pack}`;
        console.log(`::${level} file=${result.file},title=${title}::${finding.path}: ${finding.message}`);
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
  .option('--array-id-key <key>', 'Diff arrays by this object identity key (opt-in)')
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
      const { policies, plugins } = resolvePolicyOptions(effective);
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
          writeFileSync(snapshotPath, JSON.stringify({ file: filepath, state }, null, 2), 'utf8');
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
                });
              } catch (err) {
                renderError(`policy evaluation failed: ${err.message}`);
                if (String(effective.onAlertFailure) === 'exit') process.exitCode = 1;
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
  .command('ci [files...]')
  .description('Run semantic diff in CI mode')
  .option('-p, --profile <name>', 'Use profile from .flectorc (else FLECTO_PROFILE)')
  .option('--snapshot-ref <ref>', 'Snapshot reference: snapshot path or git ref')
  .option('--format <type>', 'Output format: json | ndjson | github-annotations', 'json')
  .option('--fail-on <rules>', 'Comma-separated fail rules: changed,added,removed,policy,error,warn', 'changed,policy,error')
  .option('--ignore <keys>', 'Comma-separated key paths to ignore')
  .option('--policies <ids>', 'Comma-separated policy pack ids')
  .option('--plugins <paths>', 'Comma-separated local ESM plugin paths')
  .option('--array-id-key <key>', 'Diff arrays by this object identity key (opt-in)')
  .option('--array-ignore-order', 'Treat array order as insignificant', false)
  .option('--mask-secrets', 'Mask secret-like values in CI output', false)
  .option('--allow-empty', 'Allow CI to succeed when no files were diffed', false)
  .action(async (files, opts, command) => {
    try {
      const { config } = loadRcConfig(process.cwd());
      const profile = resolveProfileName(opts.profile);
      const effective = resolveEffectiveOptions(config, profile, stripUnsetCliOverrides(opts, command));
      const { policies: packIds, plugins } = resolvePolicyOptions(effective);
      const targets = (await resolveTargetFiles(files, config)).map((f) => resolve(f));
      if (targets.length === 0) {
        throw new Error('No files matched. Provide files or configure .flectorc files/include.');
      }

      const ignorePaths = parseCsv(effective.ignore);
      const failOn = new Set(parseCsv(effective.failOn));
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
      if (typeof fetch !== 'function') {
        throw new Error('Global fetch unavailable. Use Node.js >= 18.');
      }
      renderInfo('fetch: available');
      renderInfo(`version: ${PKG.version}`);
      renderInfo('doctor: OK');
    } catch (err) {
      renderError(`doctor failed: ${err.message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.help();
}
