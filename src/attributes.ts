// Builds the raw `data` from the document header attributes
import type { Document } from '@asciidoctor/core';
import { decodeEntities, toPlainText } from './html.js';

/**
 * Name rules for attributes that Asciidoctor derives from the values of header attributes
 * (for example `:doctype: book` gives `doctype-book`, and `:toc: right` gives `toc-position`).
 * They are not in the empty baseline document, so comparing keys does not remove them.
 */
export const DERIVED_ATTRIBUTE_PREFIXES: readonly string[] = [
  'doctype-',
  'backend-',
  'basebackend-',
  'filetype-',
];

export const DERIVED_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set([
  'toc-position',
  'toc-class',
  'mantitle',
  'manvolnum',
  'manname',
  'mannames',
  'manname-title',
  'manname-id',
  'manpurpose',
]);

export function isDerivedAttribute(name: string): boolean {
  return (
    DERIVED_ATTRIBUTE_NAMES.has(name) ||
    DERIVED_ATTRIBUTE_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** The document title (the `=` line), or undefined. Ignores the `:title:` attribute and sections */
export function headerTitle(doc: Document): string | undefined {
  if (!doc.hasHeader()) return undefined;
  const title = (doc.getHeader() as { getTitle(): string | null | undefined } | null)?.getTitle();
  return typeof title === 'string' && title !== '' ? toPlainText(title) : undefined;
}

export function toData(doc: Document, baselineKeys: ReadonlySet<string>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const attributes = doc.getAttributes() as Record<string, unknown>;
  for (const [key, value] of Object.entries(attributes)) {
    if (baselineKeys.has(key) || key === 'doctitle' || isDerivedAttribute(key)) continue;
    // Values contain the character references (`&amp;` and so on) that Asciidoctor adds when it
    // substitutes header values. Decode them so that values read like Markdown frontmatter, as
    // written in the source. Tags are not removed.
    if (value === '') data[key] = true;
    else data[key] = typeof value === 'string' ? decodeEntities(value) : value;
  }
  const title = headerTitle(doc);
  if (title !== undefined) data.title = title;
  return data;
}
