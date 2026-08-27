import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

import { parseFile, parseContent, isSupported } from '../src/parser.js';
import { diffTrees } from '../src/differ.js';
import { renderChanges, renderDiff } from '../src/renderer.js';
import { evaluatePolicies } from '../src/policy.js';
import {
  encryptionState,
  encryptedValueScheme,
  isEncryptedSentinel,
  looksLikeSopsMetadata,
  normalizeEncrypted,
} from '../src/encrypted.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sops');
const ROOT_INDEX = resolve(process.cwd(), 'index.js');

/**
 * Substrings that must never survive into anything Flecto emits. The first two
 * are the ciphertext container formats; the rest are the actual base64 bodies
 * used by the fixtures, which is what a length- or content-leak would look like.
 */
const CIPHERTEXT_MARKERS = [
  'ENC[',
  'BEGIN AGE ENCRYPTED FILE',
  'BEGIN PGP MESSAGE',
  'ZmFrZQ==',
  'ZmFrZTA=',
  'ZmFrZTE=',
  'ZmFrZTI=',
  'bWFjMA==',
  'bWFjMQ==',
  'ZmFrZWZha2VmYWtlZmFrZQ==',
  'ZmFrZW5ld2NvbWVyZmFrZQ==',
  'ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtl',
];

/**
 * @param {string} name
 * @returns {string}
 */
function fixture(name) {
  return join(FIXTURES, name);
}

/**
 * @param {string} text
 * @param {string} label
 */
function assertNoCiphertext(text, label) {
  for (const marker of CIPHERTEXT_MARKERS) {
    assert.ok(
      !text.includes(marker),
      `${label} leaked ciphertext marker ${JSON.stringify(marker)}:\n${text}`,
    );
  }
}

/**
 * Capture console.log output with ANSI styling stripped.
 * @param {() => void} fn
 * @returns {string}
 */
function captureStdout(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n').replaceAll(/\[[0-9;]*m/gu, '');
}

/**
 * @param {string[]} args
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function runCli(args) {
  const result = spawnSync(process.execPath, [ROOT_INDEX, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('detection', () => {
  test('the fixtures really do contain ciphertext, so the leak tests mean something', () => {
    const raw = readFileSync(fixture('secrets.before.yaml'), 'utf8');
    assert.ok(raw.includes('ENC[AES256_GCM,data:'));
    assert.ok(raw.includes('-----BEGIN AGE ENCRYPTED FILE-----'));
    assert.ok(raw.includes('-----BEGIN PGP MESSAGE-----'));
  });

  test('a SOPS-encrypted YAML file is detected from its content', () => {
    const tree = parseFile(fixture('secrets.before.yaml'));
    assert.equal(encryptionState(tree), 'sops');
    assert.ok(looksLikeSopsMetadata(tree.sops));
  });

  test('a SOPS-encrypted JSON file is detected from its content', () => {
    assert.equal(encryptionState(parseFile(fixture('secrets.before.json'))), 'sops');
  });

  test('an armored age file is detected and reduced to one opaque value', () => {
    const tree = parseFile(fixture('archive.before.age'));
    assert.equal(typeof tree, 'string');
    assert.ok(isEncryptedSentinel(tree));
    assert.equal(encryptionState(tree), 'age');
    assert.ok(isSupported(fixture('archive.before.age')));
  });

  test('armor is detected by content even under a .yaml name', () => {
    const raw = readFileSync(fixture('archive.before.age'), 'utf8');
    assert.ok(isEncryptedSentinel(parseContent('/tmp/secrets.yaml', raw)));
  });

  test('a config with a plain top-level sops key is NOT treated as encrypted', () => {
    const tree = parseFile(fixture('lookalike.yaml'));
    assert.equal(encryptionState(tree), 'plaintext');
    assert.equal(looksLikeSopsMetadata(tree.sops), false);
    // Version pin, settings, and all: the block survives verbatim.
    assert.deepEqual(tree.sops, { version: '3.9.0', enabled: true, config_path: '.sops.yaml' });
  });

  test('a sops block needs a MAC or a stamp AND a key group, not just a version', () => {
    assert.equal(looksLikeSopsMetadata({ version: '3.9.0' }), false);
    assert.equal(looksLikeSopsMetadata({ version: '3.9.0', mac: 'x' }), false);
    assert.equal(looksLikeSopsMetadata({ version: '3.9.0', mac: 'x', lastmodified: 'y' }), true);
    assert.equal(
      looksLikeSopsMetadata({ version: '3.9.0', mac: 'x', age: [{ recipient: 'age1x' }] }),
      true,
    );
    assert.equal(looksLikeSopsMetadata({ mac: 'x', lastmodified: 'y' }), false);
  });

  test('SOPS dotenv/INI flat metadata is recognized', () => {
    assert.equal(
      encryptionState({ sops_version: '3.9.0', sops_mac: 'ENC[AES256_GCM,data:x]' }),
      'sops',
    );
    assert.equal(encryptionState({ sops_version: '3.9.0' }), 'plaintext');
  });

  test('encryptedValueScheme classifies each container without decrypting', () => {
    assert.equal(
      encryptedValueScheme('ENC[AES256_GCM,data:ZmFrZQ==,iv:ZmFrZQ==,tag:ZmFrZQ==,type:str]'),
      'sops',
    );
    assert.equal(encryptedValueScheme('-----BEGIN AGE ENCRYPTED FILE-----\nZmFrZQ==\n'), 'age');
    assert.equal(encryptedValueScheme('-----BEGIN PGP MESSAGE-----\nZmFrZQ==\n'), 'pgp');
    assert.equal(encryptedValueScheme('ENCODED[not-sops]'), null);
    assert.equal(encryptedValueScheme('postgres://db.internal:5432/billing'), null);
    assert.equal(encryptedValueScheme(42), null);
  });
});

describe('ciphertext never reaches output', () => {
  test('no ENC[ or base64 body survives parsing', () => {
    for (const name of ['secrets.before.yaml', 'secrets.after.yaml', 'secrets.before.json']) {
      assertNoCiphertext(JSON.stringify(parseFile(fixture(name))), `parsed ${name}`);
    }
  });

  test('no ciphertext survives a rendered diff, with or without --mask-secrets', () => {
    const before = parseFile(fixture('secrets.before.yaml'));
    const after = parseFile(fixture('secrets.after.yaml'));
    const events = diffTrees(before, after);

    for (const maskSecrets of [false, true]) {
      for (const mode of ['compact', 'verbose']) {
        const out = captureStdout(() => renderChanges('secrets.yaml', events, mode, { maskSecrets }));
        assertNoCiphertext(out, `renderChanges(${mode}, mask=${maskSecrets})`);
      }
      const diffOut = captureStdout(() => renderDiff('secrets.yaml', events, { maskSecrets }));
      assertNoCiphertext(diffOut, `renderDiff(mask=${maskSecrets})`);
    }
  });

  test('no ciphertext survives the CLI in any output format', () => {
    for (const format of ['human', 'json', 'ndjson', 'github-annotations']) {
      const result = runCli([
        'compare',
        fixture('secrets.before.yaml'),
        fixture('secrets.after.yaml'),
        '--format', format,
        '--policies', 'default,sops',
      ]);
      assertNoCiphertext(result.stdout, `compare --format ${format} stdout`);
      assertNoCiphertext(result.stderr, `compare --format ${format} stderr`);
    }
  });

  test('the encrypted-to-plaintext transition does not print the exposed values either', () => {
    const result = runCli([
      'compare',
      fixture('secrets.before.yaml'),
      fixture('secrets.plaintext.yaml'),
      '--policies', 'default,sops',
    ]);
    assertNoCiphertext(result.stdout, 'decrypted-file compare');
    assert.ok(!result.stdout.includes('not-a-real-password'));
    assert.ok(!result.stdout.includes('not-a-real-api-key'));
    assert.ok(result.stdout.includes('<no longer encrypted>'));
  });

  test('the age blob itself never appears in a rendered diff', () => {
    const events = diffTrees(
      parseFile(fixture('archive.before.age')),
      parseFile(fixture('archive.after.age')),
    );
    const out = captureStdout(() => renderDiff('archive.age', events));
    assertNoCiphertext(out, 'age archive diff');
    assert.match(out, /<encrypted value changed>/);
  });
});

describe('structural reporting', () => {
  test('an encrypted value that changed is reported as changed, not shown', () => {
    const events = diffTrees(
      parseFile(fixture('secrets.before.yaml')),
      parseFile(fixture('secrets.after.yaml')),
    );
    const password = events.find((event) => event.path === 'database.password');
    assert.equal(password.type, 'changed');
    assert.ok(isEncryptedSentinel(password.before));
    assert.ok(isEncryptedSentinel(password.after));
    assert.notEqual(password.before, password.after);

    const line = captureStdout(() => renderDiff('secrets.yaml', [password]));
    assert.ok(line.includes('~ database.password: <encrypted value changed>'), line);
  });

  test('an encrypted value that did not change produces no event', () => {
    const events = diffTrees(
      parseFile(fixture('secrets.before.yaml')),
      parseFile(fixture('secrets.after.yaml')),
    );
    assert.equal(events.some((event) => event.path === 'database.username'), false);
  });

  test('keys added and removed around encrypted values are reported normally', () => {
    const events = diffTrees(
      parseFile(fixture('secrets.before.yaml')),
      parseFile(fixture('secrets.after.yaml')),
    );
    assert.deepEqual(
      events.filter((event) => event.type !== 'changed').map((event) => [event.type, event.path]),
      [['added', 'cache'], ['removed', 'api']],
    );
  });

  test('a recipient inserted at the front is one addition, not a wholesale rewrite', () => {
    const events = diffTrees(
      parseFile(fixture('secrets.before.yaml')),
      parseFile(fixture('secrets.recipient-added.yaml')),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'added');
    assert.equal(
      events[0].path,
      'sops.age.age1newcomernewcomernewcomernewcomernewcomernewcomer000000',
    );
    // The recipient's public key stays readable — it is the point of the event.
    assert.equal(
      events[0].after.recipient,
      'age1newcomernewcomernewcomernewcomernewcomernewcomer000000',
    );
    // The data key sealed to it does not.
    assert.ok(isEncryptedSentinel(events[0].after.enc));
  });

  test('a KMS recipient added to a JSON file is reported at a path naming the key', () => {
    const events = diffTrees(
      parseFile(fixture('secrets.before.json')),
      parseFile(fixture('secrets.after.json')),
    );
    const added = events.filter((event) => event.type === 'added');
    assert.equal(added.length, 1);
    assert.ok(added[0].path.startsWith('sops.kms.arn:aws:kms:eu-west-1:'));
  });

  test('losing encryption is reported at <encryption>', () => {
    const events = diffTrees(
      parseFile(fixture('secrets.before.yaml')),
      parseFile(fixture('secrets.plaintext.yaml')),
    );
    const state = events.find((event) => event.path === '<encryption>');
    assert.deepEqual(
      { type: state.type, before: state.before, after: state.after },
      { type: 'changed', before: 'sops', after: 'plaintext' },
    );
    for (const path of ['database.username', 'database.password', 'api.key']) {
      const event = events.find((entry) => entry.path === path);
      assert.equal(event.after, '<no longer encrypted>');
    }
  });

  test('gaining encryption is reported at <encryption> too', () => {
    const events = diffTrees(
      parseFile(fixture('secrets.plaintext.yaml')),
      parseFile(fixture('secrets.before.yaml')),
    );
    const state = events.find((event) => event.path === '<encryption>');
    assert.equal(state.before, 'plaintext');
    assert.equal(state.after, 'sops');
  });

  test('a MAC that moved on its own is reported at <encryption.mac>', () => {
    const events = diffTrees(
      parseFile(fixture('secrets.before.yaml')),
      parseFile(fixture('secrets.mac-tamper.yaml')),
    );
    const mac = events.find((event) => event.path === '<encryption.mac>');
    assert.equal(mac.after, 'mac-only');
  });

  test('a MAC that moved alongside a value change is not a tamper signal', () => {
    const events = diffTrees(
      parseFile(fixture('secrets.before.yaml')),
      parseFile(fixture('secrets.after.yaml')),
    );
    assert.equal(events.some((event) => event.path === '<encryption.mac>'), false);
  });

  test('--ignore silences the derived paths like any other', () => {
    const events = diffTrees(
      parseFile(fixture('secrets.before.yaml')),
      parseFile(fixture('secrets.mac-tamper.yaml')),
      { ignorePaths: ['<encryption.mac>', 'sops'] },
    );
    assert.deepEqual(events, []);
  });
});

describe('policy findings', () => {
  /**
   * @param {string} beforeName
   * @param {string} afterName
   * @param {string[]} policies
   */
  async function findingsFor(beforeName, afterName, policies) {
    const events = diffTrees(parseFile(fixture(beforeName)), parseFile(fixture(afterName)));
    return evaluatePolicies(events, { policies });
  }

  test('a recipient addition is an error from the sops pack', async () => {
    const findings = await findingsFor(
      'secrets.before.yaml', 'secrets.recipient-added.yaml', ['sops'],
    );
    assert.deepEqual(findings.map((finding) => finding.id), ['sops-recipient-added']);
    assert.equal(findings[0].severity, 'error');
  });

  test('a recipient removal is a warning from the sops pack', async () => {
    const findings = await findingsFor(
      'secrets.recipient-added.yaml', 'secrets.before.yaml', ['sops'],
    );
    assert.deepEqual(findings.map((finding) => finding.id), ['sops-recipient-removed']);
    assert.equal(findings[0].severity, 'warn');
  });

  test('a lone MAC change is a warning from the sops pack', async () => {
    const findings = await findingsFor('secrets.before.yaml', 'secrets.mac-tamper.yaml', ['sops']);
    assert.deepEqual(findings.map((finding) => finding.id), ['sops-mac-changed-without-value-change']);
  });

  test('losing encryption is an error from the default pack, without opting in', async () => {
    const findings = await findingsFor('secrets.before.yaml', 'secrets.plaintext.yaml', ['default']);
    const decrypted = findings.filter((finding) => finding.id === 'sops-file-decrypted');
    assert.equal(decrypted.length, 1);
    assert.equal(decrypted[0].severity, 'error');
    assert.equal(decrypted[0].path, '<encryption>');
    assert.ok(findings.some((finding) => finding.id === 'sops-value-decrypted'));
  });

  test('gaining encryption is a notice, not an error', async () => {
    const findings = await findingsFor('secrets.plaintext.yaml', 'secrets.before.yaml', ['sops']);
    const state = findings.filter((finding) => finding.path === '<encryption>');
    assert.deepEqual(state.map((finding) => [finding.id, finding.severity]), [
      ['sops-file-encrypted', 'info'],
    ]);
  });

  test('a routine re-encryption raises no sops findings', async () => {
    const findings = await findingsFor('secrets.before.yaml', 'secrets.after.yaml', ['sops']);
    assert.deepEqual(findings, []);
  });

  test('a .sops.yaml creation-rule recipient change is flagged', async () => {
    const findings = await findingsFor(
      'creation-rules.before.yaml', 'creation-rules.after.yaml', ['sops'],
    );
    assert.deepEqual(
      findings.map((finding) => [finding.id, finding.path]),
      [['sops-creation-rule-recipients-changed', 'creation_rules[0].age']],
    );
  });
});

describe('multi-document files (#109)', () => {
  /** The value `multidoc.after.yaml` commits in the clear. */
  const EXPOSED = 'not-a-real-exposed-dsn';
  const SECRET_DOC = 'Secret/prod/billing';

  /**
   * @param {string} beforeName
   * @param {string} afterName
   */
  function eventsFor(beforeName, afterName) {
    return diffTrees(parseFile(fixture(beforeName)), parseFile(fixture(afterName)));
  }

  test('a SOPS block one document down still makes the file encrypted', () => {
    const tree = parseFile(fixture('multidoc.before.yaml'));
    assert.equal(looksLikeSopsMetadata(tree.sops), false, 'nothing at the root');
    assert.ok(looksLikeSopsMetadata(tree[SECRET_DOC].sops), 'the metadata is inside a document');
    assert.equal(encryptionState(tree), 'sops');
  });

  test('a plain document beside an encrypted one does not make the file plaintext', () => {
    const tree = parseFile(fixture('multidoc.before.yaml'));
    assert.equal(looksLikeSopsMetadata(tree['ConfigMap/prod/billing-config']?.sops), false);
    assert.equal(encryptionState(tree), 'sops');
  });

  test('a decrypted value is withheld, exactly as it is in a single-document file', () => {
    const events = eventsFor('multidoc.before.yaml', 'multidoc.after.yaml');
    const dsn = events.find((event) => event.path === `${SECRET_DOC}.data.dsn`);
    assert.equal(dsn.after, '<no longer encrypted>');
    assert.equal(dsn.note, 'value is no longer encrypted');
    assert.equal(JSON.stringify(events).includes(EXPOSED), false);
  });

  test('the exposed plaintext never reaches rendered output, masked or not', () => {
    const events = eventsFor('multidoc.before.yaml', 'multidoc.after.yaml');
    for (const maskSecrets of [false, true]) {
      for (const mode of ['compact', 'verbose']) {
        const out = captureStdout(() => renderChanges('m.yaml', events, mode, { maskSecrets }));
        assert.equal(out.includes(EXPOSED), false, `renderChanges(${mode}, mask=${maskSecrets})`);
        assertNoCiphertext(out, `renderChanges(${mode}, mask=${maskSecrets})`);
      }
      const diffOut = captureStdout(() => renderDiff('m.yaml', events, { maskSecrets }));
      assert.equal(diffOut.includes(EXPOSED), false, `renderDiff(mask=${maskSecrets})`);
      assert.ok(diffOut.includes('<no longer encrypted>'));
    }
  });

  test('the exposed plaintext never reaches the CLI in any format, masked or not', () => {
    for (const mask of [[], ['--mask-secrets']]) {
      for (const format of ['human', 'json', 'ndjson', 'github-annotations']) {
        const result = runCli([
          'compare',
          fixture('multidoc.before.yaml'),
          fixture('multidoc.after.yaml'),
          '--format', format,
          '--policies', 'default,sops',
          ...mask,
        ]);
        const label = `compare --format ${format} ${mask.join(' ')}`;
        assert.equal(result.stdout.includes(EXPOSED), false, `${label} stdout`);
        assert.equal(result.stderr.includes(EXPOSED), false, `${label} stderr`);
        assertNoCiphertext(result.stdout, `${label} stdout`);
      }
    }
  });

  test('a recipient inserted at the front of a document is one addition', () => {
    const events = eventsFor('multidoc.before.yaml', 'multidoc.recipient-added.yaml');
    assert.deepEqual(events.map((event) => [event.type, event.path]), [[
      'added',
      `${SECRET_DOC}.sops.age.age1newcomernewcomernewcomernewcomernewcomernewcomer000000`,
    ]]);
    assert.ok(isEncryptedSentinel(events[0].after.enc));
  });

  test('a MAC that moved on its own inside a document is still reported', () => {
    const events = eventsFor('multidoc.before.yaml', 'multidoc.mac-tamper.yaml');
    const mac = events.find((event) => event.path === '<encryption.mac>');
    assert.equal(mac.after, 'mac-only');
  });

  test('a MAC moving alongside a value change in a document is not a tamper signal', () => {
    const events = eventsFor('multidoc.before.yaml', 'multidoc.after.yaml');
    assert.equal(events.some((event) => event.path === '<encryption.mac>'), false);
  });

  test('a file that loses its only encrypted document reports <encryption>', () => {
    const events = eventsFor('multidoc.before.yaml', 'multidoc.plaintext.yaml');
    const state = events.find((event) => event.path === '<encryption>');
    assert.deepEqual(
      { before: state.before, after: state.after },
      { before: 'sops', after: 'plaintext' },
    );
  });

  test('the sops pack fires on a document-prefixed recipient path', async () => {
    const findings = await evaluatePolicies(
      eventsFor('multidoc.before.yaml', 'multidoc.recipient-added.yaml'),
      { policies: ['sops'] },
    );
    assert.deepEqual(findings.map((finding) => finding.id), ['sops-recipient-added']);
    assert.equal(findings[0].severity, 'error');
    assert.ok(findings[0].path.startsWith(`${SECRET_DOC}.sops.age.`));
  });

  test('removing a recipient from a document is a warning', async () => {
    const findings = await evaluatePolicies(
      eventsFor('multidoc.recipient-added.yaml', 'multidoc.before.yaml'),
      { policies: ['sops'] },
    );
    assert.deepEqual(findings.map((finding) => finding.id), ['sops-recipient-removed']);
  });

  test('the default pack reports the decrypted value and the recipient addition', async () => {
    const findings = await evaluatePolicies(
      eventsFor('multidoc.before.yaml', 'multidoc.after.yaml'),
      { policies: ['default', 'sops'] },
    );
    const ids = new Set(findings.map((finding) => finding.id));
    assert.ok(ids.has('sops-value-decrypted'), [...ids].join(', '));
    assert.ok(ids.has('sops-recipient-added'), [...ids].join(', '));
    assert.ok(
      findings.every((finding) => !String(finding.message).includes(EXPOSED)),
      'a policy message repeated the exposed value',
    );
  });

  test('losing encryption in a multi-document file is a default-pack error', async () => {
    const findings = await evaluatePolicies(
      eventsFor('multidoc.before.yaml', 'multidoc.plaintext.yaml'),
      { policies: ['default'] },
    );
    const decrypted = findings.filter((finding) => finding.id === 'sops-file-decrypted');
    assert.equal(decrypted.length, 1);
    assert.equal(decrypted[0].path, '<encryption>');
  });

  test('a routine re-encryption of one document raises no sops findings', async () => {
    const findings = await evaluatePolicies(
      eventsFor('multidoc.before.yaml', 'multidoc.before.yaml'),
      { policies: ['sops'] },
    );
    assert.deepEqual(findings, []);
  });

  test('a multi-document file with no sops block gains no encryption events', () => {
    const events = diffTrees(
      parseContent('m.yaml', 'kind: A\nmetadata:\n  name: x\nreplicas: 1\n---\nkind: B\nmetadata:\n  name: y\nreplicas: 2\n'),
      parseContent('m.yaml', 'kind: A\nmetadata:\n  name: x\nreplicas: 3\n---\nkind: B\nmetadata:\n  name: y\nreplicas: 2\n'),
    );
    assert.deepEqual(events, [
      { type: 'changed', path: 'A/x.replicas', before: 1, after: 3 },
    ]);
  });
});

describe('ordinary files are untouched', () => {
  test('an unencrypted tree comes back from the encryption pass as the same object', () => {
    for (const name of ['plain.before.yaml', 'plain.after.yaml', 'lookalike.yaml']) {
      const parsed = yaml.load(readFileSync(fixture(name), 'utf8'));
      // Reference identity, not deep equality: nothing was copied, mapped, or
      // re-keyed on the way through, so there is no behavior left to change.
      assert.equal(normalizeEncrypted(parsed), parsed, name);
    }
  });

  test('parseFile on an ordinary YAML file matches a plain yaml.load', () => {
    for (const name of ['plain.before.yaml', 'plain.after.yaml', 'lookalike.yaml']) {
      assert.deepEqual(
        parseFile(fixture(name)),
        yaml.load(readFileSync(fixture(name), 'utf8')),
        name,
      );
    }
  });

  test('diffing two ordinary files produces exactly the pre-existing events', () => {
    const events = diffTrees(
      parseFile(fixture('plain.before.yaml')),
      parseFile(fixture('plain.after.yaml')),
    );
    assert.deepEqual(events, [
      { type: 'changed', path: 'replicas', before: 3, after: 4 },
      { type: 'added', path: 'database.timeout_ms', after: 500 },
      { type: 'removed', path: 'features[1]', before: 'refunds' },
    ]);
    // No derived encryption paths sneak into an ordinary diff.
    assert.equal(events.some((event) => event.path.startsWith('<encryption')), false);
  });

  test('a lookalike sops key does not gain encryption events on either side', () => {
    const before = parseFile(fixture('lookalike.yaml'));
    const after = { ...before, sops: { ...before.sops, version: '3.10.0' } };
    assert.deepEqual(diffTrees(before, after), [
      { type: 'changed', path: 'sops.version', before: '3.9.0', after: '3.10.0' },
    ]);
  });

  test('ordinary policy evaluation is unchanged by the new default-pack rules', async () => {
    const findings = await evaluatePolicies([
      { type: 'changed', path: 'database.pool_size', before: 10, after: 40 },
      { type: 'changed', path: 'service.debug', before: 'false', after: 'true' },
    ], { policies: ['default'] });
    assert.deepEqual(findings.map((finding) => finding.id).sort(), [
      'dangerous-toggle-enabled',
      'pool-size-jump',
    ]);
  });
});

describe('real age output, captured from the age CLI (#122)', () => {
  // These fixtures were produced by the real `age` binary
  // (age -r <recipient> -a), not hand-written to the documented armor format.
  // They lock in that Flecto's detection matches what the tool actually emits.
  const dir = join(dirname(FIXTURES), 'encrypted-real');
  const v1 = join(dir, 'real-age-v1.age');
  const v2 = join(dir, 'real-age-v2.age');

  test('a real age-armored file is recognized and reduced to a sentinel', () => {
    const tree = parseFile(v1);
    assert.equal(typeof tree, 'string');
    assert.match(tree, /^<encrypted:age:[0-9a-f]+>$/);
    assert.equal(encryptionState(tree), 'age');
  });

  test('diffing two real age files never leaks the armored ciphertext', () => {
    const events = diffTrees(parseFile(v1), parseFile(v2));
    const serialized = JSON.stringify(events);
    // No armor header, no base64 body — only the opaque sentinels.
    assert.doesNotMatch(serialized, /BEGIN AGE|-----|age-encryption\.org/);
    assert.doesNotMatch(serialized.replace(/encrypted:age:[0-9a-f]+/g, ''), /[A-Za-z0-9+/]{40}/);
    // The change is still reported — a rotated secret must not read as "no change".
    assert.ok(events.some((e) => e.type === 'changed'));
  });
});
