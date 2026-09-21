import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

import { parseContent } from '../src/parser.js';
import { buildPositionIndex, locatePath, offsetToPosition, toLspRange } from '../src/positions.js';

/** Build an index the way the language server does: from the parser's own tree. */
function index(file, text) {
  return buildPositionIndex(file, text, parseContent(file, text));
}

/** What a lookup underlines, and how sure it is. */
function at(file, text, path, options) {
  const idx = index(file, text);
  const location = locatePath(idx, path, options);
  return { text: text.slice(location.start, location.end), precision: location.precision, location, idx };
}

describe('YAML', () => {
  const doc = [
    'db:',
    '  pool_size: 5 # a comment',
    '  hosts: [a, {x: 1}]',
    'containers:',
    '  - name: web',
    '    image: web:1',
    '  - name: api',
    '    image: api:1',
    'base: &b',
    '  k: 1',
    'use:',
    '  <<: *b',
    '  z: 2',
    'alias: *b',
    'empty:',
    'block: |',
    '  line one',
    '  line two',
    '"quoted.key": 3',
    '',
  ].join('\n');

  test('block and flow entries resolve to the key and a same-line scalar', () => {
    const pool = at('a.yaml', doc, 'db.pool_size');
    assert.equal(pool.text, 'pool_size: 5');
    assert.equal(pool.precision, 'exact');
    assert.equal(at('a.yaml', doc, 'db.hosts[1].x').text, 'x: 1');
    assert.equal(at('a.yaml', doc, 'db.hosts[0]').text, 'a');
    assert.equal(at('a.yaml', doc, 'quoted.key').text, '"quoted.key": 3');
  });

  test('sequence elements resolve by index and by identity', () => {
    assert.equal(at('a.yaml', doc, 'containers[1].image').text, 'image: api:1');
    assert.equal(at('a.yaml', doc, 'containers["api"].image').text, 'image: api:1');
    assert.equal(at('a.yaml', doc, 'containers["api"]').text, 'name: api');
    const missing = at('a.yaml', doc, 'containers["db"].image');
    assert.equal(missing.precision, 'ancestor', 'an element that is not there anchors at its list');
    assert.equal(missing.text, 'containers');
  });

  test('a merged-in key anchors at the merge, an alias at its own key', () => {
    const merged = at('a.yaml', doc, 'use.k');
    assert.equal(merged.precision, 'merge');
    assert.equal(merged.text, '<<: *b');
    assert.equal(at('a.yaml', doc, 'use.z').precision, 'exact');
    const aliased = at('a.yaml', doc, 'alias.k');
    assert.equal(aliased.precision, 'ancestor', 'the value lives at the anchor, which is a different path');
    assert.equal(aliased.text, 'alias: *b');
  });

  test('an empty value stays on its own line; a block scalar anchors at its key', () => {
    const empty = at('a.yaml', doc, 'empty');
    assert.equal(empty.text, 'empty:');
    assert.equal(empty.location.start, doc.indexOf('empty:'));
    assert.equal(at('a.yaml', doc, 'block').text, 'block');
  });

  test('a removed path anchors at the nearest ancestor still in the text', () => {
    const removed = at('a.yaml', doc, 'db.max_overflow');
    assert.equal(removed.precision, 'ancestor');
    assert.equal(removed.text, 'db');
    assert.equal(at('a.yaml', doc, 'gone.entirely').precision, 'file');
  });

  test('an order-insensitive element ([*]) anchors at its list', () => {
    const star = at('a.yaml', doc, 'containers[*]');
    assert.equal(star.precision, 'ancestor');
    assert.equal(star.text, 'containers');
  });

  test('a path that reads two ways resolves to neither', () => {
    const ambiguous = 'q.k: 1\nq:\n  k: 2\n';
    assert.equal(at('a.yaml', ambiguous, 'q.k').precision, 'file');
  });

  test('identity is only claimed when every candidate key agrees', () => {
    // Element 0 has id "web"; element 1 has name "web". The differ picks id or
    // name from both sides of the diff, which one index cannot know.
    const text = 'list:\n  - id: web\n    name: a\n  - id: b\n    name: web\n';
    const split = at('a.yaml', text, 'list["web"].name');
    assert.equal(split.precision, 'ancestor');
    assert.equal(split.text, 'list');
    // With the run's configured key, there is only one reading.
    assert.equal(at('a.yaml', text, 'list["web"].name', { arrayIdKey: 'name' }).text, 'name: web');
  });

  test('multi-document files are addressed by the same identities the differ uses', () => {
    const manifests = [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: web',
      '  namespace: prod',
      'spec:',
      '  replicas: 3',
      '---',
      'apiVersion: v1',
      'kind: Service',
      'metadata:',
      '  name: web',
      '',
    ].join('\n');
    assert.equal(at('k.yaml', manifests, 'Deployment/prod/web.spec.replicas').text, 'replicas: 3');
    assert.equal(at('k.yaml', manifests, 'Service/web.kind').text, 'kind: Service');
    // A single manifest is keyed by identity too (#124).
    assert.equal(at('k.yaml', manifests.split('---')[0], 'Deployment/prod/web.spec.replicas').text, 'replicas: 3');
  });

  test('CRLF line endings and a byte-order mark keep offsets true', () => {
    const crlf = '\uFEFFa:\r\n  b: 1\r\n  c: two\r\n';
    const found = at('a.yaml', crlf, 'a.c');
    assert.equal(found.text, 'c: two');
    assert.deepEqual(toLspRange(found.idx, found.location), { start: { line: 2, character: 2 }, end: { line: 2, character: 8 } });
  });

  test('structure the scanner cannot vouch for is never claimed', () => {
    // SOPS metadata is re-keyed by the encryption pass, so the text and the
    // parsed tree disagree there — and the lookup stops at the nearest key
    // that still agrees.
    const sops = readFileSync(resolve('test/fixtures/sops/secrets.after.yaml'), 'utf8');
    const idx = index('secrets.yaml', sops);
    const parsed = parseContent('secrets.yaml', sops);
    const [recipient] = Object.keys(parsed.sops.age ?? {});
    if (recipient) {
      const location = locatePath(idx, `sops.age.${recipient}.recipient`);
      assert.notEqual(location.precision, 'exact');
    }
  });
});

describe('JSON, dotenv, INI, TOML', () => {
  test('JSONC: comments and trailing commas keep offsets; the last duplicate wins', () => {
    const text = '{\n  // pool\n  "db": { "pool": 5, "hosts": ["a", "b"], },\n  "x.y": 1,\n  "x.y": 2,\n}\n';
    assert.equal(at('a.jsonc', text, 'db.pool').text, '"pool": 5');
    assert.equal(at('a.json', text, 'db.hosts[1]').text, '"b"');
    assert.equal(at('a.json', text, 'x.y').text, '"x.y": 2');
  });

  test('dotenv: the parser\'s own line pattern, CRLF, export, and the last duplicate', () => {
    const text = 'A=1\r\nexport B="two words" # c\r\nA=3\r\nEMPTY=\r\n';
    assert.equal(at('.env', text, 'A').text, 'A=3');
    assert.equal(at('.env', text, 'B').text, 'B="two words"');
    assert.equal(at('.env', text, 'EMPTY').text, 'EMPTY');
    const found = at('.env', text, 'A');
    assert.deepEqual(offsetToPosition(found.idx, found.location.start), { line: 2, character: 0 });
  });

  test('INI: sections accumulate across repeats; root keys stay at the root', () => {
    const text = 'root = 1\n[db]\npool = 5\n; comment\n[db]\n  host=h\n';
    assert.equal(at('a.ini', text, 'root').text, 'root = 1');
    assert.equal(at('a.ini', text, 'db.pool').text, 'pool = 5');
    assert.equal(at('a.ini', text, 'db.host').text, 'host=h');
  });

  test('TOML: tables, arrays of tables, dotted and quoted keys, inline tables, strings', () => {
    const text = [
      'title = "t" # comment',
      '[db]',
      'pool = 5',
      'hosts = [',
      '  "a", # comment',
      '  "b",',
      ']',
      '"q.k" = 1',
      '[[servers]]',
      'name = "x"',
      '[[servers]]',
      'name = "y # not a comment"',
      '[servers.tls]',
      'on = true',
      '[owner]',
      'dob = 1979-05-27 07:32:00Z',
      'inline = { a = 1, b.c = 2 }',
      'notes = """',
      '[not.a.table]',
      '"""',
      '',
    ].join('\n');
    assert.equal(at('a.toml', text, 'title').text, 'title = "t"');
    assert.equal(at('a.toml', text, 'db.hosts[1]').text, '"b"');
    assert.equal(at('a.toml', text, 'db.q.k').text, '"q.k" = 1');
    assert.equal(at('a.toml', text, 'servers[1].name').text, 'name = "y # not a comment"');
    assert.equal(at('a.toml', text, 'servers[1].tls.on').text, 'on = true');
    assert.equal(at('a.toml', text, 'owner.dob').text, 'dob = 1979-05-27 07:32:00Z');
    assert.equal(at('a.toml', text, 'owner.inline.b.c').text, 'c = 2');
    assert.equal(at('a.toml', text, 'owner.notes').text, 'notes');
  });

  test('positions are UTF-16 code units, the LSP default', () => {
    const text = 'emoji: "😀😀"\nnext: 1\n';
    const found = at('a.yaml', text, 'emoji');
    assert.deepEqual(toLspRange(found.idx, found.location).end, { line: 0, character: 13 });
  });

  test('a format with no structure has no positions, only the file', () => {
    const armored = '-----BEGIN AGE ENCRYPTED FILE-----\nabc\n-----END AGE ENCRYPTED FILE-----\n';
    assert.equal(at('secret.age', armored, 'anything').precision, 'file');
  });
});

describe('never anchored wrong', () => {
  /** Every file under a directory with a format the parser supports. */
  function configFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...configFiles(full));
      else if (/\.(ya?ml|json|toml|ini|env)$/u.test(name)) out.push(full);
    }
    return out;
  }

  /** Every [path, key] the differ could report for a parsed tree. */
  function* pathsOf(value, prefix = '') {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) yield* pathsOf(value[i], `${prefix}[${i}]`);
    } else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        const path = prefix ? `${prefix}.${key}` : key;
        yield [path, key];
        yield* pathsOf(value[key], path);
      }
    }
  }

  test('every exact location over the repository\'s fixtures and examples sits on its own key', () => {
    let exact = 0;
    for (const file of [...configFiles(resolve('test/fixtures')), ...configFiles(resolve('examples'))]) {
      const text = readFileSync(file, 'utf8');
      let parsed;
      try {
        parsed = parseContent(file, text);
      } catch {
        continue;
      }
      const idx = buildPositionIndex(file, text, parsed);
      for (const [path, key] of pathsOf(parsed)) {
        const location = locatePath(idx, path);
        if (location.precision !== 'exact') continue;
        exact += 1;
        const shown = text.slice(location.start, location.end);
        // A synthetic multi-document key is named by the document's first
        // line; every other key is written where it is found.
        const documentKey = /^[A-Z][A-Za-z]*\//u.test(key) || /^\d+$/u.test(key);
        assert.ok(
          documentKey || [key, JSON.stringify(key), `'${key}'`].some((form) => shown.startsWith(form)),
          `${file}: ${path} anchored at ${JSON.stringify(shown)}`,
        );
      }
    }
    assert.ok(exact > 1000, `expected broad coverage, got ${exact} exact locations`);
  });
});
