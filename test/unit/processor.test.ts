// Runs loadOptions and converter through an actual conversion
import { Html5Converter } from '@asciidoctor/core';
import { describe, expect, it } from 'vitest';
import { convert } from '../helpers.js';

describe('asciidoctor.loadOptions and converter', () => {
  it('applies the doctype from loadOptions to the conversion', async () => {
    const { headings, html } = await convert('= Book\n\n= Part\n\n== Chapter\n\ntext\n', {
      loaderOptions: { asciidoctor: { loadOptions: { doctype: 'book' } } },
    });
    expect(headings).toEqual([
      { depth: 1, slug: 'part', text: 'Part' },
      { depth: 2, slug: 'chapter', text: 'Chapter' },
    ]);
    expect(html).toContain('<h1 id="part" class="sect0">Part</h1>');
  });

  it('lets a converter replace the output of one node type while other nodes stay the same', async () => {
    class CustomConverter extends Html5Converter {
      // biome-ignore lint/suspicious/noExplicitAny: the Block type is loose
      override async convert_paragraph(node: any) {
        return `<p class="custom">${await node.getContent()}</p>`;
      }
    }
    const { html, headings } = await convert('= T\n\n== Section\n\nHello *there*.\n', {
      loaderOptions: { asciidoctor: { converter: CustomConverter } },
    });
    expect(html).toContain('<p class="custom">Hello <strong>there</strong>.</p>');
    expect(html).toContain('<h2 id="section">Section</h2>');
    expect(headings).toEqual([{ depth: 2, slug: 'section', text: 'Section' }]);
  });
});
