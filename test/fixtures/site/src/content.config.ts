import { defineCollection } from 'astro:content';
import { asciidocLoader } from '@s8a-uk/astro-loader-asciidoc';
import { z } from 'astro/zod';

const notes = defineCollection({
  loader: asciidocLoader({
    base: './src/content/notes',
    mermaid: true,
  }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    tags: z
      .string()
      .default('')
      .transform((s) =>
        s
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    // `:draft:` (no value) is true and `:draft: false` is the string 'false'; accept both
    draft: z.union([z.boolean(), z.stringbool()]).default(false),
    description: z.string().optional(),
  }),
});

export const collections = { notes };
