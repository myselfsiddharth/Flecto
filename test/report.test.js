import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';

import { escapeHtml, renderReportHtml } from '../src/report.js';

const rootIndex = resolve(process.cwd(), 'index.js');

/**
 * Write one timestamped snapshot history entry, the same shape
 * `flecto watch --snapshot` writes.
 * @param {string} dir
 * @param {string} file
 * @param {unknown} state
 * @param {string} createdAt
 * @param {number} seq
 */
function writeSnapshot(dir, file, state, createdAt, seq) {
  const snapshotDir = join(dir, '.flecto-snapshots');
  mkdirSync(snapshotDir, { recursive: true });
  const id = createHash('sha256').update(file.replaceAll('\\', '/')).digest('hex').slice(0, 16);
  writeFileSync(
    join(snapshotDir, `${id}.${seq}.json`),
    JSON.stringify({ file, state, createdAt }),
    'utf8',
  );
}

/**
 * @param {string} dir
 * @param {string[]} args
 */
function runReport(dir, args) {
  return spawnSync(process.execPath, [rootIndex, 'report', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
}

/**
 * A small, URL-free report payload.
 * @returns {import('../src/report.js').ReportData}
 */
function sampleData() {
  return {
    generatedAt: '2026-03-04T09:15:00.000Z',
    cwd: '/srv/app',
    version: '9.9.9',
    limit: 10,
    snapshots: [
      {
        file: '/srv/app/config/prod.yaml',
        createdAt: '2026-03-03T12:00:00.000Z',
        previousCreatedAt: '2026-03-01T12:00:00.000Z',
        changeCount: 2,
        changes: [
          { type: 'changed', path: 'database.pool_size', before: 5, after: 20 },
          { type: 'added', path: 'logging.debug', after: true },
        ],
        policies: [
          {
            id: 'pool-size-jump',
            severity: 'warn',
            path: 'database.pool_size',
            message: 'Pool size increased from 5 to 20 (>=2x).',
            pack: 'default',
          },
        ],
      },
      {
        file: '/srv/app/config/prod.yaml',
        createdAt: '2026-03-01T12:00:00.000Z',
        previousCreatedAt: null,
        changeCount: 0,
        changes: [],
        policies: [],
      },
    ],
  };
}

test('escapeHtml neutralizes every character that can break out of HTML', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(
    escapeHtml('</div><img src=x onerror=alert(1)>'),
    '&lt;/div&gt;&lt;img src&#61;x onerror&#61;alert(1)&gt;',
  );
  // Attribute-context breakouts: both quote styles and the unquoted-attribute
  // characters (`=` and the backtick) have to go.
  assert.equal(escapeHtml('" onmouseover="alert(1)'), '&quot; onmouseover&#61;&quot;alert(1)');
  assert.equal(escapeHtml("' onfocus='alert(1)"), '&#39; onfocus&#61;&#39;alert(1)');
  assert.equal(escapeHtml('x` `onload=alert(1)'), 'x&#96; &#96;onload&#61;alert(1)');
  assert.equal(escapeHtml('</style><style>body{display:none}'), '&lt;/style&gt;&lt;style&gt;body{display:none}');
  // An already-encoded entity must not survive as one: & is escaped too, so a
  // value reading "&amp;" renders as the literal text "&amp;".
  assert.equal(escapeHtml('&amp;'), '&amp;amp;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  // Non-strings and absent values.
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(false), 'false');
  assert.equal(escapeHtml(12), '12');
});

test('renderReportHtml escapes hostile values everywhere they can appear', () => {
  const html = renderReportHtml({
    generatedAt: '2026-03-04T09:15:00.000Z',
    cwd: '/srv/<app>',
    version: '1.0.0-"beta"',
    snapshots: [
      {
        file: '/srv/<app>/config/"evil".yaml',
        createdAt: '2026-03-03T12:00:00.000Z',
        previousCreatedAt: null,
        changeCount: 3,
        changes: [
          {
            type: 'changed',
            path: 'app.</div><img src=x onerror=alert(1)>',
            before: '<script>alert(1)</script>',
            after: '" onmouseover="alert(1)',
            note: '</td></tr><script>alert(2)</script>',
          },
          {
            type: 'added',
            path: 'nested',
            after: { html: '</style><style>body{display:none}</style>' },
          },
          { type: 'removed', path: 'gone', before: "' onfocus='alert(3)" },
        ],
        policies: [
          {
            id: '</code><script>alert(4)</script>',
            severity: 'error',
            path: 'app.</div>',
            message: 'Found <script>alert(5)</script> in the value',
            pack: '"><script>alert(6)</script>',
          },
        ],
      },
    ],
  });

  // The only script and style elements on the page are Flecto's own.
  assert.equal((html.match(/<script/gi) ?? []).length, 1);
  assert.equal((html.match(/<style/gi) ?? []).length, 1);
  assert.equal((html.match(/<\/script/gi) ?? []).length, 1);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img\b/i);
  // No injected event handler survives as an attribute — "=" is escaped, so an
  // attribute-shaped payload can never re-form.
  assert.doesNotMatch(html, /onerror=/i);
  assert.doesNotMatch(html, /onmouseover=/i);
  assert.doesNotMatch(html, /onfocus=/i);
  assert.doesNotMatch(html, /<\/td><\/tr><script/i);

  // Everything is still there — as text.
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;\/div&gt;&lt;img src&#61;x onerror&#61;alert\(1\)&gt;/);
  // String values are JSON-quoted before escaping, so the payload's own quotes
  // arrive backslash-escaped and then entity-escaped.
  assert.match(html, /&quot;\\&quot; onmouseover&#61;\\&quot;alert\(1\)&quot;/);
  assert.match(html, /&quot;&#39; onfocus&#61;&#39;alert\(3\)&quot;/);
  assert.match(html, /&lt;\/style&gt;&lt;style&gt;/);
  assert.match(html, /Found &lt;script&gt;alert\(5\)&lt;\/script&gt; in the value/);
  assert.match(html, /&quot;&gt;&lt;script&gt;alert\(6\)&lt;\/script&gt;/);
  assert.match(html, /&lt;app&gt;/);
});

test('the rendered report references no external resources', () => {
  const html = renderReportHtml(sampleData());

  // Mechanical self-containment: nothing to fetch, from anywhere.
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(html, /<iframe\b/i);
  assert.doesNotMatch(html, /\bsrc=/i);
  assert.doesNotMatch(html, /\bhref=/i);
  assert.doesNotMatch(html, /@import/i);
  assert.doesNotMatch(html, /url\(/i);
  assert.doesNotMatch(html, /integrity=/i);
  assert.doesNotMatch(html, /crossorigin/i);
  // …and the styles and behavior it does have are inline.
  assert.match(html, /<style>/);
  assert.match(html, /<script>/);
});

test('a URL inside a config value stays inert text', () => {
  const html = renderReportHtml({
    generatedAt: '2026-03-04T09:15:00.000Z',
    snapshots: [{
      file: '/srv/app/config/prod.yaml',
      createdAt: '2026-03-03T12:00:00.000Z',
      previousCreatedAt: null,
      changeCount: 1,
      changes: [{
        type: 'changed',
        path: 'webhook',
        before: 'https://old.invalid/hook',
        after: 'https://evil.invalid/payload.js',
      }],
      policies: [],
    }],
  });

  // The value is visible, because hiding it would defeat the report…
  assert.match(html, /https:\/\/evil\.invalid\/payload\.js/);
  // …but it is never something the browser would load.
  assert.doesNotMatch(html, /(?:src|href|data)\s*=\s*["']?https?:/i);
  assert.doesNotMatch(html, /<(?:script|link|img|iframe|object|embed)[^>]*invalid/i);
  assert.equal((html.match(/<script/gi) ?? []).length, 1);
});

test('renderReportHtml renders timestamps prominently and unambiguously', () => {
  const html = renderReportHtml(sampleData());

  assert.match(html, /<time class="stamp" datetime="2026-03-03T12:00:00\.000Z">2026-03-03 12:00:00 UTC<\/time>/);
  assert.match(html, /since <time datetime="2026-03-01T12:00:00\.000Z">2026-03-01 12:00:00 UTC<\/time>/);
  assert.match(html, /first snapshot — nothing to compare against/);
  assert.match(html, /all timestamps are UTC/);
  assert.match(html, /Generated <time datetime="2026-03-04T09:15:00\.000Z">/);
  // Aligned columns of numbers, per the design brief.
  assert.match(html, /font-variant-numeric: tabular-nums/);
  // Both color schemes and print.
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /@media print/);
  // Paths are shown relative to the directory the report was generated in.
  assert.match(html, /<code title="\/srv\/app\/config\/prod\.yaml">config\/prod\.yaml<\/code>/);
});

test('renderReportHtml handles no snapshots with the same guidance history gives', () => {
  const html = renderReportHtml({ snapshots: [], generatedAt: '2026-03-04T09:15:00.000Z' });

  assert.match(html, /No local snapshots found\./);
  assert.match(html, /flecto watch &lt;file&gt; --snapshot/);
  assert.match(html, /<!doctype html>/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('report writes a self-contained file to --output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-report-output-'));
  const file = join(dir, 'config.yaml');

  try {
    writeSnapshot(dir, file, { database: { pool_size: 5 } }, '2026-03-01T00:00:00.000Z', 1000);
    writeSnapshot(dir, file, { database: { pool_size: 20 } }, '2026-03-02T00:00:00.000Z', 2000);

    const run = runReport(dir, ['--output', join('reports', 'drift.html')]);
    const outputPath = join(dir, 'reports', 'drift.html');

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /✓ Report written: .*drift\.html \(2 snapshots\)/);
    assert.ok(existsSync(outputPath), 'expected the report at the --output path');
    assert.ok(!existsSync(join(dir, 'flecto-report.html')), 'default path must not also be written');

    const html = readFileSync(outputPath, 'utf8');
    assert.match(html, /<!doctype html>/);
    assert.match(html, /database\.pool_size/);
    assert.match(html, /2026-03-02T00:00:00\.000Z/);
    assert.match(html, /pool-size-jump/);
    // Self-containment asserted on the actual artifact, not just the renderer.
    assert.doesNotMatch(html, /https?:\/\//);
    assert.doesNotMatch(html, /<link\b/i);
    assert.doesNotMatch(html, /\bsrc=/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('report defaults to flecto-report.html and honors --limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-report-limit-'));
  const file = join(dir, 'config.yaml');

  try {
    writeSnapshot(dir, file, { pool_size: 1 }, '2026-03-01T00:00:00.000Z', 1000);
    writeSnapshot(dir, file, { pool_size: 2 }, '2026-03-02T00:00:00.000Z', 2000);
    writeSnapshot(dir, file, { pool_size: 3 }, '2026-03-03T00:00:00.000Z', 3000);

    const all = runReport(dir, []);
    const allHtml = readFileSync(join(dir, 'flecto-report.html'), 'utf8');
    const limited = runReport(dir, ['--limit', '1', '--output', 'one.html']);
    const limitedHtml = readFileSync(join(dir, 'one.html'), 'utf8');

    assert.equal(all.status, 0, all.stderr);
    assert.equal((allHtml.match(/class="card"/g) ?? []).length, 3);

    assert.equal(limited.status, 0, limited.stderr);
    assert.match(limited.stdout, /\(1 snapshot\)/);
    assert.equal((limitedHtml.match(/class="card"/g) ?? []).length, 1);
    assert.match(limitedHtml, /2026-03-03T00:00:00\.000Z/);
    // Only the newest snapshot and its baseline reference remain.
    assert.doesNotMatch(limitedHtml, /2026-03-01T00:00:00\.000Z/);

    const bad = runReport(dir, ['--limit', '0']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--limit must be a positive integer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('report masks secret values when --mask-secrets is set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-report-mask-'));
  const file = join(dir, 'config.yaml');
  // Assembled at runtime so no complete credential-shaped literal is committed.
  const accessKeyId = ['AKIA', 'Q7RJ', 'XN4P', 'LM2V', 'ZB6T'].join('');
  const plainSecret = ['sup3r', 'hunter', 'value'].join('-');

  try {
    writeSnapshot(dir, file, { deploy: {} }, '2026-03-01T00:00:00.000Z', 1000);
    writeSnapshot(
      dir,
      file,
      // One secret found by its value under a boring key, one by its key name.
      { deploy: { cloud_id: accessKeyId }, api_key: plainSecret },
      '2026-03-02T00:00:00.000Z',
      2000,
    );

    const plain = runReport(dir, ['--output', 'plain.html']);
    const masked = runReport(dir, ['--mask-secrets', '--output', 'masked.html']);
    const plainHtml = readFileSync(join(dir, 'plain.html'), 'utf8');
    const maskedHtml = readFileSync(join(dir, 'masked.html'), 'utf8');

    // Control: without the flag the report shows the real values.
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(plainHtml.includes(accessKeyId));
    assert.ok(plainHtml.includes(plainSecret));

    // A report is a shareable artifact, so masking has to hold in the file.
    assert.equal(masked.status, 0, masked.stderr);
    assert.ok(!maskedHtml.includes(accessKeyId), 'value-detected secret leaked into the report');
    assert.ok(!maskedHtml.includes(plainSecret), 'key-detected secret leaked into the report');
    assert.match(maskedHtml, /\*\*\*/);
    assert.match(maskedHtml, /Secret masking on/);
    // Masking redacts values, it does not hide that the keys moved.
    assert.match(maskedHtml, /deploy\.cloud_id/);
    assert.match(maskedHtml, /api_key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('report masks secrets from a profile, not only the flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-report-mask-profile-'));
  const file = join(dir, 'config.yaml');
  const accessKeyId = ['AKIA', 'W2HD', 'K9PL', 'RT5N', 'XC3Q'].join('');

  try {
    writeSnapshot(dir, file, { deploy: {} }, '2026-03-01T00:00:00.000Z', 1000);
    writeSnapshot(dir, file, { deploy: { cloud_id: accessKeyId } }, '2026-03-02T00:00:00.000Z', 2000);
    writeFileSync(
      join(dir, '.flectorc.json'),
      JSON.stringify({ profiles: { prod: { maskSecrets: true } } }),
      'utf8',
    );

    const run = runReport(dir, ['--profile', 'prod', '--output', 'prod.html']);
    const html = readFileSync(join(dir, 'prod.html'), 'utf8');

    assert.equal(run.status, 0, run.stderr);
    assert.ok(!html.includes(accessKeyId), 'profile maskSecrets was not applied to the report');
    assert.match(html, /Secret masking on/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('report fails clearly when there are no snapshots to render', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-report-empty-'));
  const other = mkdtempSync(join(tmpdir(), 'flecto-report-filtered-'));

  try {
    const empty = runReport(dir, []);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /No local snapshots found\. Run "flecto watch <file> --snapshot" first\./);
    assert.ok(!existsSync(join(dir, 'flecto-report.html')), 'no report should be written');

    // Snapshots exist, but none for the requested file.
    const tracked = join(other, 'tracked.yaml');
    const untracked = join(other, 'untracked.yaml');
    writeSnapshot(other, tracked, { a: 1 }, '2026-03-01T00:00:00.000Z', 1000);
    writeFileSync(untracked, 'a: 1\n', 'utf8');

    const filtered = runReport(other, [untracked]);
    assert.equal(filtered.status, 1);
    assert.match(
      filtered.stderr,
      /No local snapshots matched the given files\. Omit files to report on all saved snapshot history\./,
    );
    assert.ok(!existsSync(join(other, 'flecto-report.html')), 'no report should be written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('report honors ignore paths and array identity like history does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-report-dopts-'));
  const file = join(dir, 'services.json');
  const before = {
    updated_at: '2024-01-01',
    services: [{ id: 'a', port: 80 }, { id: 'b', port: 443 }],
  };
  const after = {
    updated_at: '2024-12-31',
    services: [{ id: 'b', port: 443 }, { id: 'a', port: 80 }],
  };

  try {
    writeSnapshot(dir, file, before, '2026-03-01T00:00:00.000Z', 1000);
    writeSnapshot(dir, file, after, '2026-03-02T00:00:00.000Z', 2000);

    const noisy = runReport(dir, ['--no-array-id', '--output', 'noisy.html']);
    const quiet = runReport(dir, [
      '--ignore', 'updated_at',
      '--array-id-key', 'id',
      '--array-ignore-order',
      '--output', 'quiet.html',
    ]);
    const noisyHtml = readFileSync(join(dir, 'noisy.html'), 'utf8');
    const quietHtml = readFileSync(join(dir, 'quiet.html'), 'utf8');

    assert.equal(noisy.status, 0, noisy.stderr);
    assert.match(noisyHtml, /updated_at/);
    assert.match(noisyHtml, /services\[0\]/);

    assert.equal(quiet.status, 0, quiet.stderr);
    assert.doesNotMatch(quietHtml, /updated_at/);
    assert.match(quietHtml, /No semantic changes from the previous snapshot\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a report of first snapshots says nothing was compared, not that nothing drifted (#141)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flecto-report-no-history-'));
  const file = join(dir, 'prod.yaml');

  try {
    // One snapshot per file, which is what a CI runner produces on its first
    // (and, on an ephemeral runner, every) run.
    writeSnapshot(dir, file, { replicas: 2 }, '2026-03-01T00:00:00.000Z', 1000);
    writeSnapshot(dir, join(dir, 'staging.yaml'), { replicas: 1 }, '2026-03-01T00:00:01.000Z', 1001);

    const result = runReport(dir, ['--output', 'report.html']);
    const html = readFileSync(join(dir, 'report.html'), 'utf8');

    assert.equal(result.status, 0, result.stderr);
    assert.match(html, /Nothing in this report was compared/);
    assert.match(html, /no history<\/strong>, not <strong>no drift/);
    // The claim the banner exists to prevent.
    assert.doesNotMatch(html, /No semantic changes from the previous snapshot\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderReportHtml labels a first snapshot baseline and counts comparisons (#141)', () => {
  const html = renderReportHtml({
    generatedAt: '2026-03-04T09:15:00.000Z',
    cwd: '/srv/app',
    snapshots: [
      {
        file: '/srv/app/config/prod.yaml',
        createdAt: '2026-03-02T00:00:00.000Z',
        previousCreatedAt: '2026-03-01T00:00:00.000Z',
        changeCount: 0,
        changes: [],
      },
      {
        file: '/srv/app/config/prod.yaml',
        createdAt: '2026-03-01T00:00:00.000Z',
        previousCreatedAt: null,
        changeCount: 0,
        changes: [],
      },
    ],
  });

  // One of the two snapshots had something to compare against, and it is the
  // only one allowed to claim it found no changes.
  assert.match(html, /<div class="stat-value">1<\/div><div class="stat-label">Comparisons<\/div>/);
  assert.match(html, /<span class="count">baseline<\/span>/);
  assert.match(html, /First snapshot of this file/);
  assert.match(html, /No semantic changes from the previous snapshot\./);
  // Something was compared, so the page is not claiming the history is empty.
  assert.doesNotMatch(html, /Nothing in this report was compared/);
});
