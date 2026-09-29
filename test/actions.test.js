import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import yaml from 'js-yaml';

// The bundled Actions are metadata, not code: nothing imports them, so a typo
// in an input name or a broken YAML block would only surface in a consumer's
// workflow run. These tests parse the committed files and pin the contract.

const ACTIONS_DIR = fileURLToPath(new URL('../.github/actions', import.meta.url));
const EXAMPLES_DIR = fileURLToPath(new URL('../examples/github-action', import.meta.url));
const ROOT_ACTION = fileURLToPath(new URL('../action.yml', import.meta.url));

const EXPRESSION = /\$\{\{([^}]*)\}\}/gu;

/**
 * @param {string} path
 * @returns {{ text: string, doc: any }}
 */
function loadYaml(path) {
  const text = readFileSync(path, 'utf8');
  return { text, doc: yaml.load(text) };
}

/** @returns {string[]} Action directory names, e.g. ['flecto-ci', 'flecto-pr-risk'] */
function actionNames() {
  return readdirSync(ACTIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * @param {string} name
 * @returns {{ text: string, doc: any }}
 */
function loadAction(name) {
  return loadYaml(join(ACTIONS_DIR, name, 'action.yml'));
}

/**
 * Every `${{ ... }}` expression in a string.
 * @param {string} text
 * @returns {string[]}
 */
function expressionsIn(text) {
  return [...String(text).matchAll(EXPRESSION)].map((match) => match[1].trim());
}

/**
 * Walk a parsed document and collect every string leaf, with the leading path
 * of the keys that reached it.
 * @param {unknown} node
 * @param {string} [path]
 * @returns {Array<[string, string]>}
 */
function stringLeaves(node, path = '') {
  if (typeof node === 'string') return [[path, node]];
  if (Array.isArray(node)) {
    return node.flatMap((item, i) => stringLeaves(item, `${path}[${i}]`));
  }
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([key, value]) => (
      stringLeaves(value, path ? `${path}.${key}` : key)
    ));
  }
  return [];
}

/**
 * Map a workflow `uses:` value onto a bundled action directory, if it names one.
 * Accepts both the local form and the org-wide `owner/repo/path@ref` form.
 * @param {string} uses
 * @returns {string | null}
 */
function bundledActionFor(uses) {
  const match = /(?:^\.\/|^myselfsiddharth\/Flecto\/)\.github\/actions\/([^/@]+)(?:@.+)?$/u
    .exec(String(uses));
  return match ? match[1] : null;
}

describe('bundled GitHub Actions', () => {
  test('every action.yml parses and is a composite action', () => {
    const names = actionNames();
    assert.ok(names.includes('flecto-ci'), 'flecto-ci action is present');
    assert.ok(names.includes('flecto-pr-risk'), 'flecto-pr-risk action is present');

    for (const name of names) {
      const { doc } = loadAction(name);
      assert.equal(typeof doc.name, 'string', `${name}: has a name`);
      assert.equal(typeof doc.description, 'string', `${name}: has a description`);
      assert.equal(doc.runs?.using, 'composite', `${name}: is composite`);
      assert.ok(Array.isArray(doc.runs.steps) && doc.runs.steps.length > 0,
        `${name}: has steps`);
      for (const step of doc.runs.steps) {
        assert.ok(step.uses || step.shell === 'bash',
          `${name}: run steps declare shell: bash`);
      }
    }
  });

  test('flecto-ci inputs and defaults are unchanged', () => {
    // Other repositories consume this action by ref. Renaming an input or
    // moving a default is a breaking change for them; this test makes that
    // deliberate rather than accidental.
    const { doc } = loadAction('flecto-ci');
    assert.deepEqual(Object.keys(doc.inputs), [
      'targets', 'fail-on', 'policies', 'profile', 'format',
      'pr-comment-post', 'github-token', 'snapshot-ref', 'snapshot-file',
      'flecto-version', 'node-version',
    ]);
    const defaults = Object.fromEntries(
      Object.entries(doc.inputs).map(([key, spec]) => [key, spec.default]),
    );
    assert.deepEqual(defaults, {
      'targets': 'config/**/*.{yaml,yml,json,toml,ini}',
      'fail-on': 'policy,error',
      'policies': '',
      'profile': '',
      'format': 'github-annotations',
      'pr-comment-post': 'false',
      'github-token': '',
      'snapshot-ref': 'HEAD~1',
      // Added in 4.0, optional and empty by default, so existing consumers are
      // unaffected. It exists because --snapshot-ref no longer accepts a bare
      // snapshot filename, and without it those users would have no route.
      'snapshot-file': '',
      // Added so the CLI can be pinned without forking the action, matching
      // flecto-pr-risk. It is also a security floor -- see the version-floor
      // test below for why it must never drop to 3.
      'flecto-version': '4',
      'node-version': '20',
    });
  });

  test('flecto-pr-risk defaults make it adoptable in one line', () => {
    const { doc } = loadAction('flecto-pr-risk');
    const inputs = doc.inputs;

    // The opinionated set: PR comment, posted, gated on risk only.
    assert.equal(inputs.format.default, 'pr-comment');
    assert.equal(inputs['pr-comment-post'].default, 'true');
    assert.equal(inputs['fail-on'].default, 'policy,error');
    assert.equal(inputs['mask-secrets'].default, 'true');
    // The workflow token by default, so the caller passes nothing.
    assert.equal(inputs['github-token'].default, '${{ github.token }}');
    // Empty, not HEAD~1: the baseline is resolved from the pull request.
    assert.equal(inputs['snapshot-ref'].default, '');
    // Empty by default: config mode stays the default mode, so adding this
    // input changes nothing for existing consumers.
    assert.equal(inputs['terraform-plan'].default, '');
    assert.equal(inputs['node-version'].default, '20');
    assert.equal(inputs['flecto-version'].default, '4');

    for (const [name, spec] of Object.entries(inputs)) {
      assert.equal(spec.required, false, `${name}: nothing is required`);
      assert.equal(typeof spec.description, 'string', `${name}: is documented`);
      assert.notEqual(spec.default, undefined, `${name}: has a default`);
    }
  });

  test('terraform-plan switches to `flecto plan` and drops the baseline', () => {
    // A Terraform plan JSON already contains before/after, so `flecto plan`
    // needs no baseline and no git history. The risk in wiring that up is
    // weakening the config path's fail-closed behaviour by accident, so both
    // modes are asserted here rather than just the new one.
    const { doc } = loadAction('flecto-pr-risk');
    const run = doc.runs.steps.find((s) => s.name && s.name.includes('Run Flecto'));

    // The plan subcommand, taking the file directly and no --snapshot-ref.
    assert.match(run.run, /args=\(plan "\$INPUT_TERRAFORM_PLAN"/);
    // The config path keeps its baseline.
    assert.match(run.run, /args=\(ci "\$\{targets\[@\]\}"/);
    assert.match(run.run, /args\+=\(--snapshot-ref "\$INPUT_SNAPSHOT_REF"\)/);

    // A missing plan file must fail rather than let `flecto plan` report
    // nothing: a gate that passes because it read no input is not a gate.
    assert.match(run.run, /if \[\[ ! -f "\$INPUT_TERRAFORM_PLAN" \]\]; then/);

    // The input must reach both steps that branch on it.
    const baseline = doc.runs.steps.find((s) => s.id === 'baseline');
    assert.equal(baseline.env.INPUT_TERRAFORM_PLAN, '${{ inputs.terraform-plan }}');
    assert.equal(run.env.INPUT_TERRAFORM_PLAN, '${{ inputs.terraform-plan }}');
  });

  test('the baseline step fails closed for config mode and only skips for a plan', () => {
    // Regression guard for the skip added with terraform-plan. The baseline step
    // is what stops an unresolvable baseline reporting "no changes" and letting
    // a risky edit through, so the plan-mode early exit must be reachable only
    // when a plan file was actually requested.
    const { doc } = loadAction('flecto-pr-risk');
    const baseline = doc.runs.steps.find((s) => s.id === 'baseline');

    const planSkip = baseline.run.indexOf('if [[ -n "$INPUT_TERRAFORM_PLAN" ]]; then');
    const baseShaCheck = baseline.run.indexOf('if [[ -z "$PR_BASE_SHA" ]]; then');
    assert.ok(planSkip > -1, 'plan mode short-circuits the baseline');
    assert.ok(baseShaCheck > -1, 'the missing-base-commit check still exists');
    assert.ok(planSkip < baseShaCheck,
      'the plan skip must precede the base-commit check, or plan mode still requires a PR');

    // The skip is guarded on the plan input alone -- not on the event, and not
    // on whether a baseline happened to resolve.
    assert.match(baseline.run, /fail "Pull request base commit .* is missing from the checkout/);
  });

  test('the root Marketplace action.yml has not drifted from flecto-pr-risk', () => {
    // GitHub only lists an action whose metadata file is at the repository root,
    // so the listing points at /action.yml while everyone already referencing
    // .github/actions/flecto-pr-risk/ keeps working. That means two copies of
    // the same gate logic, and a fix applied to one and not the other is the
    // worst outcome: the listed action would silently behave differently from
    // the documented one.
    //
    // So the `runs:` block must be identical. If this fails, the fix is to copy
    // the change across, not to relax the test.
    const root = loadYaml(ROOT_ACTION);
    const sub = loadYaml(join(ACTIONS_DIR, 'flecto-pr-risk', 'action.yml'));

    // Normalize line endings first. A Windows checkout can carry CRLF, and the
    // invariant is that the two files declare the same steps -- not that they
    // were checked out with the same newlines.
    const runsBlock = (text) => {
      const normalized = text.replace(/\r\n/gu, '\n');
      const at = normalized.indexOf('\nruns:\n');
      assert.notEqual(at, -1, 'a runs: block exists');
      return normalized.slice(at);
    };

    assert.equal(runsBlock(root.text), runsBlock(sub.text),
      'action.yml and .github/actions/flecto-pr-risk/action.yml have different '
      + 'runs: blocks. Copy the change into both.');

    // Inputs are the contract consumers write against, so they must match too --
    // names, defaults and all. Only the listing metadata may differ.
    assert.deepEqual(Object.keys(root.doc.inputs), Object.keys(sub.doc.inputs));
    for (const [name, spec] of Object.entries(root.doc.inputs)) {
      assert.equal(spec.default, sub.doc.inputs[name].default, `${name}: same default`);
    }
    assert.deepEqual(root.doc.outputs, sub.doc.outputs);
  });

  test('the root action.yml satisfies the Marketplace listing requirements', () => {
    // Verified against GitHub's docs, recorded in docs/decisions.md D-007.
    // These are cheap to assert and expensive to discover on a failed publish.
    const { doc } = loadYaml(ROOT_ACTION);

    // A listing needs a name and description; the name must be globally unique
    // across Marketplace, which only the publish form can confirm.
    assert.equal(typeof doc.name, 'string');
    assert.ok(doc.name.trim().length > 0, 'has a name');
    assert.ok(doc.description && doc.description.trim().length > 0, 'has a description');

    // The Marketplace rejects a listing whose description is 125 characters or
    // more. This was found the hard way: v4.1.0 shipped a 194-character one and
    // the publish form refused it, which cost a patch release. The limit is not
    // in the metadata-syntax docs and nothing else checks it, so it is pinned
    // here -- the failure is otherwise invisible until someone tries to publish.
    const MAX_DESCRIPTION = 125;
    const description = doc.description.trim();
    assert.ok(description.length < MAX_DESCRIPTION,
      `action.yml description is ${description.length} characters; the Marketplace `
      + `limit is under ${MAX_DESCRIPTION}. Shorten it, and keep the longer pitch `
      + 'in the README, which has room for it.');

    // Branding is optional for publishing, but if present it must be a real
    // Feather icon name and one of the nine supported colours -- an invalid
    // value is rejected at publish time, not at parse time.
    if (doc.branding) {
      const COLORS = ['white', 'black', 'yellow', 'blue', 'green', 'orange', 'red', 'purple', 'gray-dark'];
      assert.ok(COLORS.includes(doc.branding.color),
        `branding.color ${doc.branding.color} is not one of ${COLORS.join(', ')}`);
      assert.match(doc.branding.icon, /^[a-z0-9-]+$/u, 'branding.icon looks like a Feather icon name');
    }
  });

  test('neither action can install a Flecto older than 4', () => {
    // Regression guard. Both actions shipped `flecto@3` after 4.0.0 released,
    // and that was not a compatibility slip -- it was a live bypass:
    //
    //   1. flecto-ci advertises `snapshot-file:` and passes --snapshot-file,
    //      which does not exist before 4.0, so the documented input hard-failed.
    //   2. flecto-ci's default `snapshot-ref: HEAD~1` against a 3.x CLI is the
    //      baseline-shadowing bypass 4.0 closed: a pull request commits a file
    //      named HEAD~1, it is read instead of the revision, it is written to
    //      match the hostile tip, the diff is empty, and no --fail-on value
    //      catches it.
    //
    // Asserted as a floor over both actions rather than as an equality on one
    // literal, so this still fails if a 5.0 bump leaves an action behind, and
    // still fails if a third action is added with its own version input.
    const MIN_MAJOR = 4;

    for (const name of ['flecto-ci', 'flecto-pr-risk']) {
      const { doc, text } = loadAction(name);

      const spec = doc.inputs['flecto-version'];
      assert.ok(spec, `${name}: exposes a flecto-version input`);
      const major = Number.parseInt(String(spec.default), 10);
      assert.ok(Number.isInteger(major), `${name}: flecto-version default is numeric`);
      assert.ok(major >= MIN_MAJOR,
        `${name}: flecto-version default is ${spec.default}, below the ${MIN_MAJOR} floor`);

      // The default is only a floor if nothing bypasses it with a hardcoded
      // install. Catch `npx flecto@3`, `flecto@^3`, `flecto@3.1.0` and friends.
      const hardcoded = [...text.matchAll(/flecto@(?!\$\{)[~^]?v?(\d+)/g)];
      for (const [match, ver] of hardcoded) {
        assert.ok(Number.parseInt(ver, 10) >= MIN_MAJOR,
          `${name}: hardcoded install "${match}" is below the ${MIN_MAJOR} floor`);
      }

      // And the install must actually route through the input.
      assert.match(text, /flecto@\$\{INPUT_FLECTO_VERSION\}/,
        `${name}: installs the version from the flecto-version input`);
    }
  });

  test('flecto-pr-risk resolves the baseline from the pull request base commit', () => {
    const { doc, text } = loadAction('flecto-pr-risk');
    const baseline = doc.runs.steps.find((step) => step.id === 'baseline');
    assert.ok(baseline, 'a baseline step exists');
    assert.equal(baseline.env.PR_BASE_SHA, '${{ github.event.pull_request.base.sha }}');
    // It must fail closed: an unresolvable baseline reports "no changes".
    assert.match(baseline.run, /::error title=Flecto PR risk::/u);
    assert.match(baseline.run, /exit 1/u);
    assert.match(baseline.run, /fetch-depth: 0/u);
    // The resolved value is what the CLI is actually given.
    const cli = doc.runs.steps.at(-1);
    assert.equal(cli.env.INPUT_SNAPSHOT_REF, '${{ steps.baseline.outputs.snapshot-ref }}');
    assert.match(cli.run, /--snapshot-ref/u);
    assert.ok(text.includes('pull-requests'), 'the file mentions the permission it needs');
  });

  test('flecto-pr-risk degrades instead of failing when it cannot post', () => {
    const { doc } = loadAction('flecto-pr-risk');
    const posting = doc.runs.steps.find((step) => step.id === 'posting');
    assert.ok(posting, 'a posting-preflight step exists');
    // It warns; it never exits non-zero, which would turn a read-only fork
    // token into a failed check.
    assert.match(posting.run, /::warning title=Flecto PR risk::/u);
    assert.doesNotMatch(posting.run, /exit 1/u);
    assert.match(posting.run, /fork/iu);
    // The preflight only learns whether a token exists, never its value.
    assert.equal(posting.env.HAS_TOKEN, "${{ inputs.github-token != '' }}");
    assert.ok(
      !Object.values(posting.env).some((value) => /inputs\.github-token\s*\}\}/u.test(value)),
      'the preflight step is not handed the token itself',
    );
  });

  test('every referenced input and step output is declared', () => {
    for (const name of actionNames()) {
      const { doc, text } = loadAction(name);
      const declared = new Set(Object.keys(doc.inputs ?? {}));
      const stepIds = new Set(doc.runs.steps.map((step) => step.id).filter(Boolean));

      for (const expression of expressionsIn(text)) {
        const input = /^inputs\.([\w-]+)$/u.exec(expression);
        if (input) {
          assert.ok(declared.has(input[1]),
            `${name}: referenced input '${input[1]}' is declared`);
        }
        const output = /^steps\.([\w-]+)\.outputs\.[\w-]+$/u.exec(expression);
        if (output) {
          assert.ok(stepIds.has(output[1]),
            `${name}: referenced step id '${output[1]}' exists`);
        }
      }
    }
  });

  test('no run script interpolates a workflow expression', () => {
    // `${{ ... }}` is substituted into the script text before bash sees it, so
    // an expression inside `run:` can splice a secret (or an attacker-supplied
    // title) straight into the shell. Values reach the scripts through `env:`.
    for (const name of actionNames()) {
      const { doc } = loadAction(name);
      for (const step of doc.runs.steps) {
        if (typeof step.run !== 'string') continue;
        assert.deepEqual(expressionsIn(step.run), [],
          `${name}: step '${step.name ?? step.id}' has no expression in its run script`);
      }
    }
  });
});

describe('example workflows', () => {
  const files = readdirSync(EXAMPLES_DIR).filter((file) => file.endsWith('.yml')).sort();

  test('every example workflow parses and has jobs', () => {
    assert.ok(files.includes('flecto-ci.yml'));
    assert.ok(files.includes('flecto-pr-risk.yml'));
    for (const file of files) {
      const { doc } = loadYaml(join(EXAMPLES_DIR, file));
      assert.equal(typeof doc.name, 'string', `${file}: has a name`);
      // js-yaml 4 keeps `on` a string key rather than YAML 1.1's boolean true.
      assert.ok(doc.on, `${file}: has triggers`);
      assert.ok(Object.keys(doc.jobs ?? {}).length > 0, `${file}: has jobs`);
    }
  });

  test('example workflows only pass inputs the action declares', () => {
    for (const file of files) {
      const { doc } = loadYaml(join(EXAMPLES_DIR, file));
      for (const job of Object.values(doc.jobs)) {
        for (const step of job.steps ?? []) {
          const action = step.uses ? bundledActionFor(step.uses) : null;
          if (!action) continue;
          const declared = new Set(Object.keys(loadAction(action).doc.inputs ?? {}));
          for (const input of Object.keys(step.with ?? {})) {
            assert.ok(declared.has(input),
              `${file}: '${input}' is an input of ${action}`);
          }
        }
      }
    }
  });

  test('the PR-risk example grants the permissions the comment needs', () => {
    const { doc } = loadYaml(join(EXAMPLES_DIR, 'flecto-pr-risk.yml'));
    assert.equal(doc.permissions.contents, 'read');
    assert.equal(doc.permissions['pull-requests'], 'write');
    assert.ok(doc.on.pull_request, 'runs on pull_request, where a base commit exists');

    const steps = doc.jobs['config-risk'].steps;
    const checkout = steps.find((step) => String(step.uses).startsWith('actions/checkout@'));
    // Anything shallower has no base commit to diff against.
    assert.equal(checkout.with['fetch-depth'], 0);
    assert.ok(steps.some((step) => bundledActionFor(step.uses ?? '') === 'flecto-pr-risk'));
  });
});
