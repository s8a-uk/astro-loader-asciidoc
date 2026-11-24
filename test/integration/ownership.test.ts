// Id ownership, moved files, files added later and other edge cases. When several files claim the
// same id, the last one by path wins, in full syncs and in the watcher alike
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { type AsciidocLoaderOptions, asciidocLoader } from '../../src/index.js';
import { type FakeContextOptions, FakeProject } from './fake-context.js';

const projects: FakeProject[] = [];
function project(options?: FakeContextOptions) {
  const p = new FakeProject(options);
  projects.push(p);
  return p;
}
afterEach(() => {
  for (const p of projects.splice(0)) p.dispose();
});

const loaderFor = (options: Partial<AsciidocLoaderOptions> = {}) =>
  asciidocLoader({ base: 'notes', syntaxHighlight: false, ...options });

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

type Entry = {
  filePath?: string;
  digest?: string;
  data: Record<string, unknown>;
  rendered: { html: string; metadata: Record<string, unknown> };
};
const entry = (p: FakeProject, id: string) => p.store.get(id) as Entry | undefined;

describe('id ownership', () => {
  it('restores the original entry when a copy with the same slug changes its slug (watcher)', async () => {
    const p = project({ watcher: true });
    p.write('notes/a.adoc', '= Original\n:slug: same\n');
    const loader = loaderFor();
    await loader.load(p.context());
    p.write('notes/b.adoc', '= Copy\n:slug: same\n');
    await p.watcher?.trigger('add', p.path('notes/b.adoc'));
    expect(entry(p, 'same')).toMatchObject({ data: { title: 'Copy' } });
    expect(p.logger.messages('warn')).toEqual([
      'Duplicate id "same" in collection "notes": notes/a.adoc and notes/b.adoc.',
    ]);

    p.write('notes/b.adoc', '= Copy\n:slug: other\n');
    await p.watcher?.trigger('change', p.path('notes/b.adoc'));
    expect(p.store.keys().sort()).toEqual(['other', 'same']);
    expect(entry(p, 'same')).toMatchObject({
      filePath: 'notes/a.adoc',
      data: { title: 'Original' },
    });
  });

  it('restores the original entry when a copy with the same slug is deleted (watcher)', async () => {
    const p = project({ watcher: true });
    p.write('notes/a.adoc', '= Original\n:slug: same\n');
    p.write('notes/b.adoc', '= Copy\n:slug: same\n');
    await loaderFor().load(p.context());
    expect(entry(p, 'same')).toMatchObject({ data: { title: 'Copy' } });

    await p.watcher?.trigger('unlink', p.remove('notes/b.adoc'));
    expect(entry(p, 'same')).toMatchObject({
      filePath: 'notes/a.adoc',
      data: { title: 'Original' },
    });
  });

  it('restores the original entry when a copy is deleted before a full sync', async () => {
    const p = project();
    p.write('notes/a.adoc', '= Original\n:slug: same\n');
    p.write('notes/b.adoc', '= Copy\n:slug: same\n');
    await loaderFor().load(p.context());
    p.remove('notes/b.adoc');
    await loaderFor().load(p.context());
    expect(entry(p, 'same')).toMatchObject({
      filePath: 'notes/a.adoc',
      data: { title: 'Original' },
    });
  });

  it('does not remove an id now owned by another file on unlink (watcher)', async () => {
    const p = project({ watcher: true });
    p.write('notes/a.adoc', '= A\n:slug: x\n');
    await loaderFor().load(p.context());
    // Change the slug of a to y, then let b take x
    p.write('notes/a.adoc', '= A\n:slug: y\n');
    await p.watcher?.trigger('change', p.path('notes/a.adoc'));
    p.write('notes/b.adoc', '= B\n:slug: x\n');
    await p.watcher?.trigger('add', p.path('notes/b.adoc'));
    await p.watcher?.trigger('unlink', p.remove('notes/a.adoc'));
    expect(p.store.keys()).toEqual(['x']);
    expect(entry(p, 'x')).toMatchObject({ filePath: 'notes/b.adoc' });
  });
});

describe('moving files', () => {
  it('reconverts a document with a slug moved deeper with its image, updating filePath and image paths', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A\n:slug: fixed\n\nimage::pic.png[Pic]\n');
    p.write('notes/pic.png', PNG);
    await loaderFor().load(p.context());
    const before = entry(p, 'fixed');

    p.remove('notes/a.adoc');
    p.remove('notes/pic.png');
    p.write('notes/deep/a.adoc', '= A\n:slug: fixed\n\nimage::pic.png[Pic]\n');
    p.write('notes/deep/pic.png', PNG);
    await loaderFor().load(p.context());
    const after = entry(p, 'fixed');
    expect(after?.filePath).toBe('notes/deep/a.adoc');
    expect(after?.digest).not.toBe(before?.digest);
    expect(p.logger.messages('warn')).toEqual([]);
  });
});

describe('reconverts when a missing file is added later', () => {
  it('an image (full sync)', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A\n\nimage::later.png[Later]\n');
    await loaderFor().load(p.context());
    expect(entry(p, 'a')?.rendered.html).toContain('<img src="later.png" alt="Later">');
    expect(p.catalog()['notes/a.adoc']?.deps).toEqual({ 'notes/later.png': false });

    p.write('notes/later.png', PNG);
    await loaderFor().load(p.context());
    expect(entry(p, 'a')?.rendered.html).toContain('__ASTRO_IMAGE_');
    expect(p.catalog()['notes/a.adoc']?.deps).toEqual({ 'notes/later.png': true });
  });

  it('an included file (full sync and watcher)', async () => {
    const p = project({ watcher: true });
    p.write('notes/a.adoc', '= A\n\ninclude::_later.adoc[]\n');
    const loader = loaderFor({ pattern: ['*.adoc', '!_*.adoc'] });
    await loader.load(p.context());
    expect(entry(p, 'a')?.rendered.html).toContain('Unresolved directive');

    p.write('notes/_later.adoc', 'Added later.');
    await p.watcher?.trigger('add', p.path('notes/_later.adoc'));
    expect(entry(p, 'a')?.rendered.html).toContain('Added later.');

    // A full sync also notices the file added later
    const q = project();
    q.write('notes/a.adoc', '= A\n\ninclude::_later.adoc[]\n');
    await loaderFor().load(q.context());
    q.write('notes/_later.adoc', 'Added later.');
    await loaderFor({ pattern: ['*.adoc', '!_*.adoc'] }).load(q.context());
    expect(entry(q, 'a')?.rendered.html).toContain('Added later.');
  });
});

describe('always excludes node_modules', () => {
  it('does not make entries from .adoc files in node_modules under base', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A');
    p.write('notes/node_modules/pkg/readme.adoc', '= Pkg');
    p.write('notes/sub/node_modules/x.adoc', '= X');
    await loaderFor().load(p.context());
    expect(p.store.keys()).toEqual(['a']);
  });
});

describe('when an included file changes during conversion', () => {
  it('computes the digest from the content as included, so the next sync reconverts', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A\n\ninclude::_part.adoc[]\n');
    p.write('notes/_part.adoc', 'v1');
    const partPath = p.path('notes/_part.adoc');
    const converted: number[] = [];
    let rewrite = true;
    const loader = loaderFor({
      pattern: ['*.adoc', '!_*.adoc'],
      asciidoctor: {
        extensions(registry) {
          // biome-ignore lint/suspicious/noExplicitAny: the extension DSL types `this` loosely
          (registry.treeProcessor as any)(function (this: any) {
            this.process(() => {
              converted.push(Date.now());
              // Rewrite the included file after it has been read (after parsing)
              if (rewrite) writeFileSync(partPath, 'v2');
            });
          });
        },
      },
    });
    await loader.load(p.context());
    expect(entry(p, 'a')?.rendered.html).toContain('v1');

    rewrite = false;
    await loader.load(p.context());
    expect(converted).toHaveLength(2);
    expect(entry(p, 'a')?.rendered.html).toContain('v2');
    expect(typeof entry(p, 'a')?.digest).toBe('string');
  });
});

/** A transformHtml that holds the conversion of documents containing BLOCK until release() */
function gate() {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const released = new Promise<void>((r) => {
    release = r;
  });
  const enteredPromise = new Promise<void>((r) => {
    entered = r;
  });
  const transformHtml = async (html: string) => {
    if (html.includes('BLOCK')) {
      entered();
      await released;
    }
    return html;
  };
  return { transformHtml, release: () => release(), entered: enteredPromise };
}

describe('watcher handlers run one at a time', () => {
  it('keeps the second change sent while the first conversion is held', async () => {
    const p = project({ watcher: true });
    p.write('notes/a.adoc', '= A0');
    const g = gate();
    await loaderFor({ transformHtml: g.transformHtml }).load(p.context());

    p.write('notes/a.adoc', '= A1\n\nBLOCK\n');
    const first = p.watcher?.trigger('change', p.path('notes/a.adoc'));
    await g.entered;
    p.write('notes/a.adoc', '= A2');
    const second = p.watcher?.trigger('change', p.path('notes/a.adoc'));
    // Without the queue, the second change would finish first here and the first one would then
    // overwrite it with A1
    await new Promise((r) => setTimeout(r, 300));
    g.release();
    await Promise.all([first, second]);
    expect(entry(p, 'a')?.data.title).toBe('A2');
  });
});

describe('a full sync waits for pending watcher work', () => {
  it('syncs the new content after the held watcher work', async () => {
    const p = project({ watcher: true });
    p.write('notes/a.adoc', '= A0');
    const g = gate();
    const loader = loaderFor({ transformHtml: g.transformHtml });
    await loader.load(p.context());

    p.write('notes/a.adoc', '= A1\n\nBLOCK\n');
    const pending = p.watcher?.trigger('change', p.path('notes/a.adoc'));
    await g.entered;
    p.write('notes/a.adoc', '= A2');
    const sync = loader.load(p.context());
    // Without waiting, the full sync would finish first here and the watcher work would then
    // overwrite it with A1
    await new Promise((r) => setTimeout(r, 300));
    g.release();
    await Promise.all([pending, sync]);
    expect(entry(p, 'a')?.data.title).toBe('A2');
  });
});

describe('duplicate ids', () => {
  it('keeps the last file by path with the same warning over four cached syncs', async () => {
    const p = project();
    p.write('notes/dup1.adoc', '= DUP-ONE\n:slug: dup\n');
    p.write('notes/dup2.adoc', '= DUP-TWO\n:slug: dup\n');
    const message =
      'Duplicate id "dup" in collection "notes": notes/dup1.adoc and notes/dup2.adoc.';
    for (let i = 0; i < 4; i++) {
      p.logger.records.length = 0;
      await loaderFor().load(p.context());
      expect(entry(p, 'dup'), `sync ${i + 1}`).toMatchObject({
        filePath: 'notes/dup2.adoc',
        data: { title: 'DUP-TWO' },
      });
      expect(p.logger.messages('warn'), `sync ${i + 1}`).toEqual([message]);
    }
    // From the second sync on, the winning file is not converted again (nor rewritten to the store)
    expect(p.store.setCalls).toEqual(['dup']);
  });

  it('follows the same rule in the watcher (changing the earlier file keeps the later one)', async () => {
    const p = project({ watcher: true });
    p.write('notes/dup1.adoc', '= DUP-ONE\n:slug: dup\n');
    p.write('notes/dup2.adoc', '= DUP-TWO\n:slug: dup\n');
    await loaderFor().load(p.context());
    p.logger.records.length = 0;
    p.write('notes/dup1.adoc', '= DUP-ONE changed\n:slug: dup\n');
    await p.watcher?.trigger('change', p.path('notes/dup1.adoc'));
    expect(entry(p, 'dup')).toMatchObject({
      filePath: 'notes/dup2.adoc',
      data: { title: 'DUP-TWO' },
    });
    expect(p.logger.messages('warn')).toEqual([
      'Duplicate id "dup" in collection "notes": notes/dup1.adoc and notes/dup2.adoc.',
    ]);
  });
});

describe('state is kept per collection', () => {
  it('does not mix watcher state when one loader is used for two collections', async () => {
    const loader = loaderFor();
    const one = project({ watcher: true });
    one.write('notes/a.adoc', '= One A\n\ninclude::shared.txt[]\n');
    one.write('notes/shared.txt', 'one v1');
    const two = project({ watcher: true });
    two.write('notes/b.adoc', '= Two B');
    await loader.load(one.context('one'));
    await loader.load(two.context('two'));

    one.write('notes/shared.txt', 'one v2');
    await one.watcher?.trigger('change', one.path('notes/shared.txt'));
    expect(entry(one, 'a')?.rendered.html).toContain('one v2');
    expect(two.store.keys()).toEqual(['b']);
  });
});

describe('generateId return value', () => {
  it('throws when it is not a string', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A');
    await expect(
      loaderFor({ generateId: (() => 42) as unknown as () => string }).load(p.context()),
    ).rejects.toThrow(
      '[asciidoc-loader] generateId must return a string, got number for notes/a.adoc.',
    );
  });
});

describe('edge-case input', () => {
  it('symlinked documents and included files', async () => {
    const p = project();
    mkdirSync(p.path('elsewhere'), { recursive: true });
    p.write('elsewhere/real.adoc', '= Linked\n\ninclude::part.txt[]\n');
    p.write('elsewhere/part.txt', 'linked part');
    p.write('notes/a.adoc', '= A\n\ninclude::link.txt[]\n');
    symlinkSync(p.path('elsewhere/part.txt'), p.path('notes/link.txt'));
    symlinkSync(p.path('elsewhere/real.adoc'), p.path('notes/linked.adoc'));
    await loaderFor({ pattern: '*.adoc' }).load(p.context());
    // An include through a symlink is resolved by the link's path and is included even in safe mode
    expect(entry(p, 'a')?.rendered.html).toContain('linked part');
    // A symlinked document resolves includes from the directory of its link path
    // (notes/linked.adoc)
    expect(entry(p, 'linked')?.filePath).toBe('notes/linked.adoc');
    expect(entry(p, 'linked')?.rendered.html).toContain('Unresolved directive');
  });

  it('CRLF and BOM', async () => {
    const p = project();
    p.write('notes/a.adoc', '﻿= Title\r\n:tags: x\r\n\r\n== Section\r\n\r\nText.\r\n');
    await loaderFor().load(p.context());
    expect(entry(p, 'a')?.data).toEqual({ title: 'Title', tags: 'x' });
    expect(entry(p, 'a')?.rendered.metadata.headings).toEqual([
      { depth: 2, slug: 'section', text: 'Section' },
    ]);
  });

  it('treats a !(…) extglob as a pattern, not a negation', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A');
    p.write('notes/draft.adoc', '= Draft');
    await loaderFor({ pattern: '!(draft).adoc' }).load(p.context());
    expect(p.store.keys()).toEqual(['a']);
  });

  it('turns xrefs into site URLs with relfileprefix and relfilesuffix', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A\n\nSee xref:b.adoc[B] and xref:b.adoc#sec[section].\n');
    p.write('notes/b.adoc', '= B\n\n== Sec\n');
    await loaderFor({ attributes: { relfileprefix: '../', relfilesuffix: '/' } }).load(p.context());
    const html = entry(p, 'a')?.rendered.html ?? '';
    expect(html).toContain('<a href="../b/">B</a>');
    expect(html).toContain('<a href="../b/#sec">section</a>');

    const q = project();
    q.write('notes/a.adoc', '= A\n\nSee xref:b.adoc[B].\n');
    await loaderFor().load(q.context());
    expect(entry(q, 'a')?.rendered.html).toContain('<a href="b.html">B</a>');
  });
});
