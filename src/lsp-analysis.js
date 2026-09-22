import { execFileSync } from 'child_process';
import { realpathSync } from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';

import { applyBaseline, baselineRelativePath, loadBaseline } from './baseline.js';
import {
  assertSafeGitRef,
  assertWriteDestinationContained,
  loadRcConfig,
  resolveEffectiveOptions,
  resolveFiles,
  resolvePolicyOptions,
} from './config.js';
import { diffTrees, secretMatchPath } from './differ.js';
import { displayEncrypted } from './encrypted.js';
import { evaluatePolicies } from './policy.js';
import { isSupported, parseContent } from './parser.js';
import { buildPositionIndex, locatePath, toLspRange } from './positions.js';
import { maskFindings, maskSensitiveValue } from './renderer.js';
import { maskState, resolveSnapshotStore } from './snapshot-store.js';
import { applySuppressions, parseSuppressions, suppressionFormat } from './suppressions.js';

/**
 * One document in, diagnostics out (#142). Runs in the language server's
 * worker thread, so a slow or hung analysis can be abandoned without touching
 * the protocol loop.
 *
 * The rule this file keeps: **the editor must never disagree with the merge
 * gate.** Findings come from the same `.flectorc`, the same packs and
 * `severityRemap`, the same inline suppressions (a suppression missing its
 * reason shows as the error CI would fail on), and the same `--baseline` file
 * CI uses — so a finding shows in the editor exactly when `flecto ci` would
 * gate on it. Where the two genuinely cannot agree, the diagnostic says so
 * rather than quietly differing: plugins declared in `.flectorc` are not loaded
 * here (below), and that is reported on the file.
 */

/** LSP DiagnosticSeverity. */
const SEVERITY = { error: 1, warn: 2, info: 3, hint: 4 };
const MAX_DOCUMENT_CHARS = 5 * 1024 * 1024;
const MAX_CHANGE_DIAGNOSTICS = 200;
const MAX_VALUE_CHARS = 60;
const SCOPE_CACHE_MS = 10_000;

/**
 * @typedef {{
 *   profile?: string,
 *   plugins?: string[],
 *   snapshotRef?: string,
 *   snapshotStore?: string,
 *   snapshotDir?: string,
 *   changes?: 'hint' | 'info' | 'none',
 * }} LspSettings
 *   Everything here comes from the `flecto lsp` command line — the editor
 *   configuration the user wrote — never from the repository.
 *
 * @typedef {{ root: string, path: string, text: string, settings: LspSettings }} AnalysisJob
 *
 * @typedef {{
 *   range: { start: { line: number, character: number }, end: { line: number, character: number } },
 *   severity: number,
 *   source: 'flecto',
 *   code?: string,
 *   message: string,
 *   data?: Record<string, unknown>,
 * }} Diagnostic
 */

/** @type {Map<string, { at: number, files: Set<string> | null }>} */
const scopeCache = new Map();

/**
 * @param {AnalysisJob} job
 * @returns {Promise<Diagnostic[]>}
 */
export async function analyzeDocument(job) {
  const { root, path, text, settings } = job;
  if (!isSupported(path)) return [];
  if (text.length > MAX_DOCUMENT_CHARS) {
    return [fileDiagnostic(SEVERITY.info, 'too-large', 'Flecto skips files over 5 MB in the editor; run `flecto ci` on it instead.')];
  }

  let config;
  try {
    ({ config } = loadRcConfig(root));
  } catch (err) {
    return [fileDiagnostic(SEVERITY.error, 'config', err.message)];
  }
  const profile = settings.profile ?? (process.env.FLECTO_PROFILE || undefined);
  const effective = resolveEffectiveOptions(config, profile, {});

  if (!(await inScope(root, config, path))) return [];

  /** @type {Diagnostic[]} */
  const diagnostics = [];

  // Plugins execute code, and opening a repository in an editor is the same
  // threat model as CI running an untrusted pull request — with the difference
  // that FLECTO_ALLOW_RC_PLUGINS in a developer's shell profile would apply to
  // every repository they ever open. So `.flectorc` plugins are never loaded
  // here, whatever that variable says; only `--plugins` on the `flecto lsp`
  // command line, which the user wrote into their own editor configuration.
  const rcPlugins = effective.plugins;
  const hasRcPlugins = Array.isArray(rcPlugins) ? rcPlugins.length > 0 : Boolean(rcPlugins);
  let policyOptions;
  try {
    policyOptions = resolvePolicyOptions(
      { ...effective, plugins: settings.plugins ?? [] },
      { pluginsFromCli: true, cwd: root },
    );
  } catch (err) {
    return [fileDiagnostic(SEVERITY.error, 'config', err.message)];
  }
  if (hasRcPlugins && settings.plugins === undefined) {
    diagnostics.push(fileDiagnostic(
      SEVERITY.warn,
      'plugins-not-loaded',
      'This repository declares policy plugins in .flectorc. The language server never loads plugins from a'
      + ' repository, so their findings are missing here — CI may still report them. Pass absolute paths'
      + ' with `flecto lsp --plugins` in your editor settings if you trust this repository.',
    ));
  }

  let after;
  try {
    after = parseContent(path, text);
  } catch (err) {
    // `(line N)` from the parser's wrapper, else js-yaml's `(N:col)`.
    const line = /\(line (\d+)\)/u.exec(err.message) ?? /\((\d+):\d+\)/u.exec(err.message);
    const at = line ? Math.max(0, Number(line[1]) - 1) : 0;
    return [{
      range: { start: { line: at, character: 0 }, end: { line: at, character: 0 } },
      severity: SEVERITY.info,
      source: 'flecto',
      code: 'parse',
      message: `Flecto analyzes this file once it parses: ${err.message.replace(/^Parse error in "[^"]*"(?: \(line \d+\))?: /u, '')}`,
    }];
  }
  const index = buildPositionIndex(path, text, after);

  const dOpts = diffOptions(effective);
  const baseline = readBaseline(root, path, settings, effective);
  if (baseline.error) {
    diagnostics.push(fileDiagnostic(SEVERITY.info, 'baseline', baseline.error));
  }
  const afterForDiff = baseline.maskHashes ? maskState(after) : after;
  const events = diffTrees(baseline.state ?? {}, afterForDiff, dOpts);

  const rawFindings = await evaluatePolicies(events, {
    cwd: root,
    file: path,
    profile: profile ?? null,
    source: 'diff',
    policies: policyOptions.policies,
    plugins: policyOptions.plugins,
    severityRemap: policyOptions.severityRemap,
  });

  // Inline suppressions, exactly as `ci` applies them — including the refusal:
  // a directive with no reason fails the CI run, so it is an error here.
  const format = suppressionFormat(path);
  const { suppressions, errors, warnings } = parseSuppressions(text, format);
  for (const problem of errors) diagnostics.push(lineDiagnostic(problem.line, SEVERITY.error, 'suppression', `${problem.message} — \`flecto ci\` fails on this.`));
  for (const problem of warnings) diagnostics.push(lineDiagnostic(problem.line, SEVERITY.warn, 'suppression', problem.message));
  let { active } = applySuppressions(rawFindings, suppressions);

  // The baseline file CI gates against: a finding it already accepts does not
  // gate, so it does not show.
  if (effective.baseline) {
    try {
      const baselinePath = resolve(root, String(effective.baseline));
      assertWriteDestinationContained(baselinePath, { option: '--baseline', fromCli: false, cwd: root });
      const { entries } = loadBaseline(baselinePath);
      const relFile = baselineRelativePath(path, root);
      active = applyBaseline(active.map((finding) => ({ file: relFile, finding })), entries)
        .active.map((item) => item.finding);
    } catch (err) {
      diagnostics.push(fileDiagnostic(SEVERITY.error, 'baseline', err.message));
    }
  }

  const shown = effective.maskSecrets ? maskFindings(active, events) : active;
  for (const finding of shown) {
    const location = locatePath(index, String(finding.path ?? ''), { arrayIdKey: dOpts.arrayIdKey });
    diagnostics.push({
      range: toLspRange(index, location),
      severity: SEVERITY[finding.severity] ?? SEVERITY.info,
      source: 'flecto',
      code: String(finding.id),
      message: `${location.precision === 'exact' ? '' : `${finding.path}: `}${finding.message}`,
      data: { pack: finding.pack ?? null, path: finding.path, precision: location.precision },
    });
  }

  const changeSeverity = settings.changes === 'none' ? null : settings.changes === 'info' ? SEVERITY.info : SEVERITY.hint;
  if (changeSeverity !== null && baseline.state !== null) {
    for (const event of events.slice(0, MAX_CHANGE_DIAGNOSTICS)) {
      const location = locatePath(index, event.path, { arrayIdKey: dOpts.arrayIdKey });
      diagnostics.push({
        range: toLspRange(index, location),
        severity: changeSeverity,
        source: 'flecto',
        code: event.type,
        message: describeChange(event, baseline.label),
        data: { path: event.path, precision: location.precision },
      });
    }
    if (events.length > MAX_CHANGE_DIAGNOSTICS) {
      diagnostics.push(fileDiagnostic(changeSeverity, 'changed', `${events.length - MAX_CHANGE_DIAGNOSTICS} more changes from ${baseline.label} not shown.`));
    }
  }

  return diagnostics;
}

/**
 * Whether `flecto ci` would check this file: with `files`/`include` in
 * `.flectorc`, only a file they match (minus `exclude`); without, any supported
 * file. Flagging a file CI never looks at would be its own kind of
 * disagreement. The glob expansion is cached briefly — it is a directory walk,
 * and this runs at keystroke rate.
 * @param {string} root
 * @param {import('./config.js').FlectoRc | null} config
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function inScope(root, config, path) {
  const patterns = [...(config?.files ?? []), ...(config?.include ?? [])];
  if (patterns.length === 0) return true;
  const key = JSON.stringify([root, patterns, config?.exclude ?? []]);
  let cached = scopeCache.get(key);
  if (!cached || Date.now() - cached.at > SCOPE_CACHE_MS) {
    let files = null;
    try {
      files = new Set((await resolveFiles({ cwd: root, files: patterns, exclude: config?.exclude ?? [] })).map(canonical));
    } catch {
      files = null;
    }
    cached = { at: Date.now(), files };
    scopeCache.set(key, cached);
  }
  return cached.files === null || cached.files.has(canonical(path));
}

/**
 * @param {string} path
 * @returns {string}
 */
function canonical(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/**
 * @param {Record<string, unknown>} effective
 * @returns {{ ignorePaths: string[], arrayIdKey: string | null, arrayIdentity: boolean, arrayIgnoreOrder: boolean }}
 */
function diffOptions(effective) {
  const ignore = effective.ignore;
  const ignorePaths = Array.isArray(ignore)
    ? ignore.map(String)
    : typeof ignore === 'string' ? ignore.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const arrayIdKey = effective.arrayIdKey ? String(effective.arrayIdKey) : null;
  return {
    ignorePaths,
    arrayIdKey,
    arrayIdentity: arrayIdKey ? true : effective.arrayId !== false,
    arrayIgnoreOrder: Boolean(effective.arrayIgnoreOrder),
  };
}

/**
 * The state the document is compared against: git (`--snapshot-ref`, default
 * `HEAD`) or, with `--snapshot-store`, the snapshot store. Both are read-only
 * here, and the ref comes from the editor configuration, never the repository.
 * @param {string} root
 * @param {string} path
 * @param {LspSettings} settings
 * @param {Record<string, unknown>} effective
 * @returns {{ state: unknown | null, label: string, maskHashes: boolean, error?: string }}
 */
function readBaseline(root, path, settings, effective) {
  if (settings.snapshotStore) {
    try {
      const store = resolveSnapshotStore({
        store: settings.snapshotStore,
        dir: settings.snapshotDir,
        mask: effective.snapshotMask,
        cwd: root,
      });
      const record = store.readLatest(path);
      if (!record) {
        return { state: null, label: store.label, maskHashes: false, error: `No snapshot of this file in ${store.label}, so only policy findings are shown; every key is treated as added.` };
      }
      return { state: record.state, label: 'the snapshot', maskHashes: store.maskMode === 'hash' };
    } catch (err) {
      return { state: null, label: 'the snapshot', maskHashes: false, error: err.message };
    }
  }

  const ref = settings.snapshotRef ?? 'HEAD';
  // Hoisted out of the try below: a refused ref is a different diagnosis from
  // "this file is not in that ref", and reporting the latter would name the
  // one explanation that is certainly wrong.
  try {
    assertSafeGitRef(ref);
  } catch (err) {
    return { state: null, label: ref, maskHashes: false, error: err.message };
  }
  let top;
  try {
    top = execFileSync('git', ['-C', dirname(path), 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return {
      state: null,
      label: ref,
      maskHashes: false,
      error: 'This file is not in a git repository, so there is nothing to diff against and only policy findings'
        + ' are shown. Start the server with --snapshot-store to compare against saved snapshots instead.',
    };
  }
  let raw;
  try {
    const rel = relative(canonical(top), canonical(path)).replaceAll('\\', '/');
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('outside the repository');
    raw = execFileSync('git', ['-C', top, 'show', '--end-of-options', `${ref}:${rel}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return {
      state: null,
      label: ref,
      maskHashes: false,
      error: `This file is not in ${ref}, so only policy findings are shown; every key is treated as added.`
        + ' `flecto ci --snapshot-ref` fails closed on a file its ref does not have.',
    };
  }
  try {
    return { state: parseContent(path, raw), label: ref, maskHashes: false };
  } catch (err) {
    return { state: null, label: ref, maskHashes: false, error: `The ${ref} version of this file does not parse: ${err.message}` };
  }
}

/**
 * @param {import('./differ.js').ChangeEvent} event
 * @param {string} label
 * @returns {string}
 */
function describeChange(event, label) {
  // Change hints always mask: a hover that shows the password this line had at
  // HEAD is a leak nobody asked for, and nothing gates on these.
  const path = secretMatchPath(event);
  const show = (value) => {
    const masked = displayEncrypted(maskSensitiveValue(value, path));
    const json = JSON.stringify(masked) ?? String(masked);
    return json.length > MAX_VALUE_CHARS ? `${json.slice(0, MAX_VALUE_CHARS)}…` : json;
  };
  if (event.type === 'added') return `${event.path} added (not in ${label})`;
  if (event.type === 'removed') return `${event.path} removed (was ${show(event.before)} in ${label})`;
  return `${event.path} changed from ${show(event.before)} (${label}) to ${show(event.after)}${event.note ? ` — ${event.note}` : ''}`;
}

/**
 * @param {number} severity
 * @param {string} code
 * @param {string} message
 * @returns {Diagnostic}
 */
function fileDiagnostic(severity, code, message) {
  return { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, severity, source: 'flecto', code, message };
}

/**
 * @param {number} line 1-based
 * @param {number} severity
 * @param {string} code
 * @param {string} message
 * @returns {Diagnostic}
 */
function lineDiagnostic(line, severity, code, message) {
  const at = Math.max(0, line - 1);
  return { range: { start: { line: at, character: 0 }, end: { line: at, character: 0 } }, severity, source: 'flecto', code, message };
}
