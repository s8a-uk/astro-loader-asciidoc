// Builds `headings` from the sections
import type { MarkdownHeading } from 'astro';
import { toPlainText } from './html.js';

interface SectionLike {
  getSections(): SectionLike[];
  getLevel(): number;
  getId(): string | null | undefined;
  getTitle(): string | null | undefined;
}

/** Call after doc.convert() (once substitutions have been applied to the titles) */
export function extractHeadings(doc: { getSections(): unknown[] }): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const walk = (sections: SectionLike[]) => {
    for (const section of sections) {
      const id = section.getId();
      if (id) {
        headings.push({
          depth: section.getLevel() + 1,
          slug: id,
          text: toPlainText(section.getTitle() ?? ''),
        });
      }
      walk(section.getSections());
    }
  };
  walk(doc.getSections() as SectionLike[]);
  return headings;
}
