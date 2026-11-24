import { describe, expect, it } from 'vitest';
import { convert, createLogger } from '../helpers.js';

const code = (lang: string, body: string[], attrs = '') =>
  [`[source,${lang}${attrs}]`, '----', ...body, '----'].join('\n');

function preTag(html: string): string {
  return /<pre[^>]*>/.exec(html)?.[0] ?? '';
}

describe('Shiki adapter', () => {
  it('outputs the astro-code class, data-language, theme colors and the default wrap style', async () => {
    const { html } = await convert(code('js', ['const a = 1;']), {
      shiki: { theme: 'github-dark' },
    });
    expect(preTag(html)).toBe(
      '<pre class="astro-code github-dark" style="background-color:#24292e;color:#e1e4e8; overflow-x: auto;" tabindex="0" data-language="js">',
    );
    expect(html).toContain(
      '<div class="listingblock">\n<div class="content">\n<pre class="astro-code',
    );
    // Token boundaries are not asserted. When tokenizing a line exceeds tokenizeTimeLimit (500 ms
    // by default), Shiki puts the rest of the line into a single token. The first tokenization
    // includes compiling the regular expressions and can exceed the limit under heavy load (on any
    // Node version; Astro's Markdown runs with the same default)
    expect(html).toMatch(/<span class="line"><span style="color:#F97583">const/);
  });

  it('supports multiple themes', async () => {
    const { html } = await convert(code('js', ['let x;']), {
      shiki: { themes: { light: 'github-light', dark: 'github-dark' } },
    });
    expect(preTag(html)).toMatch(
      /^<pre class="astro-code astro-code-themes github-light github-dark"/,
    );
    expect(html).toContain('--shiki-dark:');
  });

  it('uses --astro-code- variables for the css-variables theme', async () => {
    const { html } = await convert(code('js', ['let x;']), { shiki: { theme: 'css-variables' } });
    expect(html).toContain('var(--astro-code-');
  });

  it('handles wrap: true and wrap: null', async () => {
    const wrapped = await convert(code('js', ['x']), { shiki: { wrap: true } });
    expect(preTag(wrapped.html)).toContain(
      '; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word;"',
    );
    const none = await convert(code('js', ['x']), { shiki: { wrap: null } });
    expect(preTag(none.html)).not.toContain('overflow-x');
  });

  it('warns once and falls back to plaintext for an unknown language', async () => {
    const logger = createLogger();
    const { html } = await convert(code('nosuchlang', ['a < b']), { shiki: {}, logger });
    expect(preTag(html)).toContain('data-language="plaintext"');
    expect(html).toContain('a &#x3C; b');
    expect(logger.messages('warn')).toEqual([
      'Unknown language "nosuchlang"; falling back to plaintext.',
    ]);
  });

  it('resolves language names with langAlias', async () => {
    const { html } = await convert(code('myjs', ['const a = 1;']), {
      shiki: { langAlias: { myjs: 'javascript' } },
    });
    expect(html).toMatch(/<span style="color:#F97583">const/);
  });

  it('moves callouts back to the end of the line and keeps the line count', async () => {
    const { html } = await convert(
      [code('js', ['const a = 1; // <1>', 'const b = 2; // <2>']), '<1> One', '<2> Two'].join('\n'),
      { shiki: {} },
    );
    expect(html.match(/<span class="line">/g)).toHaveLength(2);
    expect(html).toContain('<b class="conum">(1)</b>');
    expect(html).toContain('<b class="conum">(2)</b>');
    expect(html).toContain('<div class="colist arabic">');
  });

  it('adds the highlighted class to the lines in the highlight attribute', async () => {
    const { html } = await convert(code('js', ['a', 'b', 'c'], ',highlight=2..3'), { shiki: {} });
    expect(html.match(/<span class="line highlighted">/g)).toHaveLength(2);
    expect(html).toMatch(/^<pre[^>]*><code><span class="line"><span/m);
  });

  it('runs user transformers after the loader transformers', async () => {
    const { html } = await convert(code('js', ['x']), {
      shiki: {
        transformers: [
          {
            pre(node) {
              node.properties['data-custom'] = String(node.properties.class);
            },
          },
        ],
      },
    });
    expect(preTag(html)).toContain('data-custom="astro-code github-dark"');
  });

  it('does not highlight a listing block without a language', async () => {
    const { html } = await convert('----\nplain <x>\n----', { shiki: {} });
    expect(html).toContain('<pre>plain &lt;x&gt;</pre>');
  });

  it('highlights [source] without a language as plaintext', async () => {
    const { html } = await convert('[source]\n----\nplain\n----', { shiki: {} });
    expect(preTag(html)).toContain('data-language="plaintext"');
  });

  it('lets the document unset source-highlighter', async () => {
    const { html } = await convert(`:source-highlighter!:\n\n${code('js', ['x'])}`, { shiki: {} });
    expect(html).not.toContain('astro-code');
  });
});
