import { describe, expect, it } from 'vitest';
import { decodeEntities, escapeHtml, parseAttributes, toPlainText } from '../../src/html.js';

describe('escapeHtml', () => {
  it('turns &, <, > and " into character references', () => {
    expect(escapeHtml(`a & b < c > d "e" 'f'`)).toBe(`a &amp; b &lt; c &gt; d &quot;e&quot; 'f'`);
  });
});

describe('decodeEntities', () => {
  it('decodes named and numeric references in a single pass', () => {
    expect(decodeEntities('&amp;&lt;&gt;&quot;&#39;&apos;&#8217;&#x2014;&nbsp;')).toBe(`&<>"''’— `);
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });

  it('leaves unknown names as is', () => {
    expect(decodeEntities('&unknown; & &')).toBe('&unknown; & &');
  });
});

describe('toPlainText', () => {
  it('strips tags, decodes character references and trims whitespace', () => {
    expect(toPlainText(' AsciiDoc &amp; <strong>Astro</strong> <code>&lt;x&gt;</code> ')).toBe(
      'AsciiDoc & Astro <x>',
    );
  });
});

describe('parseAttributes', () => {
  it('reads quoted and unquoted values and attributes without a value', () => {
    expect(parseAttributes(` src="a.png" alt='A &amp; B' width=10 hidden`)).toEqual([
      { name: 'src', value: 'a.png', quoted: true },
      { name: 'alt', value: 'A & B', quoted: true },
      { name: 'width', value: '10', quoted: false },
      { name: 'hidden', value: '', quoted: false },
    ]);
  });
});

describe('decodeEntities name table', () => {
  it('does not look up prototype properties', () => {
    expect(decodeEntities('&constructor; &toString; &__proto__;')).toBe(
      '&constructor; &toString; &__proto__;',
    );
  });

  it('decodes named references commonly written by hand', () => {
    expect(decodeEntities('&copy; &reg; &trade; &hellip; &mdash; &rarr;')).toBe('© ® ™ … — →');
  });
});
