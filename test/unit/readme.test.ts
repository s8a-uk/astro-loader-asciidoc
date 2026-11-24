// Checks that the README does not contradict the implementation
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PATTERNS, KNOWN_OPTIONS } from '../../src/options.js';
import { convert } from '../helpers.js';

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const fixtureConfig = readFileSync(
  new URL('../fixtures/site/src/content.config.ts', import.meta.url),
  'utf8',
);

/** Rows of the table under "## Options" in the README (option name in the first column → row) */
function optionRows(): Map<string, string[]> {
  const section = readme.split('\n## Options\n')[1]?.split('\n## ')[0] ?? '';
  const rows = new Map<string, string[]>();
  for (const line of section.split('\n')) {
    const name = /^\| `([A-Za-z]+)` \|/.exec(line)?.[1];
    if (name) rows.set(name, line.split(' | '));
  }
  return rows;
}

/** Rows of the table in "## Heading ids" (heading line -> id) */
function headingIdRows(): Array<[heading: string, id: string]> {
  const section = readme.split('\n## Heading ids\n')[1]?.split('\n## ')[0] ?? '';
  const rows: Array<[string, string]> = [];
  for (const line of section.split('\n')) {
    const match = /^\| `(== [^`]+)` \| `([^`]+)` \|$/.exec(line);
    if (match?.[1] && match[2]) rows.push([match[1], match[2]]);
  }
  return rows;
}

describe('README', () => {
  it('has the same quick start content config as the E2E fixture, which passes type checks and E2E', () => {
    expect(readme).toContain(`\`\`\`ts\n${fixtureConfig}\`\`\``);
  });

  it('lists exactly the accepted options in the options table', () => {
    expect([...optionRows().keys()].sort()).toEqual([...KNOWN_OPTIONS].sort());
  });

  it('documents the same pattern default as the implementation', () => {
    const literal = `[${DEFAULT_PATTERNS.map((p) => `'${p}'`).join(', ')}]`;
    expect(optionRows().get('pattern')?.[2]).toBe(`\`${literal}\``);
  });

  it('shows heading ids that match the actual output', async () => {
    const rows = headingIdRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const [heading, id] of rows) {
      const { headings, html } = await convert(`= T\n\n${heading}\n`);
      expect(headings[0]?.slug).toBe(id);
      expect(html).toContain(`id="${id}"`);
    }
  });
});
