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
      'pr-comment-post', 'github-token', 'snapshot-ref', 'node-version',
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
    assert.equal(inputs['node-version'].default, '20');
    assert.equal(inputs['flecto-version'].default, '2');

    for (const [name, spec] of Object.entries(inputs)) {
      assert.equal(spec.required, false, `${name}: nothing is required`);
      assert.equal(typeof spec.description, 'string', `${name}: is documented`);
      assert.notEqual(spec.default, undefined, `${name}: has a default`);
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
