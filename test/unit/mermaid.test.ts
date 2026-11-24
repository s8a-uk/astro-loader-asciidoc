import { describe, expect, it } from 'vitest';
import { convert } from '../helpers.js';

const diagram = ['graph TD', '  A[Start & "go"] --> B{x < y}', '  B -->|*yes*| C{attr}'];
const mermaid = { loaderOptions: { mermaid: true } };

describe('Mermaid', () => {
  it('turns a listing block into <pre class="mermaid">, escaping it without substitutions', async () => {
    const { html } = await convert(['[mermaid]', '----', ...diagram, '----'].join('\n'), mermaid);
    expect(html.trim()).toBe(
      '<pre class="mermaid">graph TD\n  A[Start &amp; &quot;go&quot;] --&gt; B{x &lt; y}\n  B --&gt;|*yes*| C{attr}</pre>',
    );
  });

  it('also accepts a literal block', async () => {
    const { html } = await convert(['[mermaid]', '....', 'graph LR', '....'].join('\n'), mermaid);
    expect(html.trim()).toBe('<pre class="mermaid">graph LR</pre>');
  });

  it('outputs id and role but not the title', async () => {
    const { html } = await convert(
      ['.Flow', '[mermaid#flow.wide]', '----', 'graph TD', '----'].join('\n'),
      mermaid,
    );
    expect(html.trim()).toBe('<pre id="flow" class="mermaid wide">graph TD</pre>');
  });

  it('leaves a normal block when disabled, so users can register an extension of the same name', async () => {
    const plain = await convert(['[mermaid]', '----', 'graph TD', '----'].join('\n'));
    expect(plain.html).toContain('<div class="listingblock">');
    expect(plain.html).not.toContain('class="mermaid');

    const custom = await convert(['[mermaid]', '----', 'graph TD', '----'].join('\n'), {
      loaderOptions: {
        asciidoctor: {
          extensions(registry) {
            // biome-ignore lint/suspicious/noExplicitAny: the DSL's this type is loose
            (registry.block as any)(function (this: any) {
              this.named('mermaid');
              this.onContext('listing');
              this.process((parent: unknown) =>
                this.createBlock(parent, 'pass', '<div class="kroki">diagram</div>'),
              );
            });
          },
        },
      },
    });
    expect(custom.html.trim()).toBe('<div class="kroki">diagram</div>');
  });
});
