/**
 * Static HTML drift report.
 *
 * `renderReportHtml` is pure: it reads nothing but its argument, so the bytes
 * written to disk are exactly the bytes a test can assert on. The page is
 * deliberately self-contained — inline CSS, one small inline script, no fonts,
 * no images, no network access at view time. A report is a file you attach to
 * an incident thread, so it has to render identically on a machine that is
 * offline, and it must never phone home.
 *
 * Every value that reaches the page goes through `escapeHtml` first. Config
 * values are attacker-influenced in the sense that matters here: a value
 * containing `</div>` or `<script>` must render as text, never as markup.
 */

import { isAbsolute, relative } from 'path';

/**
 * @typedef {{
 *   file: string,
 *   createdAt: string,
 *   changeCount: number,
 *   previousCreatedAt?: string | null,
 *   changes?: import('./differ.js').ChangeEvent[],
 *   policies?: import('./policy.js').PolicyFinding[]
 * }} ReportSnapshot
 *
 * @typedef {{
 *   snapshots?: ReportSnapshot[],
 *   generatedAt?: string,
 *   cwd?: string,
 *   version?: string,
 *   limit?: number,
 *   maskSecrets?: boolean
 * }} ReportData
 */

const SEVERITY_ORDER = ['error', 'warn', 'info'];
const SEVERITY_HEADINGS = { error: 'Errors', warn: 'Warnings', info: 'Notices' };
const SEVERITY_NOUNS = { error: 'error', warn: 'warning', info: 'notice' };
const CHANGE_TYPES = ['changed', 'added', 'removed'];
const CHANGE_SYMBOLS = { added: '+', removed: '-', changed: '~' };
/** Long values (PEM blocks, embedded JSON) would otherwise dominate the page. */
const MAX_VALUE_CHARS = 400;

/**
 * Characters that can break out of an HTML text node or an attribute value.
 * `=` and the backtick are included because they end an unquoted attribute in
 * some legacy parsers, which is the cheapest way to be wrong about escaping.
 */
const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
  '=': '&#61;',
};

/**
 * Escape a value for interpolation into HTML text or a quoted attribute.
 *
 * One regex pass replaces each source character exactly once, so an entity this
 * function emits is never re-escaped and `&amp;` in a config value survives as
 * the literal text it was. Nullish input renders as the empty string rather
 * than the literal "null" — an absent value should read as absent.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`=]/g, (char) => HTML_ESCAPES[char]);
}

/**
 * @param {number} count
 * @param {string} noun
 * @returns {string}
 */
function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Normalize a snapshot timestamp into an unambiguous UTC label plus the raw
 * ISO string for the `datetime` attribute. Unparseable input is shown verbatim
 * rather than silently dropped.
 * @param {unknown} value
 * @returns {{ iso: string, label: string }}
 */
function formatTimestamp(value) {
  const raw = String(value ?? '');
  const date = new Date(raw);
  if (!raw || Number.isNaN(date.getTime())) {
    return { iso: raw, label: raw || 'unknown time' };
  }
  const iso = date.toISOString();
  return { iso, label: `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC` };
}

/**
 * Format one side of a change, or return null when that side is absent.
 * @param {unknown} value
 * @returns {string | null}
 */
function formatValue(value) {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  const text = json === undefined ? String(value) : json;
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

/**
 * @param {ReportSnapshot} snapshot
 * @returns {import('./differ.js').ChangeEvent[]}
 */
function changesOf(snapshot) {
  return Array.isArray(snapshot.changes) ? snapshot.changes : [];
}

/**
 * @param {ReportSnapshot} snapshot
 * @returns {import('./policy.js').PolicyFinding[]}
 */
function findingsOf(snapshot) {
  return Array.isArray(snapshot.policies) ? snapshot.policies : [];
}

/**
 * Prefer a path relative to where the report was generated; an absolute runner
 * path is noise. Anything outside `cwd` keeps its absolute form.
 * @param {string} file
 * @param {string} [cwd]
 * @returns {string}
 */
function displayPath(file, cwd) {
  const value = String(file ?? '');
  if (!cwd || !isAbsolute(value)) return value;
  const rel = relative(cwd, value);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return value;
  return rel.replaceAll('\\', '/');
}

/**
 * @param {unknown} severity
 * @returns {'error' | 'warn' | 'info'}
 */
function normalizeSeverity(severity) {
  return SEVERITY_ORDER.includes(severity) ? severity : 'info';
}

/**
 * Group snapshots by file, keeping the order they arrive in (newest first), so
 * the file whose config moved most recently leads the report.
 * @param {ReportSnapshot[]} snapshots
 * @returns {Array<{ file: string, entries: ReportSnapshot[] }>}
 */
function groupByFile(snapshots) {
  /** @type {Map<string, ReportSnapshot[]>} */
  const byFile = new Map();
  for (const snapshot of snapshots) {
    const file = String(snapshot.file ?? '');
    const entries = byFile.get(file) ?? [];
    entries.push(snapshot);
    byFile.set(file, entries);
  }
  return [...byFile.entries()].map(([file, entries]) => ({ file, entries }));
}

/**
 * @param {string} label
 * @param {string} value
 * @param {string} [tone]
 * @returns {string}
 */
function statTile(label, value, tone = '') {
  return `<div class="stat${tone ? ` stat-${tone}` : ''}">`
    + `<div class="stat-value">${escapeHtml(value)}</div>`
    + `<div class="stat-label">${escapeHtml(label)}</div>`
    + '</div>';
}

/**
 * @param {import('./differ.js').ChangeEvent} change
 * @returns {string}
 */
function changeRow(change) {
  const type = CHANGE_TYPES.includes(change.type) ? change.type : 'changed';
  const before = formatValue(change.before);
  const after = formatValue(change.after);
  const note = change.note ? `<div class="note">${escapeHtml(change.note)}</div>` : '';
  return [
    `<tr class="change change-${escapeHtml(type)}">`,
    `<td class="cell-type"><span class="badge badge-${escapeHtml(type)}">`
      + `<span class="sym">${escapeHtml(CHANGE_SYMBOLS[type])}</span> ${escapeHtml(type)}</span></td>`,
    `<td class="cell-path"><code>${escapeHtml(change.path ?? '')}</code>${note}</td>`,
    `<td class="cell-value">${before === null ? '<span class="absent">—</span>' : `<code>${escapeHtml(before)}</code>`}</td>`,
    `<td class="cell-value">${after === null ? '<span class="absent">—</span>' : `<code>${escapeHtml(after)}</code>`}</td>`,
    '</tr>',
  ].join('');
}

/**
 * @param {import('./policy.js').PolicyFinding} finding
 * @returns {string}
 */
function findingItem(finding) {
  const severity = normalizeSeverity(finding.severity);
  const pack = finding.pack ? ` <span class="pack">[${escapeHtml(finding.pack)}]</span>` : '';
  return `<li class="finding finding-${escapeHtml(severity)}">`
    + `<span class="sev sev-${escapeHtml(severity)}">${escapeHtml(severity)}</span>`
    + `<span class="rule"><code>${escapeHtml(finding.id ?? '')}</code>${pack}</span>`
    + `<span class="finding-body"><code>${escapeHtml(finding.path ?? '')}</code> — ${escapeHtml(finding.message ?? '')}</span>`
    + '</li>';
}

/**
 * One snapshot in a file's timeline: when it was taken, how far it moved from
 * the snapshot before it, and everything that moved.
 * @param {ReportSnapshot} snapshot
 * @param {number} index
 * @returns {string}
 */
function snapshotCard(snapshot, index) {
  const time = formatTimestamp(snapshot.createdAt);
  const changes = changesOf(snapshot);
  const findings = findingsOf(snapshot);
  const count = Number.isInteger(snapshot.changeCount) ? snapshot.changeCount : changes.length;
  const previous = snapshot.previousCreatedAt ? formatTimestamp(snapshot.previousCreatedAt) : null;

  const baselineNote = previous
    ? `<span class="baseline">since <time datetime="${escapeHtml(previous.iso)}">${escapeHtml(previous.label)}</time></span>`
    : '<span class="baseline">first snapshot — nothing to compare against</span>';

  const body = [];
  if (changes.length > 0) {
    body.push(
      '<div class="scroll"><table class="changes">',
      '<thead><tr><th>Change</th><th>Path</th><th>Before</th><th>After</th></tr></thead>',
      '<tbody>',
      ...changes.map(changeRow),
      '</tbody></table></div>',
    );
  } else if (count > 0) {
    // changeCount without events: the caller summarized but did not diff.
    body.push(`<p class="empty">${escapeHtml(plural(count, 'change'))} recorded.</p>`);
  } else if (!previous) {
    // Nothing was compared here, so "no changes" would be a claim this card
    // cannot support (#141). Say what actually happened instead.
    body.push(
      '<p class="empty">First snapshot of this file — there is no earlier state to'
      + ' compare it against. That is <strong>no history</strong>, not no drift.</p>',
    );
  } else {
    body.push('<p class="empty">No semantic changes from the previous snapshot.</p>');
  }

  if (findings.length > 0) {
    body.push(
      `<h4 class="findings-title">Policy findings (${escapeHtml(String(findings.length))})</h4>`,
      `<ul class="findings">${findings.map(findingItem).join('')}</ul>`,
    );
  }

  const countClass = count > 0 ? 'count count-active' : 'count';
  // A first snapshot is labelled "baseline" rather than "0 changes": the count
  // is only meaningful once there is something on the other side of it.
  const countLabel = previous ? plural(count, 'change') : 'baseline';
  return [
    `<details class="card" open id="snapshot-${escapeHtml(String(index))}">`,
    '<summary>',
    `<time class="stamp" datetime="${escapeHtml(time.iso)}">${escapeHtml(time.label)}</time>`,
    `<span class="${countClass}">${escapeHtml(countLabel)}</span>`,
    baselineNote,
    '</summary>',
    `<div class="card-body">${body.join('')}</div>`,
    '</details>',
  ].join('');
}

/**
 * @param {Array<{ file: string, snapshot: ReportSnapshot, finding: import('./policy.js').PolicyFinding }>} rows
 * @returns {string}
 */
function findingsTable(rows) {
  const body = rows.map(({ file, snapshot, finding }) => {
    const time = formatTimestamp(snapshot.createdAt);
    return '<tr>'
      + `<td><code>${escapeHtml(finding.id ?? '')}</code>`
        + `${finding.pack ? ` <span class="pack">[${escapeHtml(finding.pack)}]</span>` : ''}</td>`
      + `<td><code>${escapeHtml(file)}</code></td>`
      + `<td><code>${escapeHtml(finding.path ?? '')}</code></td>`
      + `<td>${escapeHtml(finding.message ?? '')}</td>`
      + `<td><time datetime="${escapeHtml(time.iso)}">${escapeHtml(time.label)}</time></td>`
      + '</tr>';
  }).join('');
  return '<div class="scroll"><table class="findings-table">'
    + '<thead><tr><th>Rule</th><th>File</th><th>Path</th><th>Message</th><th>Snapshot</th></tr></thead>'
    + `<tbody>${body}</tbody></table></div>`;
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --panel: #f6f7f9;
  --panel-2: #eef0f4;
  --border: #dfe3ea;
  --text: #11161d;
  --muted: #5a6675;
  --accent: #1d5fbf;
  --added: #146c43;
  --removed: #b3261e;
  --changed: #8a5a00;
  --error: #b3261e;
  --warn: #8a5a00;
  --info: #1d5fbf;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1116;
    --panel: #161b22;
    --panel-2: #1c222b;
    --border: #2b323c;
    --text: #e6edf3;
    --muted: #9aa7b4;
    --accent: #6ea8fe;
    --added: #4ec98a;
    --removed: #ff8785;
    --changed: #e3b341;
    --error: #ff8785;
    --warn: #e3b341;
    --info: #6ea8fe;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 15px;
  line-height: 1.5;
}
code, .stamp, .count, .stat-value, td, th {
  font-variant-numeric: tabular-nums;
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.88em;
  overflow-wrap: anywhere;
}
.wrap { max-width: 1100px; margin: 0 auto; padding: 32px 20px 64px; }
header h1 { font-size: 1.6rem; margin: 0 0 6px; letter-spacing: -0.01em; }
.subtitle { color: var(--muted); margin: 0 0 18px; }
.meta { color: var(--muted); font-size: 0.86rem; margin: 0 0 24px; }
.meta div { margin: 2px 0; }
.masked {
  display: inline-block;
  border: 1px solid var(--border);
  background: var(--panel-2);
  border-radius: 999px;
  padding: 1px 10px;
  color: var(--text);
}
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
  margin: 0 0 28px;
}
.stat { border: 1px solid var(--border); background: var(--panel); border-radius: 8px; padding: 12px 14px; }
.stat-value { font-size: 1.5rem; font-weight: 600; line-height: 1.2; }
.stat-label { color: var(--muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
.stat-error .stat-value { color: var(--error); }
.stat-warn .stat-value { color: var(--warn); }
h2 { font-size: 1.05rem; margin: 32px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
h2 code { font-size: 0.95em; }
h3 { font-size: 0.95rem; margin: 20px 0 8px; color: var(--muted); }
h4 { font-size: 0.85rem; margin: 14px 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0 0 8px; }
.controls input {
  flex: 1 1 240px;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
}
.controls button {
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
.controls button:hover { background: var(--panel-2); }
.card { border: 1px solid var(--border); border-radius: 8px; background: var(--panel); margin: 0 0 10px; }
.card > summary {
  cursor: pointer;
  padding: 10px 14px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  align-items: baseline;
}
/* display:flex drops the native disclosure marker, so draw our own. */
.card > summary { list-style: none; }
.card > summary::-webkit-details-marker { display: none; }
.card > summary::before { content: "\\25B8"; color: var(--muted); }
.card[open] > summary::before { content: "\\25BE"; }
.stamp { font-weight: 600; font-size: 0.95rem; }
.count { color: var(--muted); font-size: 0.86rem; }
.count-active { color: var(--text); }
.baseline { color: var(--muted); font-size: 0.82rem; margin-left: auto; }
.card-body { padding: 0 14px 14px; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
th {
  text-align: left;
  color: var(--muted);
  font-weight: 600;
  font-size: 0.76rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--border);
  padding: 6px 8px;
}
td { border-bottom: 1px solid var(--border); padding: 6px 8px; vertical-align: top; }
tr:last-child td { border-bottom: 0; }
.cell-type { white-space: nowrap; }
.cell-value code { overflow-wrap: anywhere; }
.badge { font-size: 0.78rem; font-weight: 600; }
.badge .sym { display: inline-block; width: 0.8em; font-family: ui-monospace, monospace; }
.badge-added { color: var(--added); }
.badge-removed { color: var(--removed); }
.badge-changed { color: var(--changed); }
.absent { color: var(--muted); }
.note { color: var(--muted); font-size: 0.8rem; }
.pack { color: var(--muted); }
.findings { list-style: none; margin: 0; padding: 0; }
.finding { display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 5px 0; border-bottom: 1px solid var(--border); }
.finding:last-child { border-bottom: 0; }
.finding-body { flex: 1 1 320px; }
.sev { font-weight: 700; font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.04em; min-width: 44px; }
.sev-error { color: var(--error); }
.sev-warn { color: var(--warn); }
.sev-info { color: var(--info); }
.empty { color: var(--muted); margin: 8px 0; }
.banner {
  border: 1px solid var(--warn);
  border-left-width: 4px;
  border-radius: 6px;
  background: var(--panel);
  padding: 10px 14px;
  margin: 0 0 24px;
}
.no-matches { color: var(--muted); margin: 16px 0; }
footer { margin-top: 40px; padding-top: 14px; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.82rem; }
.hidden { display: none !important; }
@media (max-width: 620px) {
  .wrap { padding: 20px 12px 40px; }
  .baseline { margin-left: 0; flex-basis: 100%; }
}
@media print {
  .controls { display: none; }
  .wrap { max-width: none; padding: 0; }
  .card { break-inside: avoid; border-color: #999; }
  .card > summary::before { content: ""; }
}
`;

/**
 * Filtering and bulk expand/collapse. Vanilla, inline, and dependency-free:
 * the page must work from a file:// URL with no network.
 */
const SCRIPT = `
(function () {
  var input = document.getElementById('filter');
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('.file-group'));
  var empty = document.getElementById('no-matches');
  if (!input) return;

  function apply() {
    var term = input.value.trim().toLowerCase();
    var shown = 0;
    cards.forEach(function (card) {
      var hit = !term || (card.textContent || '').toLowerCase().indexOf(term) !== -1;
      card.classList.toggle('hidden', !hit);
      if (hit) shown++;
    });
    groups.forEach(function (group) {
      var visible = group.querySelectorAll('.card:not(.hidden)').length;
      group.classList.toggle('hidden', visible === 0);
    });
    if (empty) empty.classList.toggle('hidden', shown !== 0);
  }

  function setOpen(open) {
    cards.forEach(function (card) { card.open = open; });
  }

  input.addEventListener('input', apply);
  var expand = document.getElementById('expand-all');
  var collapse = document.getElementById('collapse-all');
  if (expand) expand.addEventListener('click', function () { setOpen(true); });
  if (collapse) collapse.addEventListener('click', function () { setOpen(false); });
})();
`;

/**
 * Render the full drift report as a single self-contained HTML document.
 *
 * Pure — no filesystem, no clock, no network. Callers pass `generatedAt` so
 * the same input always renders the same bytes.
 * @param {ReportData} [data]
 * @returns {string} A complete HTML document
 */
export function renderReportHtml(data = {}) {
  const snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
  const generated = formatTimestamp(data.generatedAt ?? new Date().toISOString());
  const groups = groupByFile(snapshots);

  const severityCounts = { error: 0, warn: 0, info: 0 };
  /** @type {Array<{ file: string, snapshot: ReportSnapshot, finding: import('./policy.js').PolicyFinding }>} */
  const allFindings = [];
  let totalChanges = 0;
  // How many of these snapshots actually had an earlier one to be compared
  // against. Zero means the report compared nothing, which is a different
  // statement from "compared everything and found nothing" (#141).
  let comparisons = 0;
  for (const snapshot of snapshots) {
    const changes = changesOf(snapshot);
    if (snapshot.previousCreatedAt) comparisons += 1;
    // Prefer the events actually carried; fall back to the count for callers
    // that summarized without diffing.
    totalChanges += Array.isArray(snapshot.changes)
      ? changes.length
      : (Number.isInteger(snapshot.changeCount) ? snapshot.changeCount : 0);
    for (const finding of findingsOf(snapshot)) {
      const severity = normalizeSeverity(finding.severity);
      severityCounts[severity] += 1;
      allFindings.push({ file: displayPath(snapshot.file, data.cwd), snapshot, finding });
    }
  }

  const head = [
    '<header>',
    '<h1>Flecto drift report</h1>',
    '<p class="subtitle">What your config changed, from local snapshot history.</p>',
    '<div class="meta">',
    `<div>Generated <time datetime="${escapeHtml(generated.iso)}">${escapeHtml(generated.label)}</time>`
      + ' · all timestamps are UTC</div>',
    data.cwd ? `<div>Working directory <code>${escapeHtml(data.cwd)}</code></div>` : '',
    data.version ? `<div>Flecto ${escapeHtml(data.version)}</div>` : '',
    data.maskSecrets
      ? '<div><span class="masked">Secret masking on</span> — secret-like values are redacted in this report.</div>'
      : '',
    '</div>',
    '</header>',
  ].filter(Boolean).join('');

  if (snapshots.length === 0) {
    return htmlDocument([
      head,
      '<p class="empty">No local snapshots found.'
      + ' Run <code>flecto watch &lt;file&gt; --snapshot</code> first.</p>',
      footer(data),
    ].join(''));
  }

  const stats = [
    '<section class="stats">',
    statTile('Snapshots', String(snapshots.length)),
    statTile('Files', String(groups.length)),
    // "Changes" alone reads as an all-clear at 0 whether or not anything was
    // ever compared, so the number of comparisons behind it sits next to it.
    statTile('Comparisons', String(comparisons)),
    statTile('Changes', String(totalChanges)),
    statTile('Policy errors', String(severityCounts.error), 'error'),
    statTile('Policy warnings', String(severityCounts.warn), 'warn'),
    '</section>',
  ].join('');

  // The failure mode this guards against: a CI job takes its first snapshot and
  // renders a report from it, and the page reads as "nothing drifted" when the
  // truth is that there was no history to look at. Say so above the fold.
  const noHistoryBanner = comparisons === 0
    ? '<p class="banner">Nothing in this report was compared. Every snapshot here is'
      + ' the first one of its file, so there is no earlier state to measure drift'
      + ' against — this is <strong>no history</strong>, not <strong>no drift</strong>.'
      + ' Snapshot history is local to the working directory, so a fresh CI runner'
      + ' starts with none of it.</p>'
    : '';

  const findingsSection = allFindings.length === 0
    ? '<h2>Policy findings</h2><p class="empty">No policy findings across these snapshots.</p>'
    : [
      `<h2>Policy findings (${escapeHtml(String(allFindings.length))})</h2>`,
      ...SEVERITY_ORDER.flatMap((severity) => {
        const rows = allFindings.filter((row) => normalizeSeverity(row.finding.severity) === severity);
        if (rows.length === 0) return [];
        return [
          `<h3>${escapeHtml(SEVERITY_HEADINGS[severity])} — `
            + `${escapeHtml(plural(rows.length, SEVERITY_NOUNS[severity]))}</h3>`,
          findingsTable(rows),
        ];
      }),
    ].join('');

  const controls = [
    '<div class="controls">',
    '<input id="filter" type="search" placeholder="Filter by path, value, file, or rule"'
      + ' aria-label="Filter snapshots">',
    '<button id="expand-all" type="button">Expand all</button>',
    '<button id="collapse-all" type="button">Collapse all</button>',
    '</div>',
    '<p id="no-matches" class="no-matches hidden">Nothing matches that filter.</p>',
  ].join('');

  let cardIndex = 0;
  const timeline = groups.map(({ file, entries }) => {
    const label = displayPath(file, data.cwd);
    // The absolute path stays reachable on hover when the heading is shortened.
    const title = label === file ? '' : ` title="${escapeHtml(file)}"`;
    return [
      '<section class="file-group">',
      `<h2><code${title}>${escapeHtml(label)}</code></h2>`,
      ...entries.map((entry) => snapshotCard(entry, cardIndex++)),
      '</section>',
    ].join('');
  }).join('');

  return htmlDocument([
    head,
    stats,
    noHistoryBanner,
    findingsSection,
    `<h2>Snapshot timeline (${escapeHtml(plural(snapshots.length, 'snapshot'))})</h2>`,
    controls,
    timeline,
    footer(data),
  ].join(''), true);
}

/**
 * @param {ReportData} data
 * @returns {string}
 */
function footer(data) {
  const limit = Number.isInteger(data.limit)
    ? ` Limited to the ${escapeHtml(plural(data.limit, 'most recent snapshot'))}.`
    : '';
  return '<footer>Generated by Flecto from <code>.flecto-snapshots/</code>.'
    + ' This file is self-contained: no external scripts, fonts, or images, and nothing'
    + ` is sent anywhere when you open it.${limit}</footer>`;
}

/**
 * Wrap rendered body markup in the document shell. The shell is static text —
 * no caller data reaches it — so the only inline `<style>` and `<script>`
 * content on the page is Flecto's own.
 * @param {string} body
 * @param {boolean} [withScript]
 * @returns {string}
 */
function htmlDocument(body, withScript = false) {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    '<title>Flecto drift report</title>',
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    `<div class="wrap">${body}</div>`,
    withScript ? `<script>${SCRIPT}</script>` : '',
    '</body>',
    '</html>',
    '',
  ].filter(Boolean).join('\n');
}
