// Verifies the Asciidoctor.js behavior that toData relies on: removing the keys of an empty
// document from doc.getAttributes() after load() leaves only the attributes defined in the header.
import { join } from 'node:path';
import { type Document, load } from '@asciidoctor/core';
import { describe, expect, it } from 'vitest';

// The public type definitions (types/index.d.ts) do not declare the { path, read } form for load().
// It is accepted at runtime (types/load.d.ts and src/load.js), so only the type is widened
const loadSource = load as unknown as (
  input: { path: string; read(): string },
  options?: Record<string, unknown>,
) => Promise<Document>;
const baseDir = '/virtual/notes';

// The loader's default attributes (soft-set with @) plus an example of a user attribute
const attributes = {
  'idprefix@': '',
  'idseparator@': '-',
  'source-highlighter@': 'shiki',
  'relfilesuffix@': '/',
};

async function loadAttributes(source: string, name: string) {
  const input = { path: join(baseDir, name), read: () => source };
  const doc = await loadSource(input, { safe: 'safe', standalone: false, attributes });
  return { doc, attrs: doc.getAttributes() as Record<string, unknown> };
}

async function baselineKeys() {
  const { attrs } = await loadAttributes('', '__baseline__.adoc');
  return new Set(Object.keys(attrs));
}

function headerData(attrs: Record<string, unknown>, baseline: ReadonlySet<string>) {
  return Object.fromEntries(
    Object.entries(attrs)
      .filter(([key]) => !baseline.has(key) && key !== 'doctitle')
      .map(([key, value]) => [key, value === '' ? true : value]),
  );
}

describe('telling header attributes from built-in attributes', () => {
  it('keeps only the attributes defined in the header and those derived from the author and revision lines', async () => {
    const baseline = await baselineKeys();
    const { attrs } = await loadAttributes(
      [
        '= AsciiDoc & Astro',
        'Jane <jane@example.com>',
        'v1.2, 2026-11-17: First draft',
        ':date: 2026-11-17',
        ':tags: astro, asciidoc',
        ':draft:',
        ':description: A description',
        ':keywords: a, b',
        '',
        '== Section',
        '',
        ':body-attr: defined in body',
        '',
        'Text.',
      ].join('\n'),
      'hello.adoc',
    );

    expect(headerData(attrs, baseline)).toEqual({
      author: 'Jane',
      authorinitials: 'J',
      authors: 'Jane',
      firstname: 'Jane',
      email: 'jane@example.com',
      revnumber: '1.2',
      revdate: '2026-11-17',
      revremark: 'First draft',
      date: '2026-11-17',
      tags: 'astro, asciidoc',
      draft: true,
      description: 'A description',
      keywords: 'a, b',
    });
  });

  it('removes built-in attributes whose values vary per document, such as times and docfile, by comparing keys', async () => {
    const baseline = await baselineKeys();
    for (const key of ['docfile', 'docdir', 'docname', 'localdate', 'localtime', 'docdate']) {
      expect(baseline.has(key), key).toBe(true);
    }
    const { attrs } = await loadAttributes('= Title\n\nText.', 'other/doc.adoc');
    expect(headerData(attrs, baseline)).toEqual({});
  });

  it('leaves out a built-in attribute that an empty document also has, even when the header overrides it', async () => {
    const baseline = await baselineKeys();
    const { attrs } = await loadAttributes(
      '= Title\n:idprefix: x\n:source-highlighter: highlight.js\n:custom: yes\n\nText.',
      'override.adoc',
    );
    expect(attrs.idprefix).toBe('x');
    expect(headerData(attrs, baseline)).toEqual({ custom: 'yes' });
  });

  // Differs from what was first assumed: attributes that Asciidoctor derives from header attributes
  // are not in an empty document, so they remain. toData removes them with name rules instead.
  it('cannot remove attributes derived from doctype or toc values by comparing keys (known gap)', async () => {
    const baseline = await baselineKeys();
    const { attrs } = await loadAttributes(
      '= Title\n:doctype: book\n:toc: left\n:custom: yes\n\nText.',
      'book.adoc',
    );
    expect(headerData(attrs, baseline)).toEqual({
      custom: 'yes',
      // A configuration attribute the user wrote in the header (kept, as an empty document lacks
      // it). :toc: left is split into toc as an empty string and toc-position as left
      toc: true,
      // Attributes derived by Asciidoctor
      'doctype-book': true,
      'backend-html5-doctype-book': true,
      'basebackend-html-doctype-book': true,
      'toc-position': 'left',
      'toc-class': 'toc2',
    });
  });

  it('returns the title with character references and formatting as tagged HTML from getDoctitle()', async () => {
    const { doc } = await loadAttributes('= AsciiDoc & *Astro*\n\nText.', 't.adoc');
    expect(doc.getDoctitle()).toBe('AsciiDoc &amp; <strong>Astro</strong>');
  });
});
