import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { parseContent, parseYamlStream, parseJsonc, stripJsonComments, isSupported, CIRCULAR_SENTINEL } from '../src/parser.js';
import { diffTrees } from '../src/differ.js';
import { documentKeysOf, stripDocumentPrefix, withDocumentKeys } from '../src/documents.js';

const DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 2
`;

const SERVICE = `apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  port: 80
`;

describe('single-document YAML is unchanged', () => {
  test('plain document parses to the document itself', () => {
    const parsed = parseContent('config.yaml', 'port: 3000\ndatabase:\n  pool_size: 5\n');
    assert.deepEqual(parsed, { port: 3000, database: { pool_size: 5 } });
  });

  test('leading --- does not create a multi-document object', () => {
    const parsed = parseContent('config.yaml', '---\nport: 3000\n');
    assert.deepEqual(parsed, { port: 3000 });
  });

  test('trailing --- does not create a phantom document', () => {
    const parsed = parseContent('config.yaml', 'port: 3000\n---\n');
    assert.deepEqual(parsed, { port: 3000 });
  });

  test('leading and trailing --- around one document', () => {
    const parsed = parseContent('config.yaml', '---\nport: 3000\n---\n');
    assert.deepEqual(parsed, { port: 3000 });
  });

  test('single document keeps its diff paths', () => {
    const before = parseContent('config.yaml', 'database:\n  pool_size: 5\n');
    const after = parseContent('config.yaml', '---\ndatabase:\n  pool_size: 20\n');
    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assert.equal(events[0].path, 'database.pool_size');
  });

  test('empty file parses to an empty object', () => {
    assert.deepEqual(parseContent('config.yaml', ''), {});
  });

  test('file of separators only parses to an empty object', () => {
    assert.deepEqual(parseContent('config.yaml', '---\n---\n'), {});
  });

  test('a single null document parses to an empty object', () => {
    assert.deepEqual(parseContent('config.yaml', '---\nnull\n'), {});
  });

  test('scalar root document is preserved', () => {
    assert.equal(parseContent('config.yaml', '42\n'), 42);
  });

  test('array root document is preserved', () => {
    assert.deepEqual(parseContent('config.yaml', '- a\n- b\n'), ['a', 'b']);
  });
});

describe('parser scalar normalization', () => {
  test('YAML timestamps become stable JSON strings', () => {
    const parsed = parseContent(
      'config.yaml',
      'released_at: 2026-08-06T12:34:56Z\nrelease_date: 2026-08-06\n',
    );
    assert.deepEqual(parsed, {
      released_at: '2026-08-06T12:34:56.000Z',
      release_date: '2026-08-06T00:00:00.000Z',
    });

    const roundTripped = JSON.parse(JSON.stringify(parsed));
    assert.deepEqual(diffTrees(parsed, roundTripped), []);
  });

  test('TOML dates, times, large integers, and non-finite numbers are JSON-safe', () => {
    const parsed = parseContent('config.toml', `date = 2026-08-06
time = 12:34:56.789
datetime = 2026-08-06T12:34:56Z
large = 9223372036854775807
not_number = nan
positive_infinity = +inf
negative_infinity = -inf
`);

    assert.deepEqual(parsed, {
      date: '2026-08-06',
      time: '12:34:56.789',
      datetime: '2026-08-06T12:34:56.000Z',
      large: '9223372036854775807',
      not_number: 'NaN',
      positive_infinity: 'Infinity',
      negative_infinity: '-Infinity',
    });
    assert.doesNotThrow(() => JSON.stringify(parsed));
    assert.deepEqual(diffTrees(parsed, JSON.parse(JSON.stringify(parsed))), []);
  });
});

describe('cyclic YAML anchors (#103)', () => {
  // `a: &x\n  b: *x` is not a typo-shaped edge case: js-yaml resolves the
  // alias to the *same object* as the anchor, so the parsed tree is genuinely
  // cyclic (`parsed.a.b === parsed.a`). Before this fix that crashed scalar
  // normalization with "Maximum call stack size exceeded"; before #102 it
  // crashed later, at snapshot write, with "Converting circular structure to
  // JSON". Neither the anchor's own name nor the alias survives js-yaml's
  // parse, so the only thing normalization can do at the back-reference is
  // substitute a fixed sentinel.

  test('a self-referential anchor parses instead of crashing', () => {
    const parsed = parseContent('cyclic.yaml', 'a: &x\n  b: *x\n');
    assert.deepEqual(parsed, { a: { b: CIRCULAR_SENTINEL } });
  });

  test('the normalized tree survives JSON.stringify, the snapshot write path', () => {
    const parsed = parseContent('cyclic.yaml', 'a: &x\n  b: *x\n');
    assert.doesNotThrow(() => JSON.stringify(parsed));
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed);
  });

  test('a cycle nested below the top level is still caught', () => {
    const parsed = parseContent('nested-cyclic.yaml', 'a:\n  b:\n    c: &x\n      d: *x\n');
    assert.deepEqual(parsed, { a: { b: { c: { d: CIRCULAR_SENTINEL } } } });
  });

  test('an array containing itself terminates instead of recursing forever', () => {
    const parsed = parseContent('self-array.yaml', 'a: &x\n  - 1\n  - *x\n');
    assert.deepEqual(parsed, { a: [1, CIRCULAR_SENTINEL] });
  });

  test('an anchor reused on two branches (not a true cycle) is expanded on both', () => {
    // Ancestor tracking must stop a value from containing itself, not stop a
    // value that is merely referenced twice from unrelated branches.
    const parsed = parseContent('shared.yaml', 'shared: &s\n  x: 1\na: *s\nb: *s\n');
    assert.deepEqual(parsed, { shared: { x: 1 }, a: { x: 1 }, b: { x: 1 } });
  });

  test('two files with the same cycle shape normalize equal and diff clean', () => {
    const before = parseContent('cyclic-a.yaml', 'a: &x\n  b: *x\n');
    const after = parseContent('cyclic-b.yaml', 'a: &x\n  b: *x\n');
    assert.deepEqual(before, after);
    assert.deepEqual(diffTrees(before, after), []);
  });

  test('a diff across two cyclic files reports the real change', () => {
    const before = parseContent('cyclic-a.yaml', 'a: &x\n  b: *x\n');
    const after = parseContent('cyclic-b.yaml', 'a: &x\n  b: *x\n  c: 2\n');
    const events = diffTrees(before, after);
    assert.deepEqual(events, [{ type: 'added', path: 'a.c', after: 2 }]);
  });

  test('merge keys resolve to a normal acyclic tree, unaffected by the cycle guard', () => {
    const parsed = parseContent(
      'merge.yaml',
      'base: &base\n  x: 1\n  y: 2\nchild:\n  <<: *base\n  y: 3\n',
    );
    assert.deepEqual(parsed, { base: { x: 1, y: 2 }, child: { x: 1, y: 3 } });
  });

  test('an ordinary file normalizes byte-identically to before', () => {
    const raw = 'port: 3000\ndatabase:\n  pool_size: 5\n  hosts:\n    - a\n    - b\n';
    const parsed = parseContent('config.yaml', raw);
    assert.deepEqual(parsed, { port: 3000, database: { pool_size: 5, hosts: ['a', 'b'] } });
  });
});

describe('multi-document YAML', () => {
  test('documents without identity are keyed by index', () => {
    const parsed = parseYamlStream('a: 1\n---\nb: 2\n');
    assert.deepEqual(parsed, { 0: { a: 1 }, 1: { b: 2 } });
  });

  test('kubernetes documents are keyed by kind/name', () => {
    const parsed = parseContent('manifest.yaml', `${DEPLOYMENT}---\n${SERVICE}`);
    assert.deepEqual(Object.keys(parsed), ['Deployment/api', 'Service/api']);
    assert.equal(parsed['Deployment/api'].spec.replicas, 2);
  });

  test('namespaced documents include the namespace', () => {
    const parsed = parseYamlStream(`kind: Deployment
metadata:
  name: api
  namespace: prod
---
kind: Deployment
metadata:
  name: api
  namespace: staging
`);
    assert.deepEqual(Object.keys(parsed), ['Deployment/prod/api', 'Deployment/staging/api']);
  });

  test('top-level id then name is used when there is no kind', () => {
    assert.deepEqual(
      Object.keys(parseYamlStream('id: alpha\nport: 1\n---\nid: beta\nport: 2\n')),
      ['alpha', 'beta']
    );
    assert.deepEqual(
      Object.keys(parseYamlStream('name: alpha\nport: 1\n---\nname: beta\nport: 2\n')),
      ['alpha', 'beta']
    );
  });

  test('duplicate identities fall back to index keys for the whole file', () => {
    const parsed = parseContent('manifest.yaml', `${DEPLOYMENT}---\n${DEPLOYMENT}`);
    assert.deepEqual(Object.keys(parsed), ['0', '1']);
  });

  test('a document missing identity forces index keys for the whole file', () => {
    const parsed = parseContent('manifest.yaml', `${DEPLOYMENT}---\nloose: true\n`);
    assert.deepEqual(Object.keys(parsed), ['0', '1']);
  });

  test('non-object documents are kept and keyed by index', () => {
    assert.deepEqual(parseYamlStream('--- 1\n--- 2\n'), { 0: 1, 1: 2 });
    assert.deepEqual(parseYamlStream('- a\n---\n- b\n'), { 0: ['a'], 1: ['b'] });
  });

  test('empty documents are dropped and do not shift keys', () => {
    assert.deepEqual(parseYamlStream('a: 1\n---\n---\nb: 2\n'), { 0: { a: 1 }, 1: { b: 2 } });
    assert.deepEqual(parseYamlStream('---\na: 1\n---\nb: 2\n---\n'), { 0: { a: 1 }, 1: { b: 2 } });
  });

  test('a document explicitly set to null is dropped', () => {
    assert.deepEqual(parseYamlStream('a: 1\n---\nnull\n---\nb: 2\n'), { 0: { a: 1 }, 1: { b: 2 } });
  });

  test('false and 0 documents are not mistaken for empty', () => {
    assert.deepEqual(parseYamlStream('--- false\n--- 0\n--- a: 1\n'), { 0: false, 1: 0, 2: { a: 1 } });
  });

  test('a __proto__ identity does not swallow the document', () => {
    const parsed = parseYamlStream('name: __proto__\nx: 1\n---\nname: b\ny: 2\n');
    assert.deepEqual(parsed, { 0: { name: '__proto__', x: 1 }, 1: { name: 'b', y: 2 } });
  });

  test('.yml is handled like .yaml', () => {
    assert.deepEqual(Object.keys(parseContent('manifest.yml', `${DEPLOYMENT}---\n${SERVICE}`)), [
      'Deployment/api',
      'Service/api',
    ]);
  });

  test('a syntax error still reports the file name', () => {
    assert.throws(
      () => parseContent('manifest.yaml', 'a: 1\n---\n\tb: 2\n'),
      /Parse error in "manifest.yaml"/
    );
  });
});

describe('multi-document YAML diffs', () => {
  test('a change inside one document reads on a stable path', () => {
    const before = parseContent('manifest.yaml', `${DEPLOYMENT}---\n${SERVICE}`);
    const after = parseContent(
      'manifest.yaml',
      `${DEPLOYMENT.replace('replicas: 2', 'replicas: 5')}---\n${SERVICE}`
    );
    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assert.equal(events[0].path, 'Deployment/api.spec.replicas');
    assert.equal(events[0].before, 2);
    assert.equal(events[0].after, 5);
  });

  test('inserting a document at the top does not shift other paths', () => {
    const configMap = 'kind: ConfigMap\nmetadata:\n  name: api\ndata:\n  level: info\n';
    const before = parseContent('manifest.yaml', `${DEPLOYMENT}---\n${SERVICE}`);
    const after = parseContent('manifest.yaml', `${configMap}---\n${DEPLOYMENT}---\n${SERVICE}`);
    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'added');
    assert.equal(events[0].path, 'ConfigMap/api');
  });

  test('removing a document reads as one removal', () => {
    const configMap = 'kind: ConfigMap\nmetadata:\n  name: api\ndata:\n  level: info\n';
    const before = parseContent('manifest.yaml', `${DEPLOYMENT}---\n${SERVICE}---\n${configMap}`);
    const after = parseContent('manifest.yaml', `${DEPLOYMENT}---\n${configMap}`);
    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'removed');
    assert.equal(events[0].path, 'Service/api');
  });

  test('dropping to a single manifest reads as one removal (#124)', () => {
    // A lone Kubernetes manifest is now keyed by identity too, so going from two
    // documents to one is exactly the removal it looks like — the surviving
    // Deployment keeps its path instead of being re-pathed from scratch.
    const before = parseContent('manifest.yaml', `${DEPLOYMENT}---\n${SERVICE}`);
    const after = parseContent('manifest.yaml', DEPLOYMENT);
    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'removed');
    assert.equal(events[0].path, 'Service/api');
  });

  test('adding a second manifest reads as one addition (#124)', () => {
    // The bug this fixes: a lone manifest used to be unwrapped, so adding a
    // document beside it re-pathed every key and reported the untouched original
    // as removed-and-re-added.
    const before = parseContent('manifest.yaml', DEPLOYMENT);
    const after = parseContent('manifest.yaml', `${DEPLOYMENT}---\n${SERVICE}`);
    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'added');
    assert.equal(events[0].path, 'Service/api');
  });

  test('a lone manifest is keyed by identity, ordinary single-doc YAML is not (#124)', () => {
    assert.deepEqual([...documentKeysOf(parseContent('d.yaml', DEPLOYMENT))], ['Deployment/api']);
    // No apiVersion → not a manifest → untouched, bare, no document keys.
    assert.deepEqual([...documentKeysOf(parseContent('c.yaml', 'kind: Widget\nname: x\nport: 3000\n'))], []);
    assert.deepEqual([...documentKeysOf(parseContent('c.yaml', 'port: 3000\n'))], []);
  });

  test('a change inside a lone manifest reads on the same path as in a stream (#124)', () => {
    const before = parseContent('d.yaml', DEPLOYMENT);
    const after = parseContent('d.yaml', DEPLOYMENT.replace('replicas: 2', 'replicas: 5'));
    const events = diffTrees(before, after);
    assert.equal(events.length, 1);
    assert.equal(events[0].path, 'Deployment/api.spec.replicas');
  });

  test('index-keyed documents shift when one is inserted at the top', () => {
    const before = parseYamlStream('a: 1\n---\nb: 2\n');
    const after = parseYamlStream('c: 3\n---\na: 1\n---\nb: 2\n');
    const events = diffTrees(before, after);
    assert.ok(events.length > 1, 'index keys cannot survive an insertion');
  });

  test('ignore patterns apply inside a document', () => {
    const before = parseContent('manifest.yaml', `${DEPLOYMENT}---\n${SERVICE}`);
    const after = parseContent(
      'manifest.yaml',
      `${DEPLOYMENT.replace('replicas: 2', 'replicas: 5')}---\n${SERVICE}`
    );
    const events = diffTrees(before, after, { ignorePaths: ['Deployment/api'] });
    assert.equal(events.length, 0);
  });
});

describe('the parser records which keys it invented', () => {
  test('a multi-document wrapper carries its document keys', () => {
    const parsed = parseContent('manifest.yaml', `${DEPLOYMENT}---\n${SERVICE}`);
    assert.deepEqual([...documentKeysOf(parsed)], ['Deployment/api', 'Service/api']);
  });

  test('a single document records that it is not a wrapper', () => {
    assert.deepEqual([...documentKeysOf(parseContent('config.yaml', 'port: 3000\n'))], []);
    assert.deepEqual([...documentKeysOf(parseContent('config.json', '{"port":3000}'))], []);
  });

  test('an unmarked tree — one read back out of a snapshot — reports unknown', () => {
    assert.equal(documentKeysOf(JSON.parse('{"a":1}')), null);
    assert.equal(documentKeysOf('scalar'), null);
    assert.equal(documentKeysOf(null), null);
  });

  test('the record is invisible to everything that serializes or compares a tree', () => {
    const raw = `${DEPLOYMENT}---\n${SERVICE}`;
    const parsed = parseContent('manifest.yaml', raw);
    assert.deepEqual(Object.keys(parsed), ['Deployment/api', 'Service/api']);
    assert.equal(
      JSON.stringify(parsed),
      JSON.stringify(JSON.parse(JSON.stringify(parsed))),
    );
    // deepEqual compares own *enumerable* properties, so a marked tree still
    // equals the plain object a snapshot round trip produces.
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(parsed)));
  });

  test('index-keyed documents are recorded too', () => {
    assert.deepEqual([...documentKeysOf(parseYamlStream('a: 1\n---\nb: 2\n'))], ['0', '1']);
  });

  test('stripDocumentPrefix removes only a whole leading document key', () => {
    const keys = ['Deployment/prod/token-service'];
    assert.equal(
      stripDocumentPrefix('Deployment/prod/token-service.spec.replicas', keys),
      'spec.replicas',
    );
    assert.equal(stripDocumentPrefix('Deployment/prod/token-service', keys), '');
    assert.equal(stripDocumentPrefix('Deployment/prod/token-service[0]', keys), '[0]');
    // A key that merely starts with the same text is a different key.
    assert.equal(
      stripDocumentPrefix('Deployment/prod/token-service-2.spec', keys),
      'Deployment/prod/token-service-2.spec',
    );
    assert.equal(stripDocumentPrefix('spec.replicas', keys), 'spec.replicas');
    assert.equal(stripDocumentPrefix('spec.replicas', null), 'spec.replicas');
    assert.equal(stripDocumentPrefix('spec.replicas', []), 'spec.replicas');
  });

  test('withDocumentKeys leaves non-objects alone and returns the same object', () => {
    assert.equal(withDocumentKeys(42, ['a']), 42);
    assert.equal(withDocumentKeys(null, ['a']), null);
    const tree = { a: 1 };
    assert.equal(withDocumentKeys(tree, ['a']), tree);
  });
});

test('ci reports a change inside a multi-document manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-multidoc-'));
  const file = join(dir, 'manifest.yaml');
  const snapshot = join(dir, 'snapshot.json');
  const rootIndex = resolve(process.cwd(), 'index.js');

  try {
    writeFileSync(file, `${DEPLOYMENT}---\n${SERVICE}`, 'utf8');
    writeFileSync(
      snapshot,
      JSON.stringify({ state: parseYamlStream(`${DEPLOYMENT.replace('replicas: 2', 'replicas: 1')}---\n${SERVICE}`) }),
      'utf8'
    );

    const run = spawnSync(
      process.execPath,
      [rootIndex, 'ci', file, '--snapshot-ref', snapshot, '--format', 'json'],
      { encoding: 'utf8' }
    );

    // Default --fail-on includes "changed", so a change exits non-zero.
    assert.equal(run.status, 1);
    const changes = JSON.parse(run.stdout)[0].envelope.changes;
    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, 'Deployment/api.spec.replicas');
    assert.equal(changes[0].after, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('JSON with comments (JSONC)', () => {
  test('line and block comments parse, as tsconfig.json is written', () => {
    const raw = `{
  // the house style for this file
  "compilerOptions": {
    "target": "ES2022" /* inline block */
  },
  "include": ["src"],
}`;
    assert.deepEqual(parseContent('tsconfig.json', raw), {
      compilerOptions: { target: 'ES2022' },
      include: ['src'],
    });
  });

  test('a .jsonc extension is supported and parses the same way', () => {
    assert.equal(isSupported('settings.jsonc'), true);
    assert.deepEqual(parseContent('settings.jsonc', '{ // c\n "a": 1 }'), { a: 1 });
  });

  // The naive strip is wrong on exactly the values config files carry.
  describe('strings are opaque', () => {
    test('a URL is not mistaken for a line comment', () => {
      assert.deepEqual(parseJsonc('{"url": "https://example.com"}'), {
        url: 'https://example.com',
      });
    });

    test('block comment markers inside a string survive', () => {
      assert.deepEqual(parseJsonc('{"a": "/* not a comment */", "b": "*/"}'), {
        a: '/* not a comment */',
        b: '*/',
      });
    });

    test('an escaped quote does not end the string early', () => {
      assert.deepEqual(parseJsonc(String.raw`{"a": "he said \"//hi\" ok"}`), {
        a: 'he said "//hi" ok',
      });
    });

    test('a string ending in an escaped backslash ends there', () => {
      assert.deepEqual(parseJsonc(String.raw`{"a": "c:\\", "b": "//x"}`), {
        a: 'c:\\',
        b: '//x',
      });
    });

    test('commas and braces inside strings are not structure', () => {
      assert.deepEqual(parseJsonc('[",", "]"]'), [',', ']']);
      assert.deepEqual(parseJsonc('{"a": "}" ,}'), { a: '}' });
    });

    test('an unbalanced quote inside a comment is ignored', () => {
      assert.deepEqual(parseJsonc('{ // it\'s "unclosed\n "a": 1 }'), { a: 1 });
    });
  });

  describe('trailing commas', () => {
    test('accepted in objects and arrays, including nested', () => {
      assert.deepEqual(parseJsonc('{"a": [1,], "b": {"c": 2,},}'), {
        a: [1],
        b: { c: 2 },
      });
    });

    test('accepted when a comment sits between the comma and the brace', () => {
      assert.deepEqual(parseJsonc('{"a": 1, /* x */ }'), { a: 1 });
    });

    test('a doubled trailing comma is still a syntax error', () => {
      assert.throws(() => parseJsonc('[1,,]'), SyntaxError);
    });
  });

  describe('error positions stay true to the original file', () => {
    test('a comment reports exactly where the same span of whitespace would', () => {
      // The strongest statement of the contract, and the one that does not
      // depend on the runtime: a comment must be indistinguishable from the
      // whitespace it is replaced by. A three-line block comment sits above the
      // fault, so deleting the span rather than blanking it would move the
      // reported position.
      //
      // Asserted against a control rather than a literal message because V8
      // only began appending "(line N column M)" to JSON.parse errors in Node
      // 21; the byte offset it reports is there on every supported version.
      const comment = '/* a\n     multi-line\n     banner */';
      // Built independently of the implementation, so the two are provably the
      // same span rather than the same span by hand-counting.
      const blank = comment.replaceAll(/[^\n]/g, ' ');
      const tail = '\n  "a": 1\n  "b": 2\n}';
      const commented = `{\n  ${comment}${tail}`;
      const blanked = `{\n  ${blank}${tail}`;
      assert.equal(commented.length, blanked.length, 'the control must line up byte for byte');

      const messageOf = (raw) => {
        try {
          parseContent('broken.json', raw);
        } catch (err) {
          return err.message;
        }
        return assert.fail('expected a parse error');
      };

      assert.equal(messageOf(commented), messageOf(blanked));
      assert.match(messageOf(commented), new RegExp(`position ${commented.indexOf('"b"')}\\b`));
    });

    test('the reported line is the line of the fault, where the runtime reports lines', () => {
      const raw = '{\n  /* a\n     multi-line\n     banner */\n  "a": 1\n  "b": 2\n}';
      // The fault is on line 6; the block comment above it spans lines 2-4.
      // Node 21+ appends "(line N column M)"; Node 20 does not, and parser.js
      // only adds its own "(line N)" when the runtime supplied one.
      const runtimeReportsLines = (() => {
        try {
          JSON.parse('{\n"a" 1}');
        } catch (err) {
          return /line \d+/i.test(err.message);
        }
        return false;
      })();

      const message = (() => {
        try {
          parseContent('broken.json', raw);
        } catch (err) {
          return err.message;
        }
        return assert.fail('expected a parse error');
      })();

      if (runtimeReportsLines) {
        assert.match(message, /\(line 6\)/);
      } else {
        assert.doesNotMatch(message, /\(line \d+\)/);
      }
    });

    test('stripping preserves length, so byte offsets are unchanged', () => {
      const raw = '{\n  /* multi\n     line */ "a": 1\n}';
      const stripped = stripJsonComments(raw);
      assert.equal(stripped.length, raw.length);
      assert.equal(
        stripped.split('\n').length,
        raw.split('\n').length,
        'newlines inside a block comment must be kept',
      );
    });

    test('an unterminated block comment reports the truncated document', () => {
      assert.throws(() => parseJsonc('{"a": 1 /* oops'), SyntaxError);
    });
  });

  test('CRLF files parse', () => {
    assert.deepEqual(parseJsonc('{\r\n // c\r\n "a": 1\r\n}'), { a: 1 });
  });

  test('comment-free JSON parses identically to JSON.parse', () => {
    // The stripper must be a no-op on ordinary JSON, including values made
    // entirely of the characters it scans for.
    const samples = [
      '{"a":1,"b":[1,2,{"c":null}]}',
      '{"s":"/ * \\\\ \\" , } {"}',
      '[]',
      '{}',
      '"bare string"',
      '3.14',
      'null',
    ];
    for (const raw of samples) {
      assert.deepEqual(parseJsonc(raw), JSON.parse(raw), raw);
      assert.equal(stripJsonComments(raw), raw, raw);
    }
  });
});
