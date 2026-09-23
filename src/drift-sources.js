import { spawnSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { assertTargetContained } from './config.js';

/**
 * Live sources `flecto drift` can read, and the rules that keep reading them
 * safe (#144).
 *
 * Flecto's core promise is that it authenticates to nothing: it reads files,
 * shells out to nothing but `git`, and touches no key material. `drift` is the
 * one thing that cannot keep that promise, which is why it is a **separate
 * binary** with a separate entry point, and why nothing in core imports this
 * file. Installing Flecto does not enable it; running `flecto ci` cannot reach
 * it.
 *
 * Three rules carry the security of this module.
 *
 * **1. Flecto never holds a credential.** It does not read a kubeconfig, an AWS
 * profile, a token, or an agent socket, and it has no flag that accepts one.
 * Every source delegates to a CLI the operator has already installed and
 * already authenticated -- `kubectl`, `aws` -- and inherits whatever that tool
 * is entitled to. The blast radius of a bug here is therefore bounded by the
 * credential the operator chose to give that tool, not by anything Flecto
 * decided. It also means "use a read-only role" is advice the operator can
 * actually enforce, in their own IAM, rather than a promise we make about our
 * own code.
 *
 * **2. Read-only is structural, not careful.** Every argv is built here, from a
 * fixed verb allowlist (`ALLOWED_COMMANDS`). Nothing from the URI reaches argv
 * as a flag: each interpolated component is validated against a conservative
 * pattern and passed after `--` where the tool supports it. There is no code
 * path in this file that can construct a mutating command, so "it cannot write"
 * is a property of the argv table rather than of reviewer attention.
 *
 * **3. A value from a secret store is a secret.** Kubernetes Secrets and SSM
 * SecureStrings are compared **metadata-only**: key presence, and a
 * length-and-digest shape so a rotation is still visible. The plaintext never
 * enters a change event, a report, or this process's memory beyond the hashing
 * call. There is no flag to turn that off, because a flag to print production
 * secrets is a feature request to answer with "no".
 */

import { createHmac, randomBytes } from 'crypto';

/**
 * The complete set of commands this binary may run. Anything not here cannot be
 * spawned, whatever a URI says.
 *
 * Each entry names a tool, a fixed read-only verb, and how to build the rest of
 * argv from validated components. Adding a mutating verb here is the one change
 * that would break the read-only property, which is why they live in one table
 * rather than being assembled at each call site.
 * @type {Record<string, { tool: string, verbs: string[] }>}
 */
const ALLOWED_COMMANDS = {
  // `verbAt` is which argv position carries the verb: `kubectl get …` puts it
  // first, while `aws ssm get-parameters-by-path …` names a *service* first.
  // Gating position 0 for aws would have allowed `ssm put-parameter` through
  // the check whose docstring calls it "the assertion that keeps it that way".
  kubectl: { tool: 'kubectl', verbAt: 0, verbs: ['get'] },
  aws: { tool: 'aws', verbAt: 1, verbs: ['get-parameters-by-path'], services: ['ssm'] },
};

/** Kubernetes names, per RFC 1123: the pattern the API server itself enforces. */
const K8S_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/**
 * SSM parameter paths: printable, slash-delimited, no shell or flag shapes.
 *
 * `..` is refused explicitly. AWS would reject a traversing path itself, but
 * relying on a remote service to validate an argument this process constructed
 * is the wrong place to draw the line -- and it costs one check to not send it.
 */
const SSM_PATH_RE = /^\/(?!.*\.\.)[A-Za-z0-9_.\-/]*$/;

/**
 * @typedef {{
 *   kind: 'configmap' | 'secret' | 'ssm' | 'tfstate',
 *   label: string,
 *   sensitive: boolean,
 *   shapedKeys: Set<string>
 * }} SourceMeta
 * @typedef {{ state: Record<string, unknown>, meta: SourceMeta }} LiveState
 */

/**
 * Refuse a component that could be read as a flag or escape its position.
 * @param {string} value
 * @param {RegExp} pattern
 * @param {string} what
 * @returns {string}
 */
function assertComponent(value, pattern, what) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`drift: ${what} is required`);
  }
  if (value.startsWith('-')) {
    throw new Error(`drift: ${what} "${value}" starts with "-" and would be read as an option`);
  }
  if (!pattern.test(value)) {
    throw new Error(`drift: ${what} "${value}" is not a valid ${what}`);
  }
  return value;
}

/**
 * Run an allowlisted read-only command.
 * @param {keyof typeof ALLOWED_COMMANDS} name
 * @param {string[]} args argv after the tool, beginning with an allowed verb
 * @returns {string} stdout
 */
function readOnly(name, args) {
  const entry = ALLOWED_COMMANDS[name];
  if (!entry) throw new Error(`drift: ${name} is not an allowed command`);
  if (entry.services && !entry.services.includes(args[0])) {
    throw new Error(`drift: "${args[0]}" is not an allowed ${name} service`);
  }
  if (!entry.verbs.includes(args[entry.verbAt])) {
    // Unreachable from any URI -- the verb is a literal at each call site. This
    // is the assertion that keeps it that way.
    throw new Error(`drift: "${args[entry.verbAt]}" is not a read-only verb for ${name}`);
  }
  const run = spawnSync(entry.tool, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // No shell, ever. And stdin closed: a tool that decides to prompt for
    // credentials should fail, not hang a CI job forever.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (run.error?.code === 'ENOENT') {
    throw new Error(
      `drift: ${entry.tool} is not installed or not on PATH. flecto drift reads live state through`
      + ` the tool you have already authenticated -- it holds no credentials of its own.`,
    );
  }
  if (run.status !== 0) {
    // The tool's own first line is kept, unlike its stdout: an error here is a
    // diagnostic ("forbidden", "not found", "expired token") that the operator
    // needs, where stdout is response *data*. Bounded, and attributed, so it is
    // clear whose words these are.
    const detail = String(run.stderr ?? '').trim().split('\n')[0].slice(0, 200) || `exit ${run.status}`;
    throw new Error(`drift: ${entry.tool} failed: ${detail}`);
  }
  return run.stdout;
}

/**
 * The shape of a secret value: enough to see a rotation, not enough to be one.
 *
 * A digest rather than the value means a changed credential still shows up as a
 * change -- which is the entire point of drift detection -- while the plaintext
 * never reaches a diff, a report, or a terminal. Truncated because this is a
 * comparison key, not a commitment.
 * @param {string} value
 * @returns {string}
 */
const SHAPE_KEY = randomBytes(32);

/**
 * What a shaped value looks like.
 *
 * Exported so the masking decision can be made on the *value* rather than on
 * the key it sits under: a key name is metadata that can fall out of step with
 * the value beside it, and when it did, a plaintext printed unmasked because
 * its key was still marked as shaped.
 */
export const SHAPE_RE = /^<\d+ bytes, digest:[0-9a-f]{12}>$/;

function shapeOf(value) {
  // Keyed with a per-invocation random key, not a bare digest. Both sides of
  // the comparison are hashed in the same process, so drift detection is
  // unaffected -- but a bare truncated SHA-256 printed into a CI log is an
  // offline oracle: 48 bits is trivially brute-forced for a low-entropy secret,
  // and being unsalted it is a stable cross-run, cross-org identifier for a
  // shared credential. Keyed, the printed digest is worth nothing to anyone
  // holding the log.
  const digest = createHmac('sha256', SHAPE_KEY).update(value, 'utf8').digest('hex').slice(0, 12);
  return `<${value.length} bytes, digest:${digest}>`;
}

/**
 * Replace every value with its shape.
 * @param {Record<string, unknown>} data
 * @returns {Record<string, unknown>}
 */
function shapesOnly(data) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, shapeOf(stableString(value))]),
  );
}

/**
 * A value as a string, without collapsing structure.
 *
 * `String(value)` turns every object into `"[object Object]"`, so two different
 * secrets produced an identical shape and a rotation between them was
 * invisible -- the one thing shape comparison exists to show.
 * @param {unknown} value
 * @returns {string}
 */
function stableString(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

/**
 * Parse a tool's stdout as JSON without quoting it back on failure.
 *
 * `JSON.parse`'s own message quotes the bytes it choked on, and those bytes are
 * a response from a live secret store. `readTerraformState` already guards this
 * deliberately; the same reasoning applies to every reader.
 * @param {string} raw
 * @param {string} tool
 * @returns {any}
 */
function parseToolJson(raw, tool) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new Error(`drift: ${tool} did not return the JSON document expected`);
  }
}

/**
 * Parse a live-source URI into its parts.
 *
 * Deliberately strict and hand-written rather than `new URL()`: the shapes are
 * few and known, and a permissive parser is how a component ends up somewhere
 * it was not meant to go.
 * @param {string} uri
 * @returns {{ scheme: string, rest: string }}
 */
export function parseSourceUri(uri) {
  const match = /^([a-z0-9+.-]{1,16}):\/\/(.*)$/i.exec(String(uri ?? ''));
  if (!match) {
    throw new Error(
      `drift: "${uri}" is not a source URI. Expected one of:\n`
      + '  k8s://<namespace>/configmap/<name>\n'
      + '  k8s://<namespace>/secret/<name>      (compared by shape, never by value)\n'
      + '  ssm://<parameter-path-prefix>        (SecureString compared by shape)\n'
      + '  tfstate://<path-to-state-file>',
    );
  }
  return { scheme: match[1].toLowerCase(), rest: match[2] };
}

/**
 * Read a Kubernetes ConfigMap or Secret.
 * @param {string} rest `<namespace>/<configmap|secret>/<name>`
 * @returns {LiveState}
 */
function readKubernetes(rest) {
  const parts = rest.split('/');
  if (parts.length !== 3) {
    throw new Error('drift: expected k8s://<namespace>/<configmap|secret>/<name>');
  }
  const [namespace, rawKind, name] = parts;
  const kind = rawKind.toLowerCase();
  if (kind !== 'configmap' && kind !== 'secret') {
    throw new Error(`drift: "${rawKind}" is not a readable kind; use configmap or secret`);
  }
  assertComponent(namespace, K8S_NAME_RE, 'namespace');
  assertComponent(name, K8S_NAME_RE, 'name');

  const raw = readOnly('kubectl', [
    'get', kind, name, '--namespace', namespace, '--output', 'json',
  ]);
  /** @type {{ data?: Record<string, string>, stringData?: Record<string, string> }} */
  const parsed = parseToolJson(raw, 'kubectl');
  const data = { ...(parsed.data ?? {}), ...(parsed.stringData ?? {}) };

  if (kind === 'secret') {
    // Values arrive base64-encoded; they are hashed without being decoded, so
    // the plaintext is never materialized at all.
    return {
      state: shapesOnly(data),
      meta: {
        kind: 'secret',
        label: `k8s secret ${namespace}/${name}`,
        sensitive: true,
        shapedKeys: new Set(Object.keys(data)),
      },
    };
  }
  return {
    state: { ...data },
    meta: {
      kind: 'configmap',
      label: `k8s configmap ${namespace}/${name}`,
      sensitive: false,
      shapedKeys: new Set(),
    },
  };
}

/**
 * Read AWS SSM Parameter Store under a path prefix.
 *
 * `--with-decryption` is deliberately **never** passed, so a SecureString comes
 * back still encrypted and its plaintext never leaves AWS. The ciphertext is
 * then shaped like any other secret, which still surfaces a rotation.
 * @param {string} rest the parameter path prefix
 * @returns {LiveState}
 */
function readSsm(rest) {
  // Built from real segments rather than normalized in place. A single literal
  // `=== '/'` check left `//`, `/.`, `/./` and `/.//` all reaching the CLI with
  // a root-equivalent path -- and leaning on AWS to normalize them is the very
  // thing this module's own SSM_PATH_RE docstring calls the wrong place to draw
  // the line.
  const segments = rest.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`drift: parameter path "${rest}" must not contain ".."`);
  }
  if (segments.length === 0) {
    // `--path / --recursive` is every parameter in the account. One typo would
    // read another team's namespace, which is the opposite of the
    // one-named-source-per-invocation rule this tool is built on.
    throw new Error(
      'drift: ssm:// needs a parameter path, e.g. ssm:///app/prod.'
      + ' Reading from the account root would fetch every parameter there.',
    );
  }
  const path = `/${segments.join('/')}`;
  assertComponent(path, SSM_PATH_RE, 'parameter path');

  const raw = readOnly('aws', [
    'ssm', 'get-parameters-by-path', '--path', path, '--recursive', '--output', 'json',
  ]);
  /** @type {{ Parameters?: Array<{ Name: string, Value: string, Type: string }> }} */
  const parsed = parseToolJson(raw, 'aws');
  /** @type {Record<string, unknown>} */
  const state = Object.create(null);
  /** @type {Set<string>} */
  const shapedKeys = new Set();
  for (const parameter of parsed.Parameters ?? []) {
    const name = String(parameter.Name);
    // `slice(path.length)` is a blind cut, so a Name outside the requested path
    // would derive a key that collides with another. Two parameters deriving
    // one key is how `state` and `shapedKeys` came to disagree -- a later plain
    // value overwrote a shaped one while the key stayed marked as shaped, and
    // the masking exemption then trusted the mark and printed the plaintext.
    if (!name.startsWith(path)) {
      throw new Error(`drift: ${name} is not under the requested path ${path}`);
    }
    const key = name.slice(path.length).replace(/^\//, '') || name;
    if (Object.hasOwn(state, key)) {
      throw new Error(`drift: two parameters resolve to the same key "${key}" under ${path}`);
    }
    if (parameter.Type === 'SecureString') {
      shapedKeys.add(key);
      state[key] = shapeOf(stableString(parameter.Value));
    } else {
      state[key] = parameter.Value;
    }
  }
  return {
    state,
    meta: { kind: 'ssm', label: `ssm ${path}`, sensitive: shapedKeys.size > 0, shapedKeys },
  };
}

/**
 * Read outputs from a Terraform state file on disk.
 *
 * A local file, so no credential and no network -- and deliberately only the
 * `outputs` block. Terraform state carries resource attributes including
 * provider credentials in plenty of real configurations, and walking all of it
 * would turn a drift check into an exfiltration primitive. Outputs marked
 * `sensitive` are shaped like any other secret.
 * @param {string} rest path to the state file
 * @returns {LiveState}
 */
function readTerraformState(rest) {
  const path = resolve(rest);
  // Same containment as every other read: a path from outside the project is
  // operator intent and allowed, but one inside it that escapes through a link
  // is the shape a pull request can author.
  assertTargetContained(path, process.cwd());
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`drift: no terraform state file at "${rest}"`);
  }
  /** @type {{ outputs?: Record<string, { value: unknown, sensitive?: boolean }> }} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Deliberately not echoing the parser's message: it quotes the bytes it
    // choked on, which for a file that is not terraform state means printing a
    // slice of whatever the file actually was.
    throw new Error(`drift: "${rest}" is not valid terraform state JSON`);
  }
  // Built with fromEntries rather than assignment, so a `__proto__` output is
  // an ordinary own key: kept and visible in the diff, never reaching
  // Object.prototype. The three readers now agree on this rule.
  /** @type {Record<string, unknown>} */
  const state = Object.create(null);
  /** @type {Set<string>} */
  const shapedKeys = new Set();
  for (const [key, output] of Object.entries(parsed.outputs ?? {})) {
    if (output?.sensitive) {
      shapedKeys.add(key);
      state[key] = shapeOf(stableString(output.value));
    } else {
      state[key] = output?.value;
    }
  }
  return {
    state,
    meta: {
      kind: 'tfstate',
      label: `terraform state ${rest}`,
      sensitive: shapedKeys.size > 0,
      shapedKeys,
    },
  };
}

/**
 * Read the live state a URI names.
 * @param {string} uri
 * @returns {LiveState}
 */
export function readLiveState(uri) {
  const { scheme, rest } = parseSourceUri(uri);
  switch (scheme) {
    case 'k8s':
    case 'kubernetes':
      return readKubernetes(rest);
    case 'ssm':
      return readSsm(rest);
    case 'tfstate':
      return readTerraformState(rest);
    default:
      throw new Error(`drift: "${scheme}://" is not a supported source`);
  }
}

export { shapeOf, ALLOWED_COMMANDS };
