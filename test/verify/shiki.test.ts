// Verifies the Asciidoctor.js behavior that the Shiki adapter relies on: with
// syntax_highlighters: { shiki: <class> } and the source-highlighter attribute, the adapter's
// highlight() and format() are called, and the source highlight() receives is not yet escaped.
import { load, SyntaxHighlighterBase } from '@asciidoctor/core';
import { createHighlighter } from 'shiki';
import { describe, expect, it } from 'vitest';

interface Call {
  method: 'highlight' | 'format';
  source?: string;
  lang: string | undefined;
  opts: Record<string, unknown>;
}

const highlighter = await createHighlighter({ themes: ['github-dark'], langs: ['js'] });

// The skeleton of the adapter in src/shiki.ts, without transformers such as astroCompat
function createAdapter(calls: Call[]) {
  const preAttributes = new WeakMap<object, string>();
  return class ShikiAdapter extends SyntaxHighlighterBase {
    override handlesHighlighting() {
      return true;
    }

    // biome-ignore lint/suspicious/noExplicitAny: the Block type is outside what this verifies
    override async highlight(node: any, source: string, lang: string, opts: any) {
      calls.push({ method: 'highlight', source, lang, opts });
      const html = highlighter.codeToHtml(source, {
        lang: lang ?? 'plaintext',
        theme: 'github-dark',
      });
      const match = /^<pre([^>]*)><code[^>]*>([\s\S]*)<\/code><\/pre>$/.exec(html);
      if (!match) throw new Error(`unexpected Shiki output: ${html}`);
      preAttributes.set(node, match[1] ?? '');
      return match[2] ?? '';
    }

    // biome-ignore lint/suspicious/noExplicitAny: same as above
    override async format(node: any, lang: string, opts: any) {
      calls.push({ method: 'format', lang, opts });
      const content = await node.content();
      return `<pre${preAttributes.get(node) ?? ''}><code>${content}</code></pre>`;
    }
  };
}

async function convert(source: string, calls: Call[]) {
  const doc = await load(source, {
    safe: 'safe',
    standalone: false,
    attributes: { 'source-highlighter@': 'shiki' },
    syntax_highlighters: { shiki: createAdapter(calls) },
  });
  return doc.convert();
}

describe('Shiki adapter', () => {
  it('calls highlight() and format(), passing highlight() the unescaped source without callouts', async () => {
    const calls: Call[] = [];
    const html = await convert(
      [
        '[source,js,highlight=2..3]',
        '----',
        'if (a < b && c > d) { // <1>',
        '  console.log("<tag>");',
        '  return 1;',
        '}',
        '----',
        '<1> A callout.',
      ].join('\n'),
      calls,
    );

    expect(calls.map((c) => c.method)).toEqual(['format', 'highlight']);
    const highlight = calls.find((c) => c.method === 'highlight');
    expect(highlight?.lang).toBe('js');
    // Not turned into character references, and the <1> callout is removed (the space before it
    // stays)
    expect(highlight?.source).toBe(
      'if (a < b && c > d) { \n  console.log("<tag>");\n  return 1;\n}',
    );
    // The highlight attribute arrives as camelCase highlightLines (not highlight_lines as typed)
    expect(highlight?.opts.highlightLines).toEqual([2, 3]);
    expect(highlight?.opts.callouts).toBeTruthy();

    // Shiki's output is inside <pre>, the line count is kept, and the callout is back at the end of
    // line 1
    expect(html).toMatch(/<pre class="shiki github-dark"[^>]*><code><span class="line">/);
    expect(html.match(/<span class="line">/g)?.length).toBe(4);
    const firstLine = html.split('\n').find((l) => l.includes('class="line"'));
    expect(firstLine).toMatch(/<b class="conum">\(1\)<\/b>/);
    // No double escaping. Shiki writes < as &#x3C;, so a bare <img never appears inside code blocks
    // (image marking relies on this when it scans the HTML with regular expressions)
    expect(html).not.toContain('&amp;');
    expect(html).toContain('&#x3C;tag>');
    // The callout goes back, with the comment marker, outside Shiki's line spans
    expect(firstLine).toMatch(/<\/span><\/span>\/\/ <b class="conum">\(1\)<\/b>$/);
  });

  it('does not call the highlighter for a listing block without a language', async () => {
    const calls: Call[] = [];
    const html = await convert('----\nplain <text>\n----', calls);
    expect(calls).toEqual([]);
    expect(html).toContain('plain &lt;text&gt;');
  });

  it('calls highlight() with a null lang for [source] without a language', async () => {
    const calls: Call[] = [];
    await convert('[source]\n----\nplain\n----', calls);
    const highlight = calls.find((c) => c.method === 'highlight');
    // Without a source-language attribute, the highlighter is called with lang set to null
    expect(highlight?.lang).toBeNull();
  });
});
