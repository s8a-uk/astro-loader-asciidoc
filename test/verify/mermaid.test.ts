// Verifies the Asciidoctor.js behavior that the Mermaid support relies on: a block extension can
// take listing and literal blocks marked [mermaid], and the content of the pass block it creates is
// output without substitutions.
import { Extensions, load, type Registry } from '@asciidoctor/core';
import { describe, expect, it } from 'vitest';

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// Same approach as registerMermaid in src/mermaid.ts
function createRegistry() {
  return Extensions.create(null, function (this: Registry) {
    // biome-ignore lint/suspicious/noExplicitAny: the DSL's this type is outside what this verifies
    this.block(function (this: any) {
      this.named('mermaid');
      this.onContexts('listing', 'literal');
      this.parseContentAs('raw');
      // biome-ignore lint/suspicious/noExplicitAny: same as above
      this.process((parent: unknown, reader: any, attrs: Record<string, unknown>) => {
        const source = reader.getLines().join('\n');
        const id = attrs.id ? ` id="${escapeHtml(String(attrs.id))}"` : '';
        const role = attrs.role ? ` ${escapeHtml(String(attrs.role))}` : '';
        return this.createBlock(
          parent,
          'pass',
          `<pre${id} class="mermaid${role}">${escapeHtml(source)}</pre>`,
        );
      });
    });
  });
}

async function convert(source: string, withExtension = true) {
  const doc = await load(source, {
    safe: 'safe',
    standalone: false,
    ...(withExtension ? { extension_registry: createRegistry() } : {}),
  });
  return doc.convert();
}

const diagram = ['graph TD', '  A[Start & "go"] --> B{x < y}', '  B -->|*yes*| C'];

describe('Mermaid block extension', () => {
  it('takes a listing block (----) and outputs it escaped without substitutions', async () => {
    const html = await convert(['[mermaid]', '----', ...diagram, '----'].join('\n'));
    expect(html.trim()).toBe(
      '<pre class="mermaid">graph TD\n  A[Start &amp; &quot;go&quot;] --&gt; B{x &lt; y}\n  B --&gt;|*yes*| C</pre>',
    );
  });

  it('also takes a literal block (....)', async () => {
    const html = await convert(['[mermaid]', '....', ...diagram, '....'].join('\n'));
    expect(html.trim()).toMatch(/^<pre class="mermaid">graph TD\n/);
  });

  it('outputs id and role but not the title', async () => {
    const html = await convert(
      ['.Flow', '[mermaid#flow.wide]', '----', 'graph TD', '----'].join('\n'),
    );
    expect(html.trim()).toBe('<pre id="flow" class="mermaid wide">graph TD</pre>');
  });

  it('does not replace attribute references ({name}) either', async () => {
    const html = await convert(
      [':name: value', '', '[mermaid]', '----', 'A[{name}]', '----'].join('\n'),
    );
    expect(html).toContain('<pre class="mermaid">A[{name}]</pre>');
  });

  it('yields a normal listing block when the extension is not registered', async () => {
    const html = await convert(['[mermaid]', '----', 'graph TD', '----'].join('\n'), false);
    expect(html).toContain('<div class="listingblock">');
    expect(html).toContain('<pre>graph TD</pre>');
    expect(html).not.toContain('class="mermaid');
  });
});
