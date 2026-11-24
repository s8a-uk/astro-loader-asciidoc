import { describe, expect, it } from 'vitest';
import {
  DERIVED_ATTRIBUTE_NAMES,
  DERIVED_ATTRIBUTE_PREFIXES,
  isDerivedAttribute,
} from '../../src/attributes.js';
import { convert } from '../helpers.js';

describe('toData', () => {
  it('turns a typical document header into data', async () => {
    const { data } = await convert(
      [
        '= AsciiDoc & Astro',
        'Jane <jane@example.com>',
        ':date: 2026-11-17',
        ':tags: astro, asciidoc',
        ':draft:',
        '',
        'Text.',
      ].join('\n'),
    );
    expect(data).toEqual({
      title: 'AsciiDoc & Astro',
      author: 'Jane',
      authors: 'Jane',
      firstname: 'Jane',
      authorinitials: 'J',
      email: 'jane@example.com',
      date: '2026-11-17',
      tags: 'astro, asciidoc',
      draft: true,
    });
  });

  it('includes the revision line, description and keywords', async () => {
    const { data } = await convert(
      [
        '= T',
        'A B',
        'v1.2, 2026-11-17: First',
        ':description: Desc',
        ':keywords: a, b',
        '',
        'x',
      ].join('\n'),
    );
    expect(data).toMatchObject({
      revnumber: '1.2',
      revdate: '2026-11-17',
      revremark: 'First',
      description: 'Desc',
      keywords: 'a, b',
      lastname: 'B',
    });
  });

  it('excludes built-in attributes and attributes defined in the body', async () => {
    const { data } = await convert(
      '= T\n:idprefix: x\n:custom: yes\n\n== S\n\n:body-attr: v\n\nText.',
    );
    expect(data).toEqual({ title: 'T', custom: 'yes' });
  });

  it('includes built-in attributes that are not set by default when the header sets them', async () => {
    const { data } = await convert(
      [
        '= T',
        ':toc:',
        ':imagesdir: images',
        ':icons: font',
        ':sectnums:',
        ':lang: de',
        ':revnumber: 1.2',
        ':revdate: 2026-11-17',
        ':revremark: Draft',
        ':source-highlighter: rouge',
        '',
        'Text.',
      ].join('\n'),
    );
    expect(data).toEqual({
      title: 'T',
      toc: true,
      imagesdir: 'images',
      icons: 'font',
      sectnums: true,
      lang: 'de',
      revnumber: '1.2',
      revdate: '2026-11-17',
      revremark: 'Draft',
      // Included because highlighting is off in this test (syntaxHighlight: false)
      'source-highlighter': 'rouge',
    });
  });

  it('excludes source-highlighter when the loader sets it (highlighting on)', async () => {
    const { data } = await convert('= T\n:source-highlighter: rouge\n\nText.', { shiki: {} });
    expect(data).toEqual({ title: 'T' });
  });

  it('excludes attributes that Asciidoctor derives from header values', async () => {
    const { data } = await convert('= T\n:doctype: book\n:toc: right\n:custom: yes\n\nText.');
    expect(data).toEqual({ title: 'T', toc: true, custom: 'yes' });
  });

  it('also excludes attributes derived from the manpage doctype', async () => {
    const { data } = await convert(
      '= cmd(1)\n:doctype: manpage\n:manmanual: M\n\n== Name\n\ncmd - does things\n\n== Synopsis\n\ncmd\n',
    );
    expect(Object.keys(data).sort()).toEqual(['manmanual', 'title']);
  });

  it('strips tags from the title and decodes its character references', async () => {
    const { data } = await convert('= AsciiDoc &amp; *Astro* `x`\n\nText.');
    expect(data.title).toBe('AsciiDoc & Astro x');
  });

  it('prefers the document title over a :title: attribute and never uses the first section title', async () => {
    expect((await convert('= Header\n:title: Attr\n\nText.')).data.title).toBe('Header');
    expect((await convert('== First section\n\nText.')).data).toEqual({});
  });

  it('excludes the attributes passed to the loader', async () => {
    const { data } = await convert('= T\n\nx', {
      loaderOptions: { attributes: { icons: 'font', 'sectanchors@': true } },
    });
    expect(data).toEqual({ title: 'T' });
  });
});

describe('decoding character references in attribute values', () => {
  // Asciidoctor turns & < > in header attribute values into character references. Decoding one
  // level gives back the string as written in the source (writing &amp; or &copy; yields that
  // string as is)
  it('restores &, <, >, quotes and the like as written in the source, without stripping tags', async () => {
    const { data } = await convert(
      [
        '= T',
        ':description: Fish & Chips <small> "quoted"',
        ':keywords: a&amp;b',
        ':html: <b>bold</b>',
        ':ref: {description}',
        ':copyright: &copy; 2026',
        '',
        'x',
      ].join('\n'),
    );
    expect(data).toMatchObject({
      description: 'Fish & Chips <small> "quoted"',
      keywords: 'a&amp;b',
      html: '<b>bold</b>',
      ref: 'Fish & Chips <small> "quoted"',
      copyright: '&copy; 2026',
    });
  });

  it('also decodes references deliberately kept with pass:[&amp;] in data (documented in the README)', async () => {
    const { data } = await convert('= T\n:ampersand: pass:[&amp;]\n:plain: a &amp; b\n\nx');
    expect(data).toMatchObject({ ampersand: '&', plain: 'a &amp; b' });
  });

  it('also decodes values from the author line and the revision line', async () => {
    const { data } = await convert(
      "= T\nAna O'Neil <ana@example.com>\nv1, 2026-11-17: Q&A <draft>\n\nx",
    );
    expect(data).toMatchObject({
      author: "Ana O'Neil",
      email: 'ana@example.com',
      revremark: 'Q&A <draft>',
    });
  });
});

// Attributes that Asciidoctor derives from header values (doctype-book, toc-position, ...) are not
// in an empty document, so comparing keys with the baseline cannot exclude them. These name rules
// do, and the list is pinned here.
describe('name rules for derived attributes', () => {
  it('lists the prefixes and names', () => {
    expect(DERIVED_ATTRIBUTE_PREFIXES).toEqual([
      'doctype-',
      'backend-',
      'basebackend-',
      'filetype-',
    ]);
    expect([...DERIVED_ATTRIBUTE_NAMES].sort()).toEqual([
      'manname',
      'manname-id',
      'manname-title',
      'mannames',
      'manpurpose',
      'mantitle',
      'manvolnum',
      'toc-class',
      'toc-position',
    ]);
  });

  it.each([
    ['doctype-book', true],
    ['backend-html5-doctype-book', true],
    ['basebackend-html-doctype-book', true],
    ['filetype-html', true],
    ['toc-position', true],
    ['toc', false],
    ['doctype', false],
    ['tags', false],
  ])('%s → %s', (name, expected) => {
    expect(isDerivedAttribute(name)).toBe(expected);
  });
});
