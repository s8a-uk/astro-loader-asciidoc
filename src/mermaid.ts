// Block extension for Mermaid
import type { Registry } from '@asciidoctor/core';
import { escapeHtml } from './html.js';

interface BlockDsl {
  named(name: string): void;
  onContexts(...contexts: string[]): void;
  parseContentAs(model: string): void;
  process(
    fn: (
      parent: unknown,
      reader: { getLines(): string[] },
      attrs: Record<string, unknown>,
    ) => unknown,
  ): void;
  createBlock(parent: unknown, context: string, source: string, attrs?: unknown): unknown;
}

/** Turns listing and literal blocks with the [mermaid] style into <pre class="mermaid"> */
export function registerMermaid(registry: Registry): void {
  const register = registry.block as unknown as (fn: (this: BlockDsl) => void) => unknown;
  register.call(registry, function (this: BlockDsl) {
    this.named('mermaid');
    this.onContexts('listing', 'literal');
    this.parseContentAs('raw');
    this.process((parent, reader, attrs) => {
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
}
