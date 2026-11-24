// load() end to end, with an in-memory LoaderContext
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AsciidocLoaderOptions } from '../../src/index.js';
import { asciidocLoader } from '../../src/index.js';
import { shikiImporter } from '../../src/shiki.js';
import { createLogger } from '../helpers.js';
import { type FakeContextOptions, FakeProject } from './fake-context.js';

const projects: FakeProject[] = [];
function project(options?: FakeContextOptions) {
  const p = new FakeProject(options);
  projects.push(p);
  return p;
}
afterEach(() => {
  for (const p of projects.splice(0)) p.dispose();
  vi.restoreAllMocks();
});

/** Counts converted files by the number of times the extensions hook is called */
function countingLoader(options: Partial<AsciidocLoaderOptions> = {}) {
  const converted: string[] = [];
  const loader = asciidocLoader({
    syntaxHighlight: false,
    ...options,
    base: options.base ?? 'notes',
    asciidoctor: {
      ...options.asciidoctor,
      extensions(registry, asciidoctor) {
        // biome-ignore lint/suspicious/noExplicitAny: the extension DSL types `this` loosely
        (registry.preprocessor as any)(function (this: any) {
          this.process((doc: { getAttribute(n: string): string }) => {
            converted.push(doc.getAttribute('docname'));
          });
        });
        return options.asciidoctor?.extensions?.(registry, asciidoctor);
      },
    },
  });
  return { loader, converted };
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

describe('initial load', () => {
  it('gives entries id, data, body, filePath, digest and rendered', async () => {
    const p = project();
    p.write('notes/hello.adoc', '= Hello\n:tags: a, b\n:draft:\n\n== Section One\n\nText.\n');
    p.write('notes/sub/index.adoc', '= Sub Index\n\nText.\n');
    const { loader } = countingLoader();
    await loader.load(p.context());

    expect(p.store.keys().sort()).toEqual(['hello', 'sub']);
    const entry = p.store.get('hello') as Record<string, unknown> & {
      rendered: { html: string; metadata: Record<string, unknown> };
    };
    expect(entry).toMatchObject({
      id: 'hello',
      data: { title: 'Hello', tags: 'a, b', draft: true },
      body: '= Hello\n:tags: a, b\n:draft:\n\n== Section One\n\nText.\n',
      filePath: 'notes/hello.adoc',
    });
    expect(typeof entry.digest).toBe('string');
    expect(entry.rendered.html).toContain('<h2 id="section-one">Section One</h2>');
    expect(entry.rendered.html).not.toContain('<h1');
    expect(entry.rendered.metadata).toEqual({
      headings: [{ depth: 2, slug: 'section-one', text: 'Section One' }],
      frontmatter: { title: 'Hello', tags: 'a, b', draft: true },
    });
    expect(entry).not.toHaveProperty('assetImports');
    expect(p.catalog()).toEqual({
      'notes/hello.adoc': { id: 'hello', digest: entry.digest, deps: {} },
      'notes/sub/index.adoc': { id: 'sub', digest: expect.any(String), deps: {} },
    });
  });

  it('passes the absolute path to parseData and uses its return value as data', async () => {
    const calls: unknown[] = [];
    const p = project({
      parseData: (async (props: {
        id: string;
        data: Record<string, unknown>;
        filePath?: string;
      }) => {
        calls.push(props);
        return { ...props.data, parsed: true };
      }) as never,
    });
    p.write('notes/a.adoc', '= A\n\nx');
    const { loader } = countingLoader();
    await loader.load(p.context());
    expect(calls).toEqual([{ id: 'a', data: { title: 'A' }, filePath: p.path('notes/a.adoc') }]);
    expect(p.store.get('a')).toMatchObject({ data: { title: 'A', parsed: true } });
  });

  it('warns when base does not exist or no file matches', async () => {
    const p = project();
    await countingLoader().loader.load(p.context());
    expect(p.logger.messages('warn')).toEqual(['The base directory "notes" does not exist.']);

    const q = project();
    q.write('notes/readme.txt', 'x');
    await countingLoader().loader.load(q.context());
    expect(q.logger.messages('warn')).toEqual([
      'No files found matching "**/*.adoc, !**/_*, !**/_*/**" in "notes".',
    ]);
  });

  it('excludes files and directories starting with _ by default, but they can still be included', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A\n\ninclude::_partial.adoc[]\n\ninclude::_parts/x.adoc[]\n');
    p.write('notes/_partial.adoc', 'Partial body.');
    p.write('notes/_parts/x.adoc', 'Parts body.');
    p.write('notes/sub/_y.adoc', '= Y');
    p.write('notes/sub/_deep/z.adoc', '= Z');
    p.write('notes/sub/b_c.adoc', '= B');
    const { loader } = countingLoader();
    await loader.load(p.context());
    expect(p.store.keys().sort()).toEqual(['a', 'sub/b_c']);
    const html = (p.store.get('a') as { rendered: { html: string } }).rendered.html;
    expect(html).toContain('Partial body.');
    expect(html).toContain('Parts body.');
  });

  it('makes files starting with _ entries when pattern is set', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A');
    p.write('notes/_partial.adoc', '= P');
    p.write('notes/_parts/x.adoc', '= X');
    const { loader } = countingLoader({ pattern: '**/*.adoc' });
    await loader.load(p.context());
    expect(p.store.keys().sort()).toEqual(['_partial', '_parts/x', 'a']);
  });

  it('excludes files with a negated pattern', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A');
    p.write('notes/_partials/p.adoc', 'partial');
    const { loader } = countingLoader({ pattern: ['**/*.adoc', '!_partials'] });
    await loader.load(p.context());
    expect(p.store.keys()).toEqual(['a']);
  });
});

describe('incremental updates', () => {
  it('does not convert unchanged files on the second load()', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A');
    p.write('notes/b.adoc', '= B');
    const { loader, converted } = countingLoader();
    await loader.load(p.context());
    expect(converted.sort()).toEqual(['a', 'b']);

    converted.length = 0;
    p.write('notes/b.adoc', '= B changed');
    await loader.load(p.context());
    expect(converted).toEqual(['b']);
    expect(p.store.get('b')).toMatchObject({ data: { title: 'B changed' } });
  });

  it('skips unchanged files with another loader instance when meta and store remain (across builds)', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A');
    await countingLoader().loader.load(p.context());
    const second = countingLoader();
    await second.loader.load(p.context());
    expect(second.converted).toEqual([]);
    expect(p.store.keys()).toEqual(['a']);
  });

  it('removes the entry when its file is deleted before load()', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A');
    p.write('notes/b.adoc', '= B');
    const { loader } = countingLoader();
    await loader.load(p.context());
    p.remove('notes/b.adoc');
    await loader.load(p.context());
    expect(p.store.keys()).toEqual(['a']);
    expect(Object.keys(p.catalog())).toEqual(['notes/a.adoc']);
  });

  it('reconverts when only an included file changes before load()', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A\n\ninclude::shared.txt[]\n');
    p.write('notes/shared.txt', 'first version');
    const { loader, converted } = countingLoader();
    await loader.load(p.context());
    expect(Object.keys(p.catalog()['notes/a.adoc']?.deps ?? {})).toEqual(['notes/shared.txt']);

    converted.length = 0;
    await loader.load(p.context());
    expect(converted).toEqual([]);

    p.write('notes/shared.txt', 'second version');
    await loader.load(p.context());
    expect(converted).toEqual(['a']);
    expect((p.store.get('a') as { rendered: { html: string } }).rendered.html).toContain(
      'second version',
    );
  });

  it('reconverts everything when the options change', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A');
    p.write('notes/b.adoc', '= B');
    await countingLoader().loader.load(p.context());
    const changed = countingLoader({ attributes: { icons: 'font' } });
    await changed.loader.load(p.context());
    expect(changed.converted.sort()).toEqual(['a', 'b']);
  });

  it('removes the old id when the slug attribute changes', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A\n:slug: first\n');
    const { loader } = countingLoader();
    await loader.load(p.context());
    expect(p.store.keys()).toEqual(['first']);
    p.write('notes/a.adoc', '= A\n:slug: second\n');
    await loader.load(p.context());
    expect(p.store.keys()).toEqual(['second']);
  });

  it('accepts a custom generateId and throws when it returns an empty string', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A');
    await asciidocLoader({
      base: 'notes',
      syntaxHighlight: false,
      generateId: ({ entry, data }) => `${entry}:${data.title}`,
    }).load(p.context());
    expect(p.store.keys()).toEqual(['a.adoc:A']);

    await expect(
      asciidocLoader({ base: 'notes', syntaxHighlight: false, generateId: () => '' }).load(
        project().context(),
      ),
    ).resolves.toBeUndefined();
    const q = project();
    q.write('notes/a.adoc', '= A');
    await expect(
      asciidocLoader({ base: 'notes', syntaxHighlight: false, generateId: () => '' }).load(
        q.context(),
      ),
    ).rejects.toThrow('[asciidoc-loader] generateId returned an empty id for notes/a.adoc.');
  });
});

describe('duplicate ids', () => {
  const setup = (behavior: 'error' | 'warn' | 'ignore') => {
    const p = project({ prerenderConflictBehavior: behavior });
    p.write('notes/a.adoc', '= A\n:slug: same\n');
    p.write('notes/b.adoc', '= B\n:slug: same\n');
    return p;
  };
  // Files are applied in path order, so a.adoc comes first and b.adoc second. The last file by path
  // wins the id
  const message = 'Duplicate id "same" in collection "notes": notes/a.adoc and notes/b.adoc.';

  it('throws with error', async () => {
    const p = setup('error');
    await expect(countingLoader().loader.load(p.context())).rejects.toThrow(
      `[asciidoc-loader] ${message}`,
    );
  });

  it('warns with warn and keeps the last file by path', async () => {
    const p = setup('warn');
    await countingLoader().loader.load(p.context());
    expect(p.logger.messages('warn')).toEqual([message]);
    expect(p.store.keys()).toEqual(['same']);
    expect(p.store.get('same')).toMatchObject({ filePath: 'notes/b.adoc', data: { title: 'B' } });
  });

  it('does nothing with ignore', async () => {
    const p = setup('ignore');
    await countingLoader().loader.load(p.context());
    expect(p.logger.messages('warn')).toEqual([]);
  });
});

describe('error handling', () => {
  const failing: Partial<AsciidocLoaderOptions> = {
    asciidoctor: {
      extensions(registry) {
        // biome-ignore lint/suspicious/noExplicitAny: the extension DSL types `this` loosely
        (registry.treeProcessor as any)(function (this: any) {
          this.process((doc: { getAttribute(n: string): string }) => {
            if (doc.getAttribute('fail') != null) throw new Error('conversion exploded');
          });
        });
      },
    },
  };

  it('throws with the file path when a conversion fails in a build (no watcher)', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A\n:fail:\n');
    const error = await countingLoader(failing)
      .loader.load(p.context())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      '[asciidoc-loader] Failed to convert notes/a.adoc: conversion exploded',
    );
    expect(((error as Error).cause as Error).message).toBe('conversion exploded');
  });

  it('logs to logger.error and keeps the previous content in dev (with a watcher)', async () => {
    const p = project({ watcher: true });
    p.write('notes/a.adoc', '= A\n');
    const { loader } = countingLoader(failing);
    await loader.load(p.context());
    p.write('notes/a.adoc', '= A broken\n:fail:\n');
    await loader.load(p.context());
    expect(p.logger.messages('error')).toEqual([
      'Failed to convert notes/a.adoc: conversion exploded',
    ]);
    expect(p.store.get('a')).toMatchObject({ data: { title: 'A' } });
  });

  it('propagates errors from parseData as they are', async () => {
    const schemaError = new Error('schema says no');
    const p = project({
      watcher: true,
      parseData: async () => {
        throw schemaError;
      },
    });
    p.write('notes/a.adoc', '= A');
    await expect(countingLoader().loader.load(p.context())).rejects.toBe(schemaError);
  });

  it('treats transformHtml errors like conversion errors and throws when it returns a non-string', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A');
    await expect(
      countingLoader({
        transformHtml: () => {
          throw new Error('hook failed');
        },
      }).loader.load(p.context()),
    ).rejects.toThrow('[asciidoc-loader] Failed to convert notes/a.adoc: hook failed');
    await expect(
      countingLoader({ transformHtml: (() => 1) as never }).loader.load(p.context()),
    ).rejects.toThrow('transformHtml must return a string, got number.');
  });

  it('logs unreadable files to logger.error and skips them', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A');
    p.write('notes/dir.adoc/inner.txt', 'x'); // dir.adoc is a directory
    const { loader } = countingLoader({ pattern: ['*.adoc', 'dir.adoc'] });
    await loader.load(p.context());
    expect(p.store.keys()).toEqual(['a']);
  });
});

describe('output options', () => {
  it('omits body with retainBody: false', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A');
    await countingLoader({ retainBody: false }).loader.load(p.context());
    expect(p.store.get('a')).not.toHaveProperty('body');
  });

  it('marks images and sets imagePaths and assetImports, but not with images: false', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A\n\nimage::pic.png[Pic]\n\nimage::missing.png[]\n');
    p.write('notes/pic.png', PNG);
    await countingLoader().loader.load(p.context());
    const entry = p.store.get('a') as Record<string, never> & {
      rendered: { html: string; metadata: Record<string, unknown> };
    };
    expect(entry.rendered.html).toContain('__ASTRO_IMAGE_=');
    expect(entry.rendered.metadata.imagePaths).toEqual(['./pic.png']);
    expect(entry.assetImports).toEqual(['./pic.png']);
    expect(p.logger.messages('warn')).toEqual([
      'notes/a.adoc: image "missing.png" was not found and is left as is.',
    ]);

    const q = project();
    q.write('notes/a.adoc', '= A\n\nimage::pic.png[Pic]\n');
    q.write('notes/pic.png', PNG);
    await countingLoader({ images: false }).loader.load(q.context());
    const plain = q.store.get('a') as Record<string, never> & {
      rendered: { html: string; metadata: Record<string, unknown> };
    };
    expect(plain.rendered.html).toContain('<img src="pic.png" alt="Pic">');
    expect(plain.rendered.metadata).not.toHaveProperty('imagePaths');
    expect(plain).not.toHaveProperty('assetImports');
  });

  it('passes transformHtml the HTML before image marking and marks its result', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A\n:tags: x\n\nimage::pic.png[Pic]\n');
    p.write('notes/pic.png', PNG);
    p.write('notes/extra.png', PNG);
    const seen: unknown[] = [];
    await countingLoader({
      transformHtml(html, context) {
        seen.push({ html, context: { ...context, logger: typeof context.logger } });
        return `${html}<img src="extra.png" alt="added">`;
      },
    }).loader.load(p.context());
    expect(seen).toEqual([
      {
        html: expect.stringContaining('<img src="pic.png" alt="Pic">'),
        context: {
          id: 'a',
          collection: 'notes',
          filePath: p.path('notes/a.adoc'),
          data: { title: 'A', tags: 'x' },
          logger: 'object',
        },
      },
    ]);
    expect(p.store.get('a')).toMatchObject({ assetImports: ['./pic.png', './extra.png'] });
  });

  it('takes the Shiki config from markdown.shikiConfig and lets the options override it', async () => {
    const p = project({ shikiConfig: { theme: 'nord' } });
    p.write('notes/a.adoc', '= A\n\n[source,js]\n----\nlet a;\n----\n');
    await asciidocLoader({ base: 'notes' }).load(p.context());
    expect((p.store.get('a') as { rendered: { html: string } }).rendered.html).toContain(
      '<pre class="astro-code nord"',
    );

    const q = project({ shikiConfig: { theme: 'nord' } });
    q.write('notes/a.adoc', '= A\n\n[source,js]\n----\nlet a;\n----\n');
    await asciidocLoader({ base: 'notes', shikiConfig: { theme: 'github-light' } }).load(
      q.context(),
    );
    expect((q.store.get('a') as { rendered: { html: string } }).rendered.html).toContain(
      '<pre class="astro-code github-light"',
    );
  });

  it('warns once that shikiConfig is unused when passed with syntaxHighlight: false', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A\n\n[source,js]\n----\nlet a;\n----\n');
    const loader = asciidocLoader({
      base: 'notes',
      syntaxHighlight: false,
      shikiConfig: { theme: 'nord' },
    });
    await loader.load(p.context());
    await loader.load(p.context());
    expect(p.logger.messages('warn')).toEqual([
      'The "shikiConfig" option is ignored because "syntaxHighlight" is false.',
    ]);
    expect((p.store.get('a') as { rendered: { html: string } }).rendered.html).not.toContain(
      'astro-code',
    );
  });

  it('throws an error with guidance when shiki cannot be loaded', async () => {
    vi.spyOn(shikiImporter, 'load').mockRejectedValue(new Error('Cannot find package "shiki"'));
    const p = project({ watcher: true });
    p.write('notes/a.adoc', '= A');
    const error = await asciidocLoader({ base: 'notes' })
      .load(p.context())
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      '[asciidoc-loader] Syntax highlighting is enabled, but the "shiki" package could not be loaded.\n' +
        'Install it (for example: npm install shiki), or disable highlighting with `syntaxHighlight: false`.',
    );
    expect(((error as Error).cause as Error).message).toBe('Cannot find package "shiki"');
  });

  it('passes Asciidoctor warnings and errors to the logger and still stores the entry', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A\n\ninclude::nothing.adoc[]\n');
    const logger = createLogger();
    p.logger = logger;
    await countingLoader().loader.load(p.context());
    expect(logger.messages('error')).toEqual([
      expect.stringMatching(/^notes\/a\.adoc:3: include file not found: /),
    ]);
    expect(p.store.keys()).toEqual(['a']);
  });
});

describe('output does not depend on the order in which parallel work completes', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];

  /** Makes files that come earlier by path finish later */
  function reversedCompletion(extra: Partial<AsciidocLoaderOptions> = {}) {
    return countingLoader({
      ...extra,
      async transformHtml(html, context) {
        await sleep((names.length - names.indexOf(context.id)) * 15);
        context.logger.warn(`transform ${context.id}`);
        return html;
      },
    });
  }

  it('writes the store, the meta catalog and the logs in path order', async () => {
    const p = project();
    for (const name of [...names].reverse()) p.write(`notes/${name}.adoc`, `= ${name}`);
    await reversedCompletion().loader.load(p.context());
    expect(p.store.setCalls).toEqual(names);
    expect(p.store.keys()).toEqual(names);
    expect(Object.keys(p.catalog())).toEqual(names.map((n) => `notes/${n}.adoc`));
    expect(p.logger.messages('warn')).toEqual(names.map((n) => `transform ${n}`));
  });

  it('throws the error of the first file by path when several files fail', async () => {
    const p = project();
    for (const name of names) p.write(`notes/${name}.adoc`, `= ${name}\n:fail:\n`);
    const failing = reversedCompletion({
      asciidoctor: {
        extensions(registry) {
          // biome-ignore lint/suspicious/noExplicitAny: the extension DSL types `this` loosely
          (registry.treeProcessor as any)(function (this: any) {
            this.process((doc: { getAttribute(n: string): string }) => {
              throw new Error(`failed ${doc.getAttribute('docname')}`);
            });
          });
        },
      },
    });
    for (let i = 0; i < 3; i++) {
      await expect(failing.loader.load(p.context())).rejects.toThrow(
        '[asciidoc-loader] Failed to convert notes/a.adoc: failed a',
      );
    }
  });

  it('warns about an unknown Shiki language only once across files', async () => {
    const p = project();
    const doc = '= T\n\n[source,nosuchlang]\n----\nx\n----\n';
    for (const name of names) p.write(`notes/${name}.adoc`, doc);
    await asciidocLoader({ base: 'notes' }).load(p.context());
    expect(p.logger.messages('warn')).toEqual([
      'Unknown language "nosuchlang"; falling back to plaintext.',
    ]);
  });
});
