import { readFileSync } from 'fs';
import { diffTrees } from './differ.js';

/**
 * Terraform plan JSON → Flecto change events.
 *
 * Flecto never runs the `terraform` binary. It reads the JSON Terraform itself
 * produces:
 *
 *   terraform plan -out plan.tfplan
 *   terraform show -json plan.tfplan > plan.json
 *
 * The conversion flattens each `resource_changes[]` entry into a map of leaf
 * path → value for the "before" and "after" sides, keyed by the resource
 * `address`, then hands both sides to the same {@link diffTrees} every other
 * Flecto command uses. That is what makes `aws_security_group.web` produce
 * paths such as `aws_security_group.web.ingress[0].cidr_blocks[0]`, and it is
 * why `--ignore` behaves identically here and on config files.
 *
 * @typedef {import('./differ.js').ChangeEvent} ChangeEvent
 *
 * @typedef {'create' | 'read' | 'update' | 'delete' | 'replace' | 'no-op'} TerraformAction
 *
 * @typedef {{
 *   create: number,
 *   update: number,
 *   delete: number,
 *   replace: number,
 *   read: number,
 *   noop: number,
 *   other: number,
 *   resources: number
 * }} TerraformPlanSummary
 *
 * @typedef {{
 *   changes: ChangeEvent[],
 *   summary: TerraformPlanSummary,
 *   formatVersion: string | null,
 *   terraformVersion: string | null,
 *   warnings: string[]
 * }} TerraformPlanDiff
 */

/**
 * Stand-in for a value Terraform cannot resolve until apply. Terraform's own
 * CLI prints this exact phrase, so a Flecto diff reads the same way a
 * `terraform plan` does.
 */
export const UNKNOWN_VALUE = '(known after apply)';

/**
 * Stand-in for a value Terraform marked sensitive. Substituted at parse time —
 * before the policy engine, the envelope, or any formatter can see it — so a
 * value Terraform refuses to print can never leak through Flecto either.
 */
export const SENSITIVE_VALUE = '(sensitive value)';

/**
 * Pseudo-attribute carrying the planned action for a resource. `#` cannot occur
 * in a Terraform attribute name, so this can never collide with a real one, and
 * it gives resource-level policy rules a single event to match instead of one
 * per attribute.
 */
const ACTION_KEY = '#action';

/** Plan format versions this converter has been written against. */
const SUPPORTED_FORMAT_MAJOR = 1;

const GENERATE_HINT = 'Generate one with:\n'
  + '\n'
  + '  terraform plan -out plan.tfplan\n'
  + '  terraform show -json plan.tfplan > plan.json\n'
  + '\n'
  + 'Flecto never runs the terraform binary — it only reads the JSON terraform writes.';

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read one position out of an `after_unknown` / `*_sensitive` mirror.
 *
 * A mirror is `true` (everything at and below this position is unknown or
 * sensitive), `false`/absent, or a nested object/array shaped like the value.
 * `true` propagates down so marking a whole map sensitive marks every leaf.
 * @param {unknown} mirror
 * @param {string | number} key
 * @returns {unknown}
 */
function childMirror(mirror, key) {
  if (mirror === true) return true;
  if (mirror && typeof mirror === 'object') {
    return Object.hasOwn(mirror, key) ? mirror[key] : undefined;
  }
  return undefined;
}

/**
 * @param {unknown} mirror
 * @returns {string[]}
 */
function mirrorKeys(mirror) {
  return isPlainObject(mirror) ? Object.keys(mirror) : [];
}

/**
 * @param {unknown} mirror
 * @returns {number}
 */
function mirrorLength(mirror) {
  return Array.isArray(mirror) ? mirror.length : 0;
}

/**
 * @typedef {{
 *   entries: Array<[string, unknown]>,
 *   unknownPaths: Set<string>,
 *   sensitivePaths: Set<string>
 * }} FlattenContext
 */

/**
 * Flatten one side of a resource change into leaf `path → value` entries.
 *
 * `null` and absent values are dropped rather than emitted, matching how
 * Terraform renders a plan: an optional attribute that is simply unset is not a
 * change. Unsetting an attribute therefore shows up as a removal, and setting
 * one as an addition.
 * @param {unknown} value
 * @param {unknown} unknown  the matching `after_unknown` position
 * @param {unknown} sensitive  the matching `*_sensitive` position
 * @param {string} path
 * @param {FlattenContext} ctx
 */
function flatten(value, unknown, sensitive, path, ctx) {
  if (unknown === true) {
    ctx.entries.push([path, UNKNOWN_VALUE]);
    ctx.unknownPaths.add(path);
    if (sensitive === true) ctx.sensitivePaths.add(path);
    return;
  }

  const objectShaped = isPlainObject(value)
    || (value == null && (isPlainObject(unknown) || isPlainObject(sensitive)));
  if (objectShaped) {
    const object = isPlainObject(value) ? value : {};
    const keys = new Set([...Object.keys(object), ...mirrorKeys(unknown), ...mirrorKeys(sensitive)]);
    if (keys.size === 0) {
      pushLeaf(path, isPlainObject(value) ? value : undefined, sensitive, ctx);
      return;
    }
    for (const key of keys) {
      flatten(
        Object.hasOwn(object, key) ? object[key] : undefined,
        childMirror(unknown, key),
        childMirror(sensitive, key),
        `${path}.${key}`,
        ctx,
      );
    }
    return;
  }

  const arrayShaped = Array.isArray(value)
    || (value == null && (Array.isArray(unknown) || Array.isArray(sensitive)));
  if (arrayShaped) {
    const list = Array.isArray(value) ? value : [];
    const length = Math.max(list.length, mirrorLength(unknown), mirrorLength(sensitive));
    if (length === 0) {
      pushLeaf(path, Array.isArray(value) ? value : undefined, sensitive, ctx);
      return;
    }
    for (let index = 0; index < length; index += 1) {
      flatten(
        list[index],
        childMirror(unknown, index),
        childMirror(sensitive, index),
        `${path}[${index}]`,
        ctx,
      );
    }
    return;
  }

  pushLeaf(path, value, sensitive, ctx);
}

/**
 * @param {string} path
 * @param {unknown} value
 * @param {unknown} sensitive
 * @param {FlattenContext} ctx
 */
function pushLeaf(path, value, sensitive, ctx) {
  // An attribute that is null or absent on this side is not a value; see
  // flatten() for why that is deliberate.
  if (value === undefined || value === null) return;
  ctx.entries.push([path, value]);
  if (sensitive === true) ctx.sensitivePaths.add(path);
}

/**
 * Collapse Terraform's action array into a single verb.
 *
 * `["delete","create"]` and `["create","delete"]` are both a replace — the
 * ordering only says whether the new resource is created before the old one is
 * destroyed. Anything unrecognized is returned verbatim so a future Terraform
 * action is reported rather than silently dropped.
 * @param {unknown} actions
 * @returns {TerraformAction | string}
 */
export function normalizeAction(actions) {
  const list = Array.isArray(actions) ? actions.map(String) : [];
  if (list.length === 0) return 'no-op';
  if (list.length === 1) return list[0];
  if (list.length === 2 && list.includes('create') && list.includes('delete')) return 'replace';
  return list.join(',');
}

/**
 * @param {unknown} replacePaths
 * @returns {string[]}
 */
function formatReplacePaths(replacePaths) {
  if (!Array.isArray(replacePaths)) return [];
  return replacePaths
    .map((entry) => (Array.isArray(entry) ? entry.map(String).join('.') : String(entry ?? '')))
    .filter(Boolean);
}

/**
 * Plain-English sentence describing what Terraform will do to a resource.
 * @param {string} action
 * @param {string} address
 * @param {unknown} replacePaths
 * @returns {string}
 */
function actionNote(action, address, replacePaths) {
  if (action === 'create') return `terraform will create ${address}`;
  if (action === 'update') return `terraform will update ${address} in place`;
  if (action === 'delete') return `terraform will destroy ${address}`;
  if (action === 'replace') {
    const forced = formatReplacePaths(replacePaths);
    const because = forced.length > 0 ? ` (forced by: ${forced.join(', ')})` : '';
    return `terraform will destroy and recreate ${address}${because}`;
  }
  return `terraform will apply "${action}" to ${address}`;
}

/**
 * The `#action` marker values for a planned action.
 *
 * `create` becomes an addition, `delete` a removal, `update` a change — and
 * `replace` is deliberately a **removal** carrying the value `"replace"`. A
 * replace destroys the resource before (or right after) recreating it, so
 * representing it as a change would let it pass a reviewer's eye, and any
 * `--fail-on removed` gate as well. Modelling the destruction is the honest
 * reading: the recreated resource is a new object, with a new id, and anything
 * held only on the old one is gone.
 * @param {string} action
 * @returns {{ before?: string, after?: string }}
 */
function actionMarker(action) {
  if (action === 'create') return { after: 'create' };
  if (action === 'delete') return { before: 'delete' };
  if (action === 'replace') return { before: 'replace' };
  if (action === 'update') return { before: 'no-op', after: 'update' };
  return { before: 'no-op', after: action };
}

/**
 * Unique key for a resource change. Terraform addresses already carry `count` /
 * `for_each` keys, so only a deposed instance can collide with its live one.
 * @param {Record<string, unknown>} change
 * @param {number} index
 * @returns {string}
 */
function resourceAddress(change, index) {
  const address = typeof change.address === 'string' && change.address.trim()
    ? change.address.trim()
    : `resource_changes[${index}]`;
  const deposed = typeof change.deposed === 'string' && change.deposed.trim()
    ? change.deposed.trim()
    : null;
  return deposed ? `${address} (deposed ${deposed})` : address;
}

/**
 * @param {string} existing
 * @param {string} addition
 * @returns {string}
 */
function joinNote(existing, addition) {
  return existing ? `${existing}; ${addition}` : addition;
}

/**
 * Convert one `resource_changes[]` entry into change events.
 * @param {Record<string, unknown>} resourceChange
 * @param {number} index
 * @param {{ ignorePaths?: string[] }} options
 * @returns {{ action: string, events: ChangeEvent[] }}
 */
function resourceChangeToEvents(resourceChange, index, options) {
  const change = isPlainObject(resourceChange.change) ? resourceChange.change : {};
  const action = normalizeAction(change.actions);
  if (action === 'no-op' || action === 'read') return { action, events: [] };

  const address = resourceAddress(resourceChange, index);
  const marker = actionMarker(action);

  /** @type {FlattenContext} */
  const beforeCtx = { entries: [], unknownPaths: new Set(), sensitivePaths: new Set() };
  /** @type {FlattenContext} */
  const afterCtx = { entries: [], unknownPaths: new Set(), sensitivePaths: new Set() };

  // A create has no prior state and a delete has no planned state, so only the
  // populated side is flattened. There is no `before_unknown`: prior state is
  // always fully known.
  if (action !== 'create') {
    flatten(change.before, undefined, change.before_sensitive, address, beforeCtx);
  }
  if (action !== 'delete') {
    flatten(change.after, change.after_unknown, change.after_sensitive, address, afterCtx);
  }

  if (marker.before !== undefined) beforeCtx.entries.push([`${address}.${ACTION_KEY}`, marker.before]);
  if (marker.after !== undefined) afterCtx.entries.push([`${address}.${ACTION_KEY}`, marker.after]);

  const sensitivePaths = new Set([...beforeCtx.sensitivePaths, ...afterCtx.sensitivePaths]);
  const unknownPaths = afterCtx.unknownPaths;

  // The diff runs on the raw values so an equal-looking pair of redacted
  // sensitive values cannot hide a real change; redaction happens immediately
  // afterwards, before anything leaves this module.
  const events = diffTrees(
    Object.fromEntries(beforeCtx.entries),
    Object.fromEntries(afterCtx.entries),
    { ignorePaths: options.ignorePaths ?? [] },
  );

  const note = actionNote(action, address, change.replace_paths);
  /** @type {ChangeEvent[]} */
  const out = [];
  for (const event of events) {
    // "This computed attribute will be known after apply" says nothing when the
    // attribute is brand new. The same value replacing a known one does, so
    // only pure additions are dropped.
    if (event.type === 'added' && event.after === UNKNOWN_VALUE) continue;

    /** @type {ChangeEvent} */
    const next = { ...event };
    if (sensitivePaths.has(event.path)) {
      if (Object.hasOwn(next, 'before')) next.before = SENSITIVE_VALUE;
      if (Object.hasOwn(next, 'after')) next.after = SENSITIVE_VALUE;
      next.note = joinNote(next.note ?? '', 'sensitive');
    }
    if (unknownPaths.has(event.path)) {
      next.note = joinNote(next.note ?? '', 'known after apply');
    }
    if (event.path === `${address}.${ACTION_KEY}`) {
      next.note = joinNote(next.note ?? '', note);
    }
    out.push(next);
  }

  return { action, events: out };
}

/**
 * True when a parsed JSON value looks like `terraform show -json <planfile>`
 * output.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTerraformPlan(value) {
  return isPlainObject(value)
    && typeof value.format_version === 'string'
    && Array.isArray(value.resource_changes);
}

/**
 * True when a parsed JSON value is Terraform *state* rather than a plan —
 * `terraform show -json` with no plan file argument.
 * @param {unknown} value
 * @returns {boolean}
 */
function isTerraformState(value) {
  return isPlainObject(value)
    && typeof value.format_version === 'string'
    && !Array.isArray(value.resource_changes)
    && isPlainObject(value.values);
}

/**
 * Throw a message that explains how to produce the file Flecto wants.
 * @param {unknown} value
 * @param {string} label
 * @returns {asserts value is Record<string, unknown>}
 */
export function assertTerraformPlan(value, label) {
  if (isTerraformPlan(value)) return;
  if (isTerraformState(value)) {
    throw new Error(
      `"${label}" is Terraform state, not a plan: it has "values" but no "resource_changes".\n`
      + `${GENERATE_HINT}`,
    );
  }
  throw new Error(
    `"${label}" is not Terraform plan JSON: expected top-level "format_version" and "resource_changes".\n`
    + `${GENERATE_HINT}`,
  );
}

/**
 * The inverse guard: refuse a Terraform plan on the *generic config* path.
 *
 * Terraform's `before_sensitive` / `after_sensitive` redaction is applied by
 * diffTerraformPlan(), which only `flecto plan` calls. A plan file is ordinary
 * JSON, so every other command would read it as a plain config tree and print
 * the values Terraform itself refuses to print. `--mask-secrets` is not a
 * backstop: it only fires when an attribute name matches the secret pattern,
 * and `user_data` does not (#113).
 *
 * Failing closed rather than skipping is deliberate and matches how the rest of
 * Flecto behaves — a plan file swept up by a repo-wide glob is a real
 * misconfiguration, and silently omitting the file would leave an operator
 * believing it had been gated.
 * @param {unknown} value
 * @param {string} label
 */
export function assertNotTerraformPlan(value, label) {
  if (!isTerraformPlan(value)) return;
  throw new Error(
    `"${label}" is Terraform plan JSON, which this command cannot read safely.\n`
    + 'Terraform marks sensitive attributes in before_sensitive/after_sensitive, and that\n'
    + 'redaction is only applied by "flecto plan". Reading the plan as a plain config file\n'
    + 'would print those values.\n'
    + `Use: flecto plan ${label}`,
  );
}

/**
 * Read and validate a Terraform plan JSON file.
 * @param {string} filepath
 * @returns {Record<string, unknown>}
 */
export function readTerraformPlanFile(filepath) {
  let raw;
  try {
    raw = readFileSync(filepath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read Terraform plan "${filepath}": ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Could not parse "${filepath}" as JSON: ${error.message}\n${GENERATE_HINT}`,
    );
  }
  assertTerraformPlan(parsed, filepath);
  return parsed;
}

/**
 * Convert a parsed Terraform plan into Flecto change events.
 *
 * Only `ignorePaths` is honored from the usual diff options: a plan is already
 * flattened onto Terraform's own indexed addressing (`ingress[0]`), so array
 * identity matching and order-insensitive comparison have nothing to act on.
 * @param {unknown} plan  parsed `terraform show -json` output
 * @param {{ ignorePaths?: string[] }} [options]
 * @returns {TerraformPlanDiff}
 */
export function diffTerraformPlan(plan, options = {}) {
  assertTerraformPlan(plan, 'plan');

  /** @type {ChangeEvent[]} */
  const changes = [];
  const summary = {
    create: 0, update: 0, delete: 0, replace: 0, read: 0, noop: 0, other: 0, resources: 0,
  };
  /** @type {string[]} */
  const warnings = [];

  const formatVersion = typeof plan.format_version === 'string' ? plan.format_version : null;
  const terraformVersion = typeof plan.terraform_version === 'string' ? plan.terraform_version : null;
  const major = Number.parseInt(String(formatVersion ?? '').split('.')[0], 10);
  if (Number.isFinite(major) && major > SUPPORTED_FORMAT_MAJOR) {
    warnings.push(
      `Plan format version ${formatVersion} is newer than the ${SUPPORTED_FORMAT_MAJOR}.x format Flecto understands. `
      + 'Attributes may be misread; upgrade Flecto if the diff looks wrong.',
    );
  }

  const resourceChanges = /** @type {unknown[]} */ (plan.resource_changes);
  for (const [index, entry] of resourceChanges.entries()) {
    if (!isPlainObject(entry)) {
      warnings.push(`Skipping resource_changes[${index}]: expected an object.`);
      continue;
    }
    summary.resources += 1;
    const { action, events } = resourceChangeToEvents(entry, index, options);
    if (action === 'no-op') summary.noop += 1;
    else if (action === 'read') summary.read += 1;
    else if (Object.hasOwn(summary, action)) summary[action] += 1;
    else summary.other += 1;
    changes.push(...events);
  }

  return { changes, summary, formatVersion, terraformVersion, warnings };
}

/**
 * One-line summary in Terraform's own wording.
 * @param {TerraformPlanSummary} summary
 * @returns {string}
 */
export function formatPlanSummary(summary) {
  return `Plan: ${summary.create} to add, ${summary.update} to change, `
    + `${summary.delete} to destroy, ${summary.replace} to replace.`;
}
