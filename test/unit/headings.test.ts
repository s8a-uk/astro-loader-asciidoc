import { describe, expect, it } from 'vitest';
import { convert } from '../helpers.js';

describe('extractHeadings', () => {
  it('records depth, id (in the same form as Markdown), order and nesting', async () => {
    const { headings, html } = await convert(
      [
        '= Title',
        '',
        '== Hello World',
        '',
        '=== Nested One',
        '',
        '==== Deeper',
        '',
        '=== Nested Two',
        '',
        '== Second',
      ].join('\n'),
    );
    expect(headings).toEqual([
      { depth: 2, slug: 'hello-world', text: 'Hello World' },
      { depth: 3, slug: 'nested-one', text: 'Nested One' },
      { depth: 4, slug: 'deeper', text: 'Deeper' },
      { depth: 3, slug: 'nested-two', text: 'Nested Two' },
      { depth: 2, slug: 'second', text: 'Second' },
    ]);
    expect(html).toContain('<h2 id="hello-world">Hello World</h2>');
  });

  it('strips tags from titles with inline formatting and character references', async () => {
    const { headings } = await convert('= T\n\n== *Bold* & `code` <tag>\n');
    expect(headings).toEqual([{ depth: 2, slug: 'bold-code-tag', text: 'Bold & code <tag>' }]);
  });

  it('keeps CJK characters in ids and joins words with -', async () => {
    // Japanese heading meaning "code highlighting" (no spaces)
    const highlighting = '\u30b3\u30fc\u30c9\u306e\u30cf\u30a4\u30e9\u30a4\u30c8';
    // "Astro", a Japanese particle meaning "and", and "AsciiDoc", separated by spaces
    const and = '\u3068';
    const { headings } = await convert(`= T\n\n== ${highlighting}\n\n== Astro ${and} AsciiDoc\n`);
    expect(headings.map((h) => h.slug)).toEqual([highlighting, `astro-${and}-asciidoc`]);
  });

  it('uses the explicit id of a section', async () => {
    const { headings } = await convert('= T\n\n[#custom-id]\n== Section\n');
    expect(headings).toEqual([{ depth: 2, slug: 'custom-id', text: 'Section' }]);
  });

  it('returns no headings for a document that unsets sectids', async () => {
    const { headings } = await convert('= T\n:!sectids:\n\n== A\n\n=== B\n');
    expect(headings).toEqual([]);
  });

  it('excludes [discrete] headings and the document title', async () => {
    const { headings } = await convert('= T\n\n[discrete]\n== Floating\n\n== Real\n');
    expect(headings).toEqual([{ depth: 2, slug: 'real', text: 'Real' }]);
  });

  it('leaves section numbers and appendix prefixes out of text', async () => {
    const { headings, html } = await convert('= T\n:sectnums:\n\n== One\n\n[appendix]\n== Extra\n');
    expect(headings).toEqual([
      { depth: 2, slug: 'one', text: 'One' },
      { depth: 2, slug: 'extra', text: 'Extra' },
    ]);
    expect(html).toContain('1. One');
    expect(html).toContain('Appendix A: Extra');
  });

  it('gives book parts (level 0) depth 1', async () => {
    const { headings } = await convert(
      '= Book\n:doctype: book\n\n= Part One\n\n== Chapter\n\ntext\n',
    );
    expect(headings).toEqual([
      { depth: 1, slug: 'part-one', text: 'Part One' },
      { depth: 2, slug: 'chapter', text: 'Chapter' },
    ]);
  });

  it('lets the document override idprefix and idseparator', async () => {
    const { headings } = await convert('= T\n:idprefix: _\n:idseparator: _\n\n== Hello World\n');
    expect(headings[0]?.slug).toBe('_hello_world');
  });

  it('decodes hand-written named references such as &copy; in text', async () => {
    const { headings } = await convert('= T\n\n== Rights &copy; 2026 &mdash; all\n');
    expect(headings[0]?.text).toBe('Rights \u00a9 2026 \u2014 all');
  });
});
