import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CHANGELOG_PATH = resolve(process.cwd(), 'CHANGELOG.md');

/**
 * Remove fenced code blocks so sample headings inside them are not counted.
 * @param {string} text
 * @returns {string}
 */
function stripFencedCodeBlocks(text) {
  return text.replace(/^```[\s\S]*?^```/gm, '');
}

/**
 * Split CHANGELOG.md into release sections keyed by heading (e.g. "## [4.0.0]").
 * @param {string} changelog
 * @returns {Map<string, string>}
 */
function splitReleaseSections(changelog) {
  const sections = new Map();
  const parts = changelog.split(/^## /m);
  for (const part of parts.slice(1)) {
    const newline = part.indexOf('\n');
    const heading = part.slice(0, newline === -1 ? undefined : newline).trim();
    const body = newline === -1 ? '' : part.slice(newline + 1);
    sections.set(heading, body);
  }
  return sections;
}

/**
 * Collect ### headings from a release section body.
 * @param {string} body
 * @returns {string[]}
 */
function collectSubheadings(body) {
  const stripped = stripFencedCodeBlocks(body);
  const headings = [];
  for (const line of stripped.split('\n')) {
    const match = /^### (.+)$/.exec(line);
    if (match) headings.push(match[1]);
  }
  return headings;
}

/**
 * Find duplicate ### headings within each release section.
 * @param {string} changelog
 * @returns {Array<{ section: string; heading: string }>}
 */
function findDuplicateSubheadings(changelog) {
  const duplicates = [];
  for (const [section, body] of splitReleaseSections(changelog)) {
    const seen = new Set();
    for (const heading of collectSubheadings(body)) {
      if (seen.has(heading)) {
        duplicates.push({ section, heading });
      }
      seen.add(heading);
    }
  }
  return duplicates;
}

test('CHANGELOG.md has no duplicate ### headings within a release section', () => {
  const changelog = readFileSync(CHANGELOG_PATH, 'utf8');
  const duplicates = findDuplicateSubheadings(changelog);

  assert.equal(
    duplicates.length,
    0,
    duplicates
      .map(({ section, heading }) => `## ${section}: duplicate ### ${heading}`)
      .join('\n') || 'no duplicates',
  );
});

test('stripFencedCodeBlocks ignores ### headings inside fenced code', () => {
  const sample = `### Added

- entry

\`\`\`yaml
### Security
not a real heading
\`\`\`

### Added
`;
  const headings = collectSubheadings(sample);
  assert.deepEqual(headings, ['Added', 'Added']);
  assert.equal(findDuplicateSubheadings(`## [1.0.0]\n${sample}`).length, 1);
});
