#!/usr/bin/env node

import { program } from 'commander';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, relative } from 'path';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import chalk from 'chalk';

import { parseFile, isSupported, parseContent } from './src/parser.js';
import { diffTrees } from './src/differ.js';
import { startWatcher } from './src/watcher.js';
import { renderChanges, renderDiff, renderError, renderInfo, renderWarn, renderPolicyFindings } from './src/renderer.js';
import { fireAlerts } from './src/alerter.js';
import { createEnvelope } from './src/envelope.js';
import { evaluatePolicies, highestSeverity } from './src/policy.js';
import { loadRcConfig, resolveEffectiveOptions, resolveFiles, initRcFile } from './src/config.js';

const SNAPSHOT_DIR = '.driff-snapshots';

function snapshotIdForPath(absPath) {
  // Stable across platforms and avoids basename collisions
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

  // git ref mode: driff ci file --snapshot-ref HEAD~1
  const rel = relative(process.cwd(), filePath).replaceAll('\\', '/');
  const raw = execSync(`git show ${snapshotRef}:${rel}`, { encoding: 'utf8' });
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
        const title = `driff ${event.type}`;
        console.log(`::warning file=${result.file},title=${title}::${event.path}`);
      }
      for (const finding of result.policies) {
        const level = finding.severity === 'error' ? 'error' : 'warning';
        console.log(`::${level} file=${result.file},title=policy::${finding.path} ${finding.message}`);
      }
    }
  }
}

program
  .name('driff')
  .description('Driff — semantic config watcher for meaningful structured file changes')
  .version('1.0.0');

program
  .command('watch [files...]')
  .description('Watch config files/globs for semantic changes')
  .option('-p, --profile <name>', 'Use profile from .driffrc')
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
  .option('--snapshot', 'Save current state as baseline instead of watching')
  .option('--diff', 'Diff current file against saved baseline and exit')
  .action(async (files, opts) => {
    try {
      const { config } = loadRcConfig(process.cwd());
      const effective = resolveEffectiveOptions(config, opts.profile, opts);
      const targets = (await resolveTargetFiles(files, config)).map((f) => resolve(f));
      if (targets.length === 0) {
        throw new Error('No files matched. Provide files or configure .driffrc files/include.');
      }

      const ignorePaths = parseCsv(effective.ignore);
      const webhookHeaders = parseHeaders(effective.webhookHeader);
      const interval = parseInt(String(effective.interval ?? '100'), 10);
      validateInterval(interval);
      const mode = String(effective.mode ?? 'compact');
      validateMode(mode);

      if (effective.snapshot) {
        mkdirSync(SNAPSHOT_DIR, { recursive: true });
        for (const filepath of targets) {
          if (!existsSync(filepath) || !isSupported(filepath)) continue;
          const state = parseFile(filepath);
          const snapshotPath = snapshotPathForFile(filepath);
          writeFileSync(snapshotPath, JSON.stringify({ file: filepath, state }, null, 2), 'utf8');
          console.log(chalk.green(`✓ Snapshot saved: ${snapshotPath}`));
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
          const events = diffTrees(before, after, { ignorePaths });
          renderDiff(filepath, events);
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

        renderInfo(`driff watching ${chalk.cyan(filepath)}`);
        const watcher = startWatcher(
          filepath,
          { interval, mode, ignorePaths, polling: Boolean(effective.polling) },
          async (event) => {
            if (event.kind === 'changes') {
              renderChanges(event.filepath, event.events, mode);
              const policyFindings = evaluatePolicies(event.events);
              renderPolicyFindings(policyFindings);
              if (effective.command || effective.webhook) {
                const envelope = createEnvelope({
                  source: 'watch',
                  file: event.filepath,
                  changes: event.events,
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
          console.log(chalk.dim('\ndriff stopped.'));
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
  .option('-p, --profile <name>', 'Use profile from .driffrc')
  .option('--snapshot-ref <ref>', 'Snapshot reference: snapshot path or git ref')
  .option('--format <type>', 'Output format: json | ndjson | github-annotations', 'json')
  .option('--fail-on <rules>', 'Comma-separated fail rules: changed,added,removed,policy,error,warn', 'changed,policy,error')
  .option('--ignore <keys>', 'Comma-separated key paths to ignore')
  .action(async (files, opts) => {
    try {
      const { config } = loadRcConfig(process.cwd());
      const effective = resolveEffectiveOptions(config, opts.profile, opts);
      const targets = (await resolveTargetFiles(files, config)).map((f) => resolve(f));
      if (targets.length === 0) {
        throw new Error('No files matched. Provide files or configure .driffrc files/include.');
      }

      const ignorePaths = parseCsv(effective.ignore);
      const failOn = new Set(parseCsv(effective.failOn));
      const format = String(effective.format ?? 'json');
      if (!['json', 'ndjson', 'github-annotations'].includes(format)) {
        throw new Error('--format must be json, ndjson, or github-annotations');
      }

      /** @type {any[]} */
      const results = [];
      let shouldFail = false;

      for (const filepath of targets) {
        if (!existsSync(filepath) || !isSupported(filepath)) continue;
        const after = parseFile(filepath);
        let before = {};
        try {
          before = readSnapshotStateFromRef(filepath, effective.snapshotRef);
        } catch {
          before = {};
        }
        const events = diffTrees(before, after, { ignorePaths });
        const policies = evaluatePolicies(events);
        const envelope = createEnvelope({
          source: 'ci',
          file: filepath,
          changes: events,
        });
        results.push({ file: filepath, envelope, policies });

        if (shouldFailFromChanges(events, failOn) || shouldFailFromPolicy(policies, failOn)) {
          shouldFail = true;
        }
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
  .description('Create starter .driffrc configuration')
  .action(() => {
    const path = initRcFile(process.cwd());
    renderInfo(`Initialized config: ${path}`);
  });

program
  .command('doctor')
  .description('Check Driff setup, config, and environment')
  .action(async () => {
    try {
      const { path, config } = loadRcConfig(process.cwd());
      if (path) {
        renderInfo(`config: ${path}`);
      } else {
        renderWarn('No .driffrc found (optional). Run "driff init" to scaffold.');
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
      renderInfo('doctor: OK');
    } catch (err) {
      renderError(`doctor failed: ${err.message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);

// Show help if no command given
if (!process.argv.slice(2).length) {
  program.help();
}
