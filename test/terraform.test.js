import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';

import {
  SENSITIVE_VALUE,
  UNKNOWN_VALUE,
  assertTerraformPlan,
  diffTerraformPlan,
  formatPlanSummary,
  isTerraformPlan,
  normalizeAction,
  readTerraformPlanFile,
} from '../src/terraform.js';
import { evaluatePolicies } from '../src/policy.js';

const rootIndex = resolve(process.cwd(), 'index.js');
const FIXTURES = resolve(process.cwd(), 'test/fixtures/terraform');

/**
 * @param {string} name
 * @returns {import('../src/terraform.js').TerraformPlanDiff}
 */
function diffFixture(name, options = {}) {
  return diffTerraformPlan(readTerraformPlanFile(join(FIXTURES, `${name}.json`)), options);
}

/**
 * @param {string} name
 * @returns {Promise<import('../src/policy.js').PolicyFinding[]>}
 */
async function findingsFor(name, options = {}) {
  const { changes } = diffFixture(name, options);
  return evaluatePolicies(changes, { policies: ['terraform'] });
}

/**
 * @param {import('../src/differ.js').ChangeEvent[]} changes
 * @returns {string[]}
 */
function signatures(changes) {
  return changes.map((change) => `${change.type} ${change.path}`);
}

/**
 * @param {import('../src/differ.js').ChangeEvent[]} changes
 * @param {string} path
 */
function eventAt(changes, path) {
  return changes.find((change) => change.path === path);
}

function runPlan(dir, args) {
  return spawnSync(process.execPath, [rootIndex, 'plan', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
}

describe('terraform plan detection', () => {
  test('recognizes plan JSON and rejects everything else clearly', () => {
    const plan = JSON.parse(readFileSync(join(FIXTURES, 'basic-actions.json'), 'utf8'));
    const notAPlan = JSON.parse(readFileSync(join(FIXTURES, 'not-a-plan.json'), 'utf8'));
    const state = JSON.parse(readFileSync(join(FIXTURES, 'state.json'), 'utf8'));

    assert.equal(isTerraformPlan(plan), true);
    assert.equal(isTerraformPlan(notAPlan), false);
    assert.equal(isTerraformPlan(state), false);
    assert.equal(isTerraformPlan(null), false);
    assert.equal(isTerraformPlan([]), false);
    // format_version alone is not enough.
    assert.equal(isTerraformPlan({ format_version: '1.2' }), false);

    assert.throws(
      () => assertTerraformPlan(notAPlan, 'plan.json'),
      /is not Terraform plan JSON: expected top-level "format_version" and "resource_changes"/,
    );
    // A state file gets its own diagnosis, since the fix differs.
    assert.throws(
      () => assertTerraformPlan(state, 'state.json'),
      /is Terraform state, not a plan/,
    );
    assert.throws(() => assertTerraformPlan(state, 'state.json'), /terraform show -json plan\.tfplan/);
  });

  test('readTerraformPlanFile reports unreadable and unparsable files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-tf-read-'));
    try {
      const broken = join(dir, 'plan.json');
      writeFileSync(broken, '{ not json', 'utf8');

      assert.throws(
        () => readTerraformPlanFile(join(dir, 'missing.json')),
        /Cannot read Terraform plan/,
      );
      assert.throws(() => readTerraformPlanFile(broken), /Could not parse .* as JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('normalizeAction collapses both replace orderings', () => {
    assert.equal(normalizeAction(['create']), 'create');
    assert.equal(normalizeAction(['update']), 'update');
    assert.equal(normalizeAction(['delete']), 'delete');
    assert.equal(normalizeAction(['no-op']), 'no-op');
    assert.equal(normalizeAction(['read']), 'read');
    assert.equal(normalizeAction(['delete', 'create']), 'replace');
    assert.equal(normalizeAction(['create', 'delete']), 'replace');
    assert.equal(normalizeAction([]), 'no-op');
    assert.equal(normalizeAction(undefined), 'no-op');
    // An action Flecto has never seen is reported, not silently dropped.
    assert.equal(normalizeAction(['create', 'forget']), 'create,forget');
  });
});

describe('terraform plan to change events', () => {
  test('create, update, and delete map onto added, changed, and removed', () => {
    const { changes, summary, formatVersion, terraformVersion } = diffFixture('basic-actions');

    assert.deepEqual(summary, {
      create: 1, update: 1, delete: 1, replace: 0, read: 1, noop: 1, other: 0, resources: 5,
    });
    assert.equal(formatVersion, '1.2');
    assert.equal(terraformVersion, '1.9.5');
    assert.equal(
      formatPlanSummary(summary),
      'Plan: 1 to add, 1 to change, 1 to destroy, 0 to replace.',
    );

    assert.deepEqual(signatures(changes), [
      'added aws_sqs_queue.jobs.name',
      'added aws_sqs_queue.jobs.visibility_timeout_seconds',
      'added aws_sqs_queue.jobs.#action',
      'changed aws_cloudwatch_log_group.app.retention_in_days',
      'changed aws_cloudwatch_log_group.app.#action',
      'removed aws_sqs_queue.old.name',
      'removed aws_sqs_queue.old.visibility_timeout_seconds',
      'removed aws_sqs_queue.old.#action',
    ]);

    assert.deepEqual(eventAt(changes, 'aws_sqs_queue.jobs.#action'), {
      type: 'added',
      path: 'aws_sqs_queue.jobs.#action',
      after: 'create',
      note: 'terraform will create aws_sqs_queue.jobs',
    });
    assert.deepEqual(eventAt(changes, 'aws_cloudwatch_log_group.app.#action'), {
      type: 'changed',
      path: 'aws_cloudwatch_log_group.app.#action',
      before: 'no-op',
      after: 'update',
      note: 'terraform will update aws_cloudwatch_log_group.app in place',
    });
    assert.deepEqual(eventAt(changes, 'aws_sqs_queue.old.#action'), {
      type: 'removed',
      path: 'aws_sqs_queue.old.#action',
      before: 'delete',
      note: 'terraform will destroy aws_sqs_queue.old',
    });

    // no-op and read change no infrastructure, so they produce no events.
    assert.ok(!changes.some((change) => change.path.startsWith('aws_sns_topic.alerts')));
    assert.ok(!changes.some((change) => change.path.startsWith('data.aws_caller_identity')));
    // A null attribute on a side is absent, not a value.
    assert.ok(!changes.some((change) => change.path.endsWith('delay_seconds')));
  });

  test('replace is a removal, never a benign update', () => {
    const { changes, summary } = diffFixture('destructive');

    assert.equal(summary.replace, 2);
    assert.equal(summary.delete, 2);

    // Both orderings — destroy-then-create and create_before_destroy — are one
    // replace, and both read as the destruction they are.
    const destroyFirst = eventAt(changes, 'aws_db_instance.main.#action');
    assert.deepEqual(destroyFirst, {
      type: 'removed',
      path: 'aws_db_instance.main.#action',
      before: 'replace',
      note: 'terraform will destroy and recreate aws_db_instance.main (forced by: engine_version)',
    });
    const createFirst = eventAt(changes, 'aws_instance.api.#action');
    assert.equal(createFirst.type, 'removed');
    assert.equal(createFirst.before, 'replace');
    assert.equal(createFirst.note, 'terraform will destroy and recreate aws_instance.api');

    // The attribute diff still shows what actually differs.
    assert.deepEqual(eventAt(changes, 'aws_db_instance.main.engine_version'), {
      type: 'changed',
      path: 'aws_db_instance.main.engine_version',
      before: '13.4',
      after: '14.1',
    });

    // Module addresses keep their prefix, so paths stay unambiguous.
    assert.equal(eventAt(changes, 'module.storage.aws_ebs_volume.data.#action').before, 'delete');
  });

  test('after_unknown never renders as null and never invents a change', () => {
    const { changes } = diffFixture('unknown');

    // A create's computed attributes carry no information, so they are dropped
    // rather than listed as "(known after apply)" noise.
    assert.deepEqual(signatures(changes).filter((s) => s.includes('aws_instance.web')), [
      'added aws_instance.web.ami',
      'added aws_instance.web.instance_type',
      'added aws_instance.web.tags.Name',
      'added aws_instance.web.#action',
    ]);
    assert.ok(!changes.some((change) => change.after === null));
    assert.ok(!changes.some((change) => change.path === 'aws_instance.web.id'));
    assert.ok(!changes.some((change) => change.path.includes('root_block_device')));

    // A known value being replaced by an unknown one is a real change, and is
    // surfaced with Terraform's own wording plus a note.
    assert.deepEqual(eventAt(changes, 'aws_lb.app.dns_name'), {
      type: 'changed',
      path: 'aws_lb.app.dns_name',
      before: 'app-1234.eu-west-1.elb.amazonaws.com',
      after: UNKNOWN_VALUE,
      note: 'known after apply',
    });
    assert.equal(UNKNOWN_VALUE, '(known after apply)');
  });

  test('terraform-sensitive values are redacted before they leave the parser', () => {
    const raw = readFileSync(join(FIXTURES, 'sensitive.json'), 'utf8');
    // The fixture really does contain the values, so this proves redaction.
    assert.ok(raw.includes('correct-horse-battery-staple-2'));
    assert.ok(raw.includes('prod-shared-passphrase-value'));
    assert.ok(raw.includes('new-inner-passphrase'));

    const { changes } = diffFixture('sensitive');
    const serialized = JSON.stringify(changes);
    assert.ok(!serialized.includes('correct-horse-battery-staple'));
    assert.ok(!serialized.includes('prod-shared-passphrase-value'));
    assert.ok(!serialized.includes('inner-passphrase'));

    // A sensitive value that changed still produces an event, even though both
    // sides redact to the same placeholder.
    assert.deepEqual(eventAt(changes, 'aws_db_instance.main.password'), {
      type: 'changed',
      path: 'aws_db_instance.main.password',
      before: SENSITIVE_VALUE,
      after: SENSITIVE_VALUE,
      note: 'sensitive',
    });
    assert.equal(SENSITIVE_VALUE, '(sensitive value)');

    // A sensitive marker on a map marks every leaf under it.
    assert.equal(eventAt(changes, 'aws_ecs_task_definition.api.environment.DB_DSN').after, SENSITIVE_VALUE);
    assert.equal(eventAt(changes, 'aws_ecs_task_definition.api.environment.LOG_LEVEL').after, SENSITIVE_VALUE);
    // Non-sensitive siblings are untouched.
    assert.equal(eventAt(changes, 'aws_secretsmanager_secret_version.app.version_stages[0]').after, 'AWSCURRENT');
  });

  test('an unchanged sensitive value produces no event', () => {
    const plan = {
      format_version: '1.2',
      resource_changes: [{
        address: 'aws_db_instance.main',
        change: {
          actions: ['update'],
          before: { password: 'same-value-here', allocated_storage: 100 },
          after: { password: 'same-value-here', allocated_storage: 200 },
          before_sensitive: { password: true },
          after_sensitive: { password: true },
        },
      }],
    };
    const { changes } = diffTerraformPlan(plan);
    assert.deepEqual(signatures(changes), [
      'changed aws_db_instance.main.allocated_storage',
      'changed aws_db_instance.main.#action',
    ]);
  });

  test('--ignore applies to plan paths exactly as it does to config paths', () => {
    const all = diffFixture('capacity').changes;
    const ignored = diffFixture('capacity', {
      ignorePaths: ['**.#action', 'aws_autoscaling_group.web.max_size'],
    }).changes;

    assert.ok(all.some((change) => change.path.endsWith('.#action')));
    assert.deepEqual(signatures(ignored), [
      'changed aws_autoscaling_group.web.desired_capacity',
      'changed aws_instance.worker[0].instance_type',
      'changed aws_ecs_service.api.desired_count',
    ]);

    // A subtree prefix drops one whole resource.
    const perResource = diffFixture('capacity', { ignorePaths: ['aws_autoscaling_group.web'] }).changes;
    assert.ok(!perResource.some((change) => change.path.startsWith('aws_autoscaling_group.web')));
  });

  test('unfamiliar shapes warn instead of throwing', () => {
    const future = diffTerraformPlan({
      format_version: '9.0',
      resource_changes: ['not an object'],
    });
    assert.equal(future.summary.resources, 0);
    assert.equal(future.changes.length, 0);
    assert.match(future.warnings[0], /Plan format version 9\.0 is newer/);
    assert.match(future.warnings[1], /Skipping resource_changes\[0\]/);

    // A resource with no address still gets a stable, unique key.
    const anonymous = diffTerraformPlan({
      format_version: '1.2',
      resource_changes: [{ change: { actions: ['create'], after: { a: 1 } } }],
    });
    assert.deepEqual(signatures(anonymous.changes), [
      'added resource_changes[0].a',
      'added resource_changes[0].#action',
    ]);

    // A deposed instance cannot collide with the live one at the same address.
    const deposed = diffTerraformPlan({
      format_version: '1.2',
      resource_changes: [
        { address: 'aws_instance.web', change: { actions: ['create'], after: { ami: 'ami-new' } } },
        { address: 'aws_instance.web', deposed: 'abc123', change: { actions: ['delete'], before: { ami: 'ami-old' } } },
      ],
    });
    assert.deepEqual(signatures(deposed.changes), [
      'added aws_instance.web.ami',
      'added aws_instance.web.#action',
      'removed aws_instance.web (deposed abc123).ami',
      'removed aws_instance.web (deposed abc123).#action',
    ]);
  });
});

describe('terraform policy pack', () => {
  test('terraform-resource-replaced fires on every replace and nothing else', async () => {
    const findings = (await findingsFor('destructive'))
      .filter((finding) => finding.id === 'terraform-resource-replaced');
    assert.deepEqual(findings.map((finding) => finding.path), [
      'aws_db_instance.main.#action',
      'aws_instance.api.#action',
    ]);
    assert.ok(findings.every((finding) => finding.severity === 'error'));

    // Plain creates, updates, and deletes are not replaces.
    const benign = (await findingsFor('basic-actions'));
    assert.deepEqual(benign, []);
  });

  test('terraform-stateful-resource-destroyed fires only for stateful destruction', async () => {
    const findings = (await findingsFor('destructive'))
      .filter((finding) => finding.id === 'terraform-stateful-resource-destroyed');
    assert.deepEqual(findings.map((finding) => finding.path), [
      // A replaced database is destroyed too.
      'aws_db_instance.main.#action',
      // Module-nested addresses still match.
      'module.storage.aws_ebs_volume.data.#action',
    ]);
    // aws_instance.api is replaced but stateless; aws_sqs_queue.temp is deleted
    // but stateless. Neither fires.
    assert.ok(!findings.some((finding) => finding.path.includes('aws_instance.api')));
    assert.ok(!findings.some((finding) => finding.path.includes('aws_sqs_queue.temp')));
  });

  test('terraform-security-group-open-ingress ignores egress and narrow CIDRs', async () => {
    const findings = (await findingsFor('security-group'))
      .filter((finding) => finding.id === 'terraform-security-group-open-ingress');
    assert.deepEqual(findings.map((finding) => finding.path), [
      'aws_security_group.web.ingress[0].cidr_blocks[0]',
      'aws_vpc_security_group_ingress_rule.open_ssh.cidr_ipv4',
    ]);
    assert.ok(findings.every((finding) => finding.severity === 'error'));
    assert.match(findings[0].message, /0\.0\.0\.0\/0/);

    // Egress to the internet is ordinary, and an ingress from 10.0.0.0/8 is not
    // an exposure — neither may fire.
    assert.ok(!findings.some((finding) => finding.path.includes('egress')));
    assert.ok(!findings.some((finding) => finding.path.includes('aws_security_group.internal')));
  });

  test('terraform-iam-wildcard fires on bare "*" but not on scoped policies', async () => {
    const findings = (await findingsFor('iam'))
      .filter((finding) => finding.id === 'terraform-iam-wildcard');
    assert.deepEqual(findings.map((finding) => finding.path), [
      // "Action": "*" and "Resource": "*"
      'aws_iam_policy.admin.policy',
      // "Action": ["s3:GetObject", "*"]
      'aws_iam_role_policy.deploy.policy',
    ]);
    // Scoped actions and an ARN ending in "/*" are not wildcards.
    assert.ok(!findings.some((finding) => finding.path.includes('reader')));
  });

  test('terraform S3 rules fire on public exposure only', async () => {
    const findings = await findingsFor('s3');
    assert.deepEqual(
      findings.map((finding) => `${finding.id} ${finding.path}`),
      [
        // One of the four block_public_* flags turned off.
        'terraform-s3-public-access-block-disabled aws_s3_bucket_public_access_block.data.block_public_acls',
        // Destroying the block resource re-opens the bucket just as effectively.
        'terraform-s3-public-access-block-disabled aws_s3_bucket_public_access_block.legacy.#action',
        'terraform-s3-public-acl aws_s3_bucket_acl.site.acl',
      ],
    );
    assert.ok(findings.every((finding) => finding.severity === 'error'));
    // acl = "private" must not fire, and neither may the flags left at true.
    assert.ok(!findings.some((finding) => finding.path.includes('reports')));
    assert.ok(!findings.some((finding) => finding.path.endsWith('block_public_policy')));
  });

  test('capacity and instance-size rules need a real jump', async () => {
    const findings = await findingsFor('capacity');
    assert.deepEqual(
      findings.map((finding) => `${finding.id} ${finding.path}`),
      [
        // 2 -> 8 is 4x.
        'terraform-capacity-jump aws_autoscaling_group.web.desired_capacity',
        'terraform-instance-size-changed aws_instance.worker[0].instance_type',
      ],
    );
    assert.ok(findings.every((finding) => finding.severity === 'warn'));
    assert.match(findings[0].message, /jumps from 2 to 8/);
    assert.match(findings[1].message, /from t3\.micro to m5\.4xlarge/);

    // max_size 10 -> 12 and desired_count 4 -> 5 are under 2x.
    assert.ok(!findings.some((finding) => finding.path.endsWith('max_size')));
    assert.ok(!findings.some((finding) => finding.path.endsWith('desired_count')));
  });

  test('terraform-sensitive-value-changed flags every redacted value', async () => {
    const findings = (await findingsFor('sensitive'))
      .filter((finding) => finding.id === 'terraform-sensitive-value-changed');
    assert.deepEqual(findings.map((finding) => finding.path), [
      'aws_db_instance.main.password',
      'aws_secretsmanager_secret_version.app.secret_string',
      'aws_ecs_task_definition.api.environment.LOG_LEVEL',
      'aws_ecs_task_definition.api.environment.DB_DSN',
    ]);
    // A plan with no sensitive values produces none of these.
    assert.ok(!(await findingsFor('capacity'))
      .some((finding) => finding.id === 'terraform-sensitive-value-changed'));
  });

  test('terraform-hardcoded-credential catches a token Terraform did not mark', async () => {
    // Assembled at runtime: a complete literal token in a committed file trips
    // GitHub push protection.
    const token = `AKIA${'Q3EXAMPLEKEY1234'}`;
    const plan = {
      format_version: '1.2',
      resource_changes: [{
        address: 'aws_ssm_parameter.deploy',
        change: {
          actions: ['create'],
          before: null,
          after: { name: '/deploy/key', value: token, type: 'String' },
          after_sensitive: {},
        },
      }, {
        address: 'aws_ssm_parameter.region',
        change: {
          actions: ['create'],
          before: null,
          after: { name: '/deploy/region', value: 'eu-west-1', type: 'String' },
          after_sensitive: {},
        },
      }],
    };

    const { changes } = diffTerraformPlan(plan);
    const findings = await evaluatePolicies(changes, { policies: ['terraform'] });
    assert.deepEqual(
      findings.map((finding) => `${finding.id} ${finding.path} ${finding.severity}`),
      ['terraform-hardcoded-credential aws_ssm_parameter.deploy.value error'],
    );

    // The same value marked sensitive by Terraform is redacted first, so this
    // rule cannot fire on it — the sensitive rule covers that case instead.
    plan.resource_changes[0].change.after_sensitive = { value: true };
    const redacted = await evaluatePolicies(diffTerraformPlan(plan).changes, { policies: ['terraform'] });
    assert.deepEqual(
      redacted.map((finding) => finding.id),
      ['terraform-sensitive-value-changed'],
    );
  });
});

describe('flecto plan CLI', () => {
  test('human output summarizes the plan and explains every action', () => {
    const result = runPlan(process.cwd(), [join(FIXTURES, 'destructive.json')]);

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /plan format 1\.2, terraform 1\.9\.5/);
    assert.match(result.stdout, /Plan: 0 to add, 0 to change, 2 to destroy, 2 to replace\./);
    assert.match(result.stdout, /destructive\.json — 9 changes from the current state:/);
    assert.match(
      result.stdout,
      /- aws_db_instance\.main\.#action: "replace" \[terraform will destroy and recreate aws_db_instance\.main \(forced by: engine_version\)\]/,
    );
    assert.match(result.stdout, /! policy\(error\) \[terraform\] aws_db_instance\.main\.#action: Terraform will destroy and recreate/);
    assert.match(result.stdout, /Terraform will destroy a stateful resource/);
  });

  test('a plan with nothing to do exits 0 and says so', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-plan-empty-'));
    try {
      const planFile = join(dir, 'plan.json');
      writeFileSync(planFile, JSON.stringify({
        format_version: '1.2',
        terraform_version: '1.9.5',
        resource_changes: [{
          address: 'aws_sns_topic.alerts',
          change: { actions: ['no-op'], before: { name: 'a' }, after: { name: 'a' } },
        }],
      }), 'utf8');

      const result = runPlan(dir, [planFile]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Plan: 0 to add, 0 to change, 0 to destroy, 0 to replace\./);
      assert.match(result.stdout, /matches the current state — no changes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('machine formats reuse the ci envelope and printer', () => {
    const planFile = join(FIXTURES, 's3.json');
    const json = runPlan(process.cwd(), [planFile, '--format', 'json']);
    const ndjson = runPlan(process.cwd(), [planFile, '--format', 'ndjson']);
    const annotations = runPlan(process.cwd(), [planFile, '--format', 'github-annotations']);
    const comment = runPlan(process.cwd(), [planFile, '--format', 'pr-comment']);
    const bogus = runPlan(process.cwd(), [planFile, '--format', 'yaml']);

    assert.equal(json.status, 1);
    const results = JSON.parse(json.stdout);
    assert.equal(results.length, 1);
    assert.equal(results[0].file, planFile);
    assert.equal(results[0].envelope.schema_version, '2.0');
    assert.equal(results[0].envelope.event_type, 'changes');
    assert.equal(results[0].envelope.source, 'ci');
    assert.equal(results[0].envelope.file, planFile);
    assert.deepEqual(results[0].envelope.changes[0], {
      type: 'changed',
      path: 'aws_s3_bucket_public_access_block.data.block_public_acls',
      before: true,
      after: false,
    });
    assert.equal(results[0].policies[0].id, 'terraform-s3-public-access-block-disabled');
    assert.equal(results[0].policies[0].pack, 'terraform');

    assert.equal(ndjson.status, 1);
    assert.equal(ndjson.stdout.trim().split('\n').length, 1);

    assert.equal(annotations.status, 1);
    assert.match(
      annotations.stdout,
      /::error file=.*s3\.json,title=flecto policy terraform-s3-public-acl \[terraform\]::aws_s3_bucket_acl\.site\.acl: /,
    );

    assert.equal(comment.status, 1);
    assert.match(comment.stdout, /<!-- flecto:pr-comment -->/);
    assert.match(comment.stdout, /terraform-s3-public-acl/);

    assert.equal(bogus.status, 1);
    assert.match(bogus.stderr, /--format must be human, json, ndjson, github-annotations, or pr-comment/);
  });

  test('several plan files produce one result each', () => {
    const result = runPlan(process.cwd(), [
      join(FIXTURES, 'iam.json'),
      join(FIXTURES, 'capacity.json'),
      '--format', 'json',
    ]);
    assert.equal(result.status, 1);
    const results = JSON.parse(result.stdout);
    assert.deepEqual(results.map((entry) => entry.file), [
      join(FIXTURES, 'iam.json'),
      join(FIXTURES, 'capacity.json'),
    ]);
    assert.equal(results[0].envelope.batch_id !== results[1].envelope.batch_id, true);
  });

  test('--fail-on defaults to errors, not to having a plan at all', () => {
    // basic-actions has changes but trips no rule, so the default gate passes.
    const clean = runPlan(process.cwd(), [join(FIXTURES, 'basic-actions.json')]);
    assert.equal(clean.status, 0, clean.stderr);

    // Warnings alone do not fail either, until asked for.
    const warnings = runPlan(process.cwd(), [join(FIXTURES, 'capacity.json')]);
    const warnGate = runPlan(process.cwd(), [join(FIXTURES, 'capacity.json'), '--fail-on', 'warn']);
    const policyGate = runPlan(process.cwd(), [join(FIXTURES, 'capacity.json'), '--fail-on', 'policy']);
    assert.equal(warnings.status, 0, warnings.stderr);
    assert.equal(warnGate.status, 1);
    assert.equal(policyGate.status, 1);

    // An error-severity finding fails under the default.
    const errors = runPlan(process.cwd(), [join(FIXTURES, 's3.json')]);
    assert.equal(errors.status, 1);

    // Destroying a resource can be gated without any policy pack at all.
    const removed = runPlan(process.cwd(), [
      join(FIXTURES, 'basic-actions.json'), '--fail-on', 'removed',
    ]);
    assert.equal(removed.status, 1);

    // A replace is a removal, so a removed-gate catches it too.
    const replaceOnly = runPlan(process.cwd(), [
      join(FIXTURES, 'destructive.json'), '--fail-on', 'removed', '--policies', 'compose',
    ]);
    assert.equal(replaceOnly.status, 1);
  });

  test('policies default to the terraform pack and honor --policies', () => {
    const withDefault = runPlan(process.cwd(), [join(FIXTURES, 's3.json'), '--format', 'json']);
    const explicit = runPlan(process.cwd(), [
      join(FIXTURES, 's3.json'), '--policies', 'compose', '--format', 'json',
    ]);

    const defaulted = JSON.parse(withDefault.stdout)[0].policies;
    assert.ok(defaulted.length > 0);
    assert.ok(defaulted.every((finding) => finding.pack === 'terraform'));

    // An explicit pack replaces the default entirely.
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.deepEqual(JSON.parse(explicit.stdout)[0].policies, []);
  });

  test('.flectorc profiles and --ignore flow through the normal options path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-plan-rc-'));
    try {
      writeFileSync(join(dir, '.flectorc.json'), JSON.stringify({
        defaults: { ignore: '**.#action' },
        profiles: {
          lax: { policies: 'compose', format: 'ndjson' },
        },
      }), 'utf8');
      const planFile = join(FIXTURES, 'destructive.json');

      const defaults = runPlan(dir, [planFile, '--format', 'json']);
      const profile = runPlan(dir, ['--profile', 'lax', planFile]);

      // defaults.ignore removes every action marker, and with it the rules that
      // key on one.
      assert.equal(defaults.status, 0, defaults.stderr);
      const changes = JSON.parse(defaults.stdout)[0].envelope.changes;
      assert.ok(!changes.some((change) => change.path.endsWith('.#action')));
      assert.deepEqual(JSON.parse(defaults.stdout)[0].policies, []);

      // The profile supplies both the pack and the format.
      assert.equal(profile.status, 0, profile.stderr);
      assert.equal(profile.stdout.trim().split('\n').length, 1);
      assert.equal(JSON.parse(profile.stdout).envelope.source, 'ci');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--mask-secrets adds Flecto detection on top of terraform redaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-plan-mask-'));
    try {
      const token = `AKIA${'Q3EXAMPLEKEY1234'}`;
      const planFile = join(dir, 'plan.json');
      writeFileSync(planFile, JSON.stringify({
        format_version: '1.2',
        resource_changes: [{
          address: 'aws_ssm_parameter.deploy',
          change: {
            actions: ['create'],
            before: null,
            after: { value: token },
            after_sensitive: {},
          },
        }],
      }), 'utf8');

      const plain = runPlan(dir, [planFile, '--format', 'json']);
      const masked = runPlan(dir, [planFile, '--format', 'json', '--mask-secrets']);

      // Terraform did not mark it, so without masking the value is shown — and
      // the credential rule is what raises the alarm.
      assert.equal(plain.status, 1);
      assert.ok(plain.stdout.includes(token));
      assert.equal(JSON.parse(plain.stdout)[0].policies[0].id, 'terraform-hardcoded-credential');

      assert.equal(masked.status, 1);
      assert.ok(!masked.stdout.includes(token));
      assert.match(masked.stdout, /"after": "\*\*\*"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sensitive values never reach any output format', () => {
    const planFile = join(FIXTURES, 'sensitive.json');
    for (const format of ['human', 'json', 'ndjson', 'github-annotations', 'pr-comment']) {
      const result = runPlan(process.cwd(), [planFile, '--format', format]);
      const output = `${result.stdout}${result.stderr}`;
      assert.ok(!output.includes('correct-horse-battery-staple'), `leaked in ${format}`);
      assert.ok(!output.includes('prod-shared-passphrase-value'), `leaked in ${format}`);
      assert.ok(!output.includes('inner-passphrase'), `leaked in ${format}`);
      // github-annotations prints paths and messages, never values.
      if (format !== 'github-annotations') {
        assert.ok(output.includes('(sensitive value)'), `no placeholder in ${format}`);
      }
    }
  });

  test('a non-plan file is rejected with instructions, not a confusing diff', () => {
    const notAPlan = runPlan(process.cwd(), [join(FIXTURES, 'not-a-plan.json')]);
    const state = runPlan(process.cwd(), [join(FIXTURES, 'state.json')]);
    const missing = runPlan(process.cwd(), [join(FIXTURES, 'nope.json')]);

    assert.equal(notAPlan.status, 1);
    assert.match(notAPlan.stderr, /is not Terraform plan JSON/);
    assert.match(notAPlan.stderr, /terraform show -json plan\.tfplan > plan\.json/);
    assert.match(notAPlan.stderr, /Flecto never runs the terraform binary/);

    assert.equal(state.status, 1);
    assert.match(state.stderr, /is Terraform state, not a plan/);

    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /File not found: .*nope\.json/);
  });

  test('a newer plan format warns but still runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-plan-future-'));
    try {
      const planFile = join(dir, 'plan.json');
      writeFileSync(planFile, JSON.stringify({
        format_version: '2.0',
        resource_changes: [{
          address: 'aws_sqs_queue.jobs',
          change: { actions: ['create'], before: null, after: { name: 'jobs' } },
        }],
      }), 'utf8');

      const result = runPlan(dir, [planFile]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /Plan format version 2\.0 is newer/);
      assert.match(result.stdout, /\+ aws_sqs_queue\.jobs\.name: "jobs"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('plan files are refused on the generic config path (#113)', () => {
  const planPath = join(FIXTURES, 'sensitive-user-data.json');
  const SECRETS = /BOOTSTRAPSENSITIVEBEFORE|BOOTSTRAPSENSITIVEAFTER/;

  /**
   * A baseline snapshot whose sensitive value differs, so a raw structural diff
   * would emit a change event carrying it.
   * @param {string} dir
   * @returns {string}
   */
  function writeBaseline(dir) {
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    plan.resource_changes[0].change.after.user_data = 'BASELINEPLACEHOLDER';
    const path = join(dir, 'snap.json');
    writeFileSync(path, JSON.stringify({ state: plan }), 'utf8');
    return path;
  }

  test('flecto plan still redacts, which is the whole point of the guard', () => {
    const run = spawnSync(process.execPath, [rootIndex, 'plan', planPath], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.doesNotMatch(run.stdout, SECRETS);
    assert.match(run.stdout, /aws_instance\.app\.user_data/);
    assert.match(run.stdout, /\(sensitive value\)/);
  });

  test('ci refuses a plan instead of printing its sensitive values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-tf-ci-'));
    try {
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'ci', planPath, '--snapshot-ref', writeBaseline(dir), '--format', 'json', '--mask-secrets'],
        { encoding: 'utf8', cwd: dir },
      );
      assert.equal(run.status, 1);
      assert.doesNotMatch(run.stdout + run.stderr, SECRETS);
      assert.match(run.stderr, /is Terraform plan JSON/);
      assert.match(run.stderr, /flecto plan/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('watch --diff refuses a plan against a snapshot taken before the guard', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-tf-watch-'));
    try {
      // Snapshotting a plan is refused now, so the only way to reach --diff is
      // a snapshot written by an older version. Recreate that shape by hand.
      const id = createHash('sha256').update(planPath.replaceAll('\\', '/')).digest('hex').slice(0, 16);
      const snapshotDir = join(dir, '.flecto-snapshots');
      mkdirSync(snapshotDir, { recursive: true });
      const plan = JSON.parse(readFileSync(planPath, 'utf8'));
      plan.resource_changes[0].change.after.user_data = 'BASELINEPLACEHOLDER';
      writeFileSync(
        join(snapshotDir, `${id}.json`),
        JSON.stringify({ file: planPath, state: plan }),
        'utf8',
      );

      const run = spawnSync(
        process.execPath,
        [rootIndex, 'watch', planPath, '--diff', '--mask-secrets'],
        { encoding: 'utf8', cwd: dir },
      );
      assert.equal(run.status, 1);
      assert.doesNotMatch(run.stdout + run.stderr, SECRETS);
      assert.match(run.stderr, /is Terraform plan JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('compare refuses a plan on either side', () => {
    const run = spawnSync(
      process.execPath,
      [rootIndex, 'compare', planPath, planPath],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 1);
    assert.doesNotMatch(run.stdout + run.stderr, SECRETS);
    assert.match(run.stderr, /is Terraform plan JSON/);
  });

  test('snapshotting a plan is refused, so report can never carry one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-tf-snap-'));
    try {
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'watch', planPath, '--snapshot'],
        { encoding: 'utf8', cwd: dir },
      );
      assert.equal(run.status, 1);
      assert.doesNotMatch(run.stdout + run.stderr, SECRETS);
      assert.match(run.stderr, /is Terraform plan JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ordinary JSON config is untouched by the guard', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-tf-plain-'));
    try {
      const target = join(dir, 'config.json');
      const snap = join(dir, 'snap.json');
      writeFileSync(target, JSON.stringify({ pool_size: 20 }), 'utf8');
      writeFileSync(snap, JSON.stringify({ state: { pool_size: 5 } }), 'utf8');
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'ci', target, '--snapshot-ref', snap, '--format', 'json', '--fail-on', ''],
        { encoding: 'utf8', cwd: dir },
      );
      assert.equal(run.status, 0);
      assert.match(run.stdout, /"pool_size"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a JSON file that merely has format_version is not mistaken for a plan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flecto-tf-notplan-'));
    try {
      const target = join(dir, 'config.json');
      const snap = join(dir, 'snap.json');
      // Terraform *state* has format_version but no resource_changes array.
      writeFileSync(target, JSON.stringify({ format_version: '1.2', replicas: 3 }), 'utf8');
      writeFileSync(snap, JSON.stringify({ state: { format_version: '1.2', replicas: 1 } }), 'utf8');
      const run = spawnSync(
        process.execPath,
        [rootIndex, 'ci', target, '--snapshot-ref', snap, '--format', 'json', '--fail-on', ''],
        { encoding: 'utf8', cwd: dir },
      );
      assert.equal(run.status, 0);
      assert.match(run.stdout, /"replicas"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
