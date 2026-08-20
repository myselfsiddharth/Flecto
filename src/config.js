import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import fg from 'fast-glob';
import yaml from 'js-yaml';
import { isEnvFilename, parseContent } from './parser.js';
import { encryptionState } from './encrypted.js';

const RC_CANDIDATES = ['.flectorc', '.flectorc.json', '.flectorc.yaml', '.flectorc.yml'];
const COMPOSE_FILENAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const CONFIG_DIR_PATTERN = 'config/**/*.{yaml,yml,json,toml,ini}';
const ENV_FILE_PATTERNS = ['.env', '.env.*', '*.env'];
const GENERIC_FILE_PATTERNS = [CONFIG_DIR_PATTERN, ...ENV_FILE_PATTERNS];

// Conventional places a Kubernetes/SOPS repo keeps manifests, searched in
// addition to the repo root. Detection is content-based (see sniffManifestDirs),
// so these only bound *where* Flecto looks — a manifest named deploy.yaml still
// has to actually carry `apiVersion` + `kind` to count.
const MANIFEST_DIRS = ['k8s', 'kubernetes', 'manifests', 'deploy'];

// Cost guards. `flecto init` must not read a large repo exhaustively: the issue
// (#123) is explicit that reading every YAML file is the wrong trade. Sniffing
// stops after this many files, and a single file larger than the byte cap is
// skipped rather than read — a hand-written manifest is never megabytes, and a
// generated blob that large is not what we want to gate on anyway.
const MAX_SNIFF_FILES = 50;
const MAX_SNIFF_BYTES = 256 * 1024;
const SNIFF_EXTENSIONS = ['.yaml', '.yml', '.json'];

const K8S_ROOT_PATTERN = '*.{yaml,yml}';
const K8S_DIR_PATTERN = '**/*.{yaml,yml}';

/**
 * @typedef {{
 *  defaults?: Record<string, unknown>,
 *  profiles?: Record<string, Record<string, unknown>>,
 *  files?: string[],
 *  include?: string[],
 *  exclude?: string[]
 * }} FlectoRc
 *
 * @typedef {{
 *  id: string,
 *  evidence: string[],
 *  pack: string | null,
 *  summary: string
 * }} StackSignal
 *
 * @typedef {{ signals: StackSignal[], packs: string[], files: string[] }} StackDetection
 */

/**
 * @param {string} cwd
 * @returns {{ path: string | null, config: FlectoRc | null }}
 */
export function loadRcConfig(cwd = process.cwd()) {
  for (const candidate of RC_CANDIDATES) {
    const fullPath = resolve(cwd, candidate);
    if (!existsSync(fullPath)) continue;
    const raw = readFileSync(fullPath, 'utf8');
    let parsed;
    try {
      if (candidate.endsWith('.yaml') || candidate.endsWith('.yml')) {
        parsed = yaml.load(raw);
      } else {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = yaml.load(raw);
        }
      }
    } catch (err) {
      throw new Error(`Failed to parse ${candidate}: ${err.message}`);
    }
    return { path: fullPath, config: parsed ?? {} };
  }
  return { path: null, config: null };
}

/**
 * Resolve profile name: CLI > FLECTO_PROFILE > none.
 * @param {string | undefined} cliProfile
 * @returns {string | undefined}
 */
export function resolveProfileName(cliProfile) {
  if (cliProfile) return String(cliProfile);
  if (process.env.FLECTO_PROFILE) return String(process.env.FLECTO_PROFILE);
  return undefined;
}

/**
 * Resolve effective options with optional profile and CLI overrides.
 * @param {FlectoRc | null} config
 * @param {string | undefined} profile
 * @param {Record<string, unknown>} cliOverrides
 */
export function resolveEffectiveOptions(config, profile, cliOverrides = {}) {
  const defaults = config?.defaults ?? {};
  const profileOptions = profile && config?.profiles?.[profile] ? config.profiles[profile] : {};
  return { ...defaults, ...profileOptions, ...cliOverrides };
}

/**
 * Has the operator explicitly opted in to plugins declared in `.flectorc`?
 * @returns {boolean}
 */
function rcPluginsAllowed() {
  const raw = process.env.FLECTO_ALLOW_RC_PLUGINS;
  return raw === '1' || String(raw).toLowerCase() === 'true';
}

/**
 * Split a policy list that may arrive as an array or a comma-separated string.
 * @param {unknown} raw
 * @param {string[]} fallback
 * @returns {string[]}
 */
function toList(raw, fallback) {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return fallback;
}

/**
 * Normalize policy-related effective options.
 *
 * Plugins execute code, and `.flectorc` is attacker-controlled on an untrusted
 * pull request, so a plugin that came from the rc file rather than an explicit
 * `--plugins` flag is refused unless the operator opts in with
 * `FLECTO_ALLOW_RC_PLUGINS=1`. Refusing loudly rather than skipping silently is
 * deliberate: a plugin that stops running without saying so would weaken a
 * policy gate the operator believes is in place.
 * @param {Record<string, unknown>} effective
 * @param {{ pluginsFromCli?: boolean, cwd?: string }} [provenance]
 */
export function resolvePolicyOptions(effective, provenance = {}) {
  const severityRemapRaw = effective.severityRemap;
  const policies = toList(effective.policies, ['default']);
  const plugins = toList(effective.plugins, []);

  if (plugins.length > 0 && !provenance.pluginsFromCli) {
    if (!rcPluginsAllowed()) {
      throw new Error(
        'Refusing to load policy plugins declared in .flectorc: plugins execute code, '
        + 'and a config file can come from an untrusted pull request.\n'
        + `Declared: ${plugins.join(', ')}\n`
        + 'Pass them on the command line with --plugins instead, or set '
        + 'FLECTO_ALLOW_RC_PLUGINS=1 if this config is trusted.',
      );
    }
    // Opted in, but the rc file may still be attacker-authored. Keep rc-declared
    // plugins inside the project so `../../../../tmp/x.mjs` cannot reach a module
    // planted elsewhere on the runner. An explicit --plugins is operator intent
    // and stays unrestricted: shared policies outside the cwd are a real setup.
    const root = resolve(provenance.cwd ?? process.cwd());
    for (const pluginPath of plugins) {
      const abs = resolve(root, pluginPath);
      if (abs !== root && !abs.startsWith(root + sep)) {
        throw new Error(
          `Policy plugin declared in .flectorc is outside the project: ${pluginPath}\n`
          + 'Plugins execute code, so an rc-declared plugin must live inside the '
          + 'directory Flecto is running in.',
        );
      }
    }
  }
  if (
    severityRemapRaw !== undefined
    && (severityRemapRaw === null || Array.isArray(severityRemapRaw) || typeof severityRemapRaw !== 'object')
  ) {
    throw new Error('severityRemap must be an object mapping rule ids to info, warn, error, or off');
  }
  const severityRemap = {};
  for (const [ruleId, severity] of Object.entries(severityRemapRaw ?? {})) {
    if (!['info', 'warn', 'error', 'off'].includes(severity)) {
      throw new Error(
        `severityRemap for "${ruleId}" must be one of: info, warn, error, off`,
      );
    }
    severityRemap[ruleId] = severity;
  }
  return { policies, plugins, severityRemap };
}

/**
 * Expand file patterns from rc include/files and direct CLI inputs.
 * @param {{ cwd?: string, files?: string[], include?: string[], exclude?: string[] }} input
 * @returns {Promise<string[]>}
 */
export async function resolveFiles(input) {
  const cwd = input.cwd ?? process.cwd();
  const files = input.files ?? [];
  const include = input.include ?? [];
  const exclude = input.exclude ?? [];
  const patterns = [...files, ...include].filter(Boolean);
  if (patterns.length === 0) return [];
  const matches = await fg(patterns, {
    cwd,
    absolute: true,
    onlyFiles: true,
    unique: true,
    ignore: exclude,
    dot: true,
  });
  return matches.map((p) => resolve(p));
}

/**
 * Collect candidate files to sniff: YAML/JSON at the repo root plus, one level
 * of recursion deep, the conventional manifest directories. Bounded by
 * MAX_SNIFF_FILES so a large repo never turns `init` into a full-tree read.
 * @param {string} cwd
 * @param {string[]} rootFileNames
 * @param {Set<string>} dirNames
 * @returns {string[]} absolute paths, root files first
 */
function sniffCandidates(cwd, rootFileNames, dirNames) {
  /** @type {string[]} */
  const candidates = [];
  const push = (abs) => {
    if (candidates.length < MAX_SNIFF_FILES) candidates.push(abs);
  };

  for (const name of rootFileNames) {
    if (SNIFF_EXTENSIONS.includes(extLower(name))) push(resolve(cwd, name));
  }

  for (const dir of MANIFEST_DIRS) {
    if (!dirNames.has(dir)) continue;
    for (const abs of walkYamlish(resolve(cwd, dir))) {
      push(abs);
      if (candidates.length >= MAX_SNIFF_FILES) break;
    }
  }

  return candidates.slice(0, MAX_SNIFF_FILES);
}

/**
 * Depth-first list of sniffable files under a directory, skipping node_modules
 * and dot directories, capped by MAX_SNIFF_FILES so a deep tree cannot run away.
 * @param {string} root
 * @returns {string[]}
 */
function walkYamlish(root) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const stack = [root];
  while (stack.length > 0 && out.length < MAX_SNIFF_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        stack.push(join(dir, entry.name));
      } else if (entry.isFile() && SNIFF_EXTENSIONS.includes(extLower(entry.name))) {
        out.push(join(dir, entry.name));
        if (out.length >= MAX_SNIFF_FILES) break;
      }
    }
  }
  return out;
}

/**
 * @param {string} name
 * @returns {string} lower-cased extension including the dot, or ''
 */
function extLower(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Parse a candidate file for detection, cheaply and defensively. Returns null
 * for anything too large, unreadable, or unparseable — detection never fails a
 * run, it just learns less. The byte cap is enforced before the read so a huge
 * file is skipped rather than slurped.
 * @param {string} abs
 * @returns {unknown}
 */
function sniffParse(abs) {
  try {
    if (statSync(abs).size > MAX_SNIFF_BYTES) return null;
    return parseContent(abs, readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * True when a parsed tree (single- or multi-document) contains a
 * Kubernetes-shaped document: `apiVersion` + `kind`. A multi-document file is
 * the identity-keyed wrapper, so its documents are one level down.
 * @param {unknown} tree
 * @returns {boolean}
 */
function hasKubernetesDocument(tree) {
  if (!isPlainObjectLike(tree)) return false;
  if (isKubernetesShaped(tree)) return true;
  return Object.values(tree).some((value) => isKubernetesShaped(value));
}

/**
 * @param {unknown} doc
 * @returns {boolean}
 */
function isKubernetesShaped(doc) {
  return isPlainObjectLike(doc)
    && typeof doc.apiVersion === 'string' && doc.apiVersion.trim() !== ''
    && typeof doc.kind === 'string' && doc.kind.trim() !== '';
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObjectLike(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Sniff the manifest locations for Kubernetes and SOPS signals. Content-based
 * and cost-bounded; see MAX_SNIFF_FILES / MAX_SNIFF_BYTES. `.sops.yaml` is a
 * plaintext creation-rules config, not an encrypted file, but its presence is
 * still a reliable sign the repo uses SOPS, so it counts on its own.
 * @param {string} cwd
 * @param {string[]} rootFileNames
 * @param {Set<string>} dirNames
 * @returns {{
 *   kubernetes: { files: string[] } | null,
 *   sops: { files: string[], creationRules: boolean } | null
 * }}
 */
function sniffManifestDirs(cwd, rootFileNames, dirNames) {
  const candidates = sniffCandidates(cwd, rootFileNames, dirNames);

  /** @type {Set<string>} */
  const k8sRel = new Set();
  /** @type {Set<string>} */
  const sopsRel = new Set();
  const creationRules = rootFileNames.some((name) => name === '.sops.yaml' || name === '.sops.yml');

  for (const abs of candidates) {
    const tree = sniffParse(abs);
    if (tree == null) continue;
    const rel = relative(cwd, abs).split(sep).join('/');
    if (hasKubernetesDocument(tree)) k8sRel.add(rel);
    if (encryptionState(tree) !== 'plaintext') sopsRel.add(rel);
  }

  return {
    kubernetes: k8sRel.size > 0 ? { files: [...k8sRel].sort() } : null,
    sops: sopsRel.size > 0 || creationRules
      ? { files: [...sopsRel].sort(), creationRules }
      : null,
  };
}

/**
 * Watch patterns for the directories that held Kubernetes manifests, plus the
 * repo root when a manifest lived there. One pattern per conventional dir keeps
 * the generated config short instead of listing every file.
 * @param {string[]} relFiles
 * @returns {string[]}
 */
function manifestWatchPatterns(relFiles) {
  /** @type {Set<string>} */
  const patterns = new Set();
  for (const rel of relFiles) {
    const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : null;
    if (top && MANIFEST_DIRS.includes(top)) {
      patterns.add(`${top}/${K8S_DIR_PATTERN}`);
    } else {
      patterns.add(K8S_ROOT_PATTERN);
    }
  }
  return [...patterns].sort();
}

/**
 * Detect stack signals in a directory and map them to policy packs and file
 * patterns. Only built-in pack ids and patterns Flecto can actually parse are
 * ever returned, so a config built from this stays loadable by every command.
 * Terraform files are reported as context only: `.tf` is not a supported parse
 * format, and the `terraform` pack reads plan JSON rather than `.tf` sources,
 * so neither belongs in a config built from a directory listing.
 * @param {string} cwd
 * @returns {StackDetection}
 */
export function detectStack(cwd = process.cwd()) {
  /** @type {StackSignal[]} */
  const signals = [];
  const packs = ['default'];
  /** @type {string[]} */
  const files = [];

  let entries = [];
  try {
    entries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    return { signals, packs, files };
  }
  const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const dirNames = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const fileNameSet = new Set(fileNames);

  const composeFiles = COMPOSE_FILENAMES.filter((name) => fileNameSet.has(name));
  if (composeFiles.length > 0) {
    packs.push('compose');
    files.push(...composeFiles);
    signals.push({
      id: 'compose',
      evidence: composeFiles,
      pack: 'compose',
      summary: `Detected ${composeFiles.join(', ')} → enabled the \`compose\` policy pack and watched ${composeFiles.length === 1 ? 'it' : 'them'}`,
    });
  }

  if (fileNameSet.has('package.json')) {
    packs.push('node-runtime');
    files.push('package.json');
    signals.push({
      id: 'node',
      evidence: ['package.json'],
      pack: 'node-runtime',
      summary: 'Detected package.json → enabled the `node-runtime` policy pack and watched it',
    });
  }

  const terraformFiles = fileNames.filter((name) => name.toLowerCase().endsWith('.tf')).sort();
  if (terraformFiles.length > 0) {
    signals.push({
      id: 'terraform',
      evidence: terraformFiles,
      pack: null,
      summary: `Detected Terraform files (${terraformFiles.join(', ')}) → .tf is not a parseable format, so nothing was enabled; run "flecto plan" on "terraform show -json" output to use the terraform pack`,
    });
  }

  if (dirNames.has('config')) {
    files.push(CONFIG_DIR_PATTERN);
    signals.push({
      id: 'config-dir',
      evidence: ['config/'],
      pack: null,
      summary: `Detected config/ → watched ${CONFIG_DIR_PATTERN}`,
    });
  }

  const envFiles = fileNames.filter((name) => isEnvFilename(name)).sort();
  if (envFiles.length > 0) {
    files.push(...ENV_FILE_PATTERNS);
    signals.push({
      id: 'dotenv',
      evidence: envFiles,
      pack: null,
      summary: `Detected ${envFiles.join(', ')} → watched ${ENV_FILE_PATTERNS.join(', ')}`,
    });
  }

  // Content-based signals for the two shapes 3.0 was built around. Sniffed, not
  // guessed from filenames, and bounded (#123). Enabling `kubernetes` on a repo
  // that is not Kubernetes would produce confusing findings on the first run, so
  // a manifest must actually carry apiVersion + kind to count.
  const manifests = sniffManifestDirs(cwd, fileNames, dirNames);

  if (manifests.kubernetes) {
    packs.push('kubernetes');
    const watched = manifestWatchPatterns(manifests.kubernetes.files);
    files.push(...watched);
    const shown = manifests.kubernetes.files.slice(0, 3);
    const more = manifests.kubernetes.files.length - shown.length;
    const evidenceList = more > 0 ? `${shown.join(', ')}, +${more} more` : shown.join(', ');
    signals.push({
      id: 'kubernetes',
      evidence: manifests.kubernetes.files,
      pack: 'kubernetes',
      summary: `Detected Kubernetes manifests (${evidenceList}) → enabled the \`kubernetes\` policy pack and watched ${watched.join(', ')}`,
    });
  }

  if (manifests.sops) {
    packs.push('sops');
    if (manifests.sops.files.length > 0) files.push(...manifests.sops.files);
    const evidence = [
      ...(manifests.sops.creationRules ? ['.sops.yaml'] : []),
      ...manifests.sops.files,
    ];
    const watchedNote = manifests.sops.files.length > 0
      ? ` and watched ${manifests.sops.files.join(', ')}`
      : ' (no encrypted files found yet; the pack applies when they appear)';
    signals.push({
      id: 'sops',
      evidence,
      pack: 'sops',
      summary: `Detected SOPS usage (${evidence.join(', ')}) → enabled the \`sops\` policy pack${watchedNote}`,
    });
  }

  return { signals, packs, files: [...new Set(files)] };
}

/**
 * Scaffold a starter rc file if missing, pre-selecting policy packs and file
 * patterns from the stack signals found in `cwd`. Never overwrites an existing
 * config: any of the four `.flectorc` candidates is reported back untouched.
 * @param {string} cwd
 * @returns {{ path: string, created: boolean, detection: StackDetection }}
 */
export function initRcFile(cwd = process.cwd()) {
  const detection = detectStack(cwd);
  const existingPath = RC_CANDIDATES
    .map((candidate) => resolve(cwd, candidate))
    .find((candidate) => existsSync(candidate));
  if (existingPath) return { path: existingPath, created: false, detection };

  const path = resolve(cwd, '.flectorc.json');
  const starter = {
    defaults: {
      mode: 'compact',
      interval: 100,
      ignore: ['**.updated_at'],
      deliveryMode: 'best-effort',
      onAlertFailure: 'warn',
      policies: detection.packs,
      plugins: [],
      arrayIdKey: null,
      arrayId: true,
      arrayIgnoreOrder: false,
      maskSecrets: false,
    },
    profiles: {
      dev: { mode: 'verbose' },
      ci: { failOn: 'policy,error' },
      prod: {
        policies: [...detection.packs, 'strict-prod'],
        severityRemap: { 'pool-size-jump': 'error' },
        maskSecrets: true,
      },
    },
    files: detection.files.length > 0 ? detection.files : [...GENERIC_FILE_PATTERNS],
    exclude: ['**/node_modules/**'],
  };
  writeFileSync(path, JSON.stringify(starter, null, 2), 'utf8');
  return { path, created: true, detection };
}
