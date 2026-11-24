// Regression tests for sync bugs found before the first release: an image in use that is deleted
// (a cached build failed with ImageNotFound and dev did not reconvert), one failing document in a
// dev update stopping the rest, and an entry kept after a failed conversion surviving its file's
// deletion
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

const html = (p: FakeProject, id: string) =>
  (p.store.get(id) as { rendered: { html: string } } | undefined)?.rendered.html;

describe('removing an image in use reconverts the document and keeps a plain <img>', () => {
  it('in a cached build', async () => {
    const p = project();
    p.write('notes/a.adoc', '= A\n\nimage::pic.png[Pic]\n');
    p.write('notes/pic.png', PNG);
    await loaderFor().load(p.context());
    expect(html(p, 'a')).toContain('__ASTRO_IMAGE_');

    p.remove('notes/pic.png');
    await loaderFor().load(p.context());
    expect(html(p, 'a')).not.toContain('__ASTRO_IMAGE_');
    expect(html(p, 'a')).toContain('<img src="pic.png" alt="Pic">');
    expect(p.logger.messages('warn')).toEqual([
      'notes/a.adoc: image "pic.png" was not found and is left as is.',
    ]);
  });

  it('in dev (unlink)', async () => {
    const p = project({ watcher: true });
    p.write('notes/a.adoc', '= A\n\nimage::pic.png[Pic]\n');
    p.write('notes/pic.png', PNG);
    await loaderFor().load(p.context());

    await p.watcher?.trigger('unlink', p.remove('notes/pic.png'));
    expect(html(p, 'a')).not.toContain('__ASTRO_IMAGE_');
    expect(p.logger.messages('info')).toEqual(['Reloaded notes/a.adoc']);
  });
});

describe('in dev, one failing document does not block updates to the others', () => {
  it('updates the other dependents when one of them fails parseData after a shared include changes', async () => {
    let reject = false;
    const p = project({
      watcher: true,
      parseData: async ({ id, data }) => {
        if (reject && id === 'b') throw new Error('invalid data in b');
        return data;
      },
    });
    for (const name of ['a', 'b', 'c'])
      p.write(`notes/${name}.adoc`, `= ${name}\n\ninclude::_shared.adoc[]\n`);
    p.write('notes/_shared.adoc', 'Shared v1.');
    await loaderFor().load(p.context());
    const metaBefore = p.meta.get(META_KEY_OF(p));

    reject = true;
    p.write('notes/_shared.adoc', 'Shared v2.');
    await p.watcher?.trigger('change', p.path('notes/_shared.adoc'));
    expect(html(p, 'a')).toContain('Shared v2.');
    expect(html(p, 'b')).toContain('Shared v1.');
    expect(html(p, 'c')).toContain('Shared v2.');
    expect(p.logger.messages('error')).toEqual([expect.stringContaining('invalid data in b')]);
    expect(p.logger.messages('info')).toEqual(['Reloaded notes/a.adoc, notes/c.adoc']);
    // The index is saved too (it changes because the included file's content changed)
    expect(p.meta.get(META_KEY_OF(p))).not.toBe(metaBefore);
  });
});

describe('in dev, deleting a file that failed to convert removes the entry it kept', () => {
  it('unlink after a failure in a full sync', async () => {
    const p = project({ watcher: true });
    const loader = loaderFor({
      transformHtml: (h) => {
        if (h.includes('boom')) throw new Error('hook failed');
        return h;
      },
    });
    p.write('notes/a.adoc', '= A\n');
    p.write('notes/b.adoc', '= B\n');
    await loader.load(p.context());

    p.write('notes/a.adoc', '= A\n\nboom\n');
    await loader.load(p.context());
    expect(p.logger.messages('error')).toEqual(['Failed to convert notes/a.adoc: hook failed']);
    expect(p.store.keys().sort()).toEqual(['a', 'b']);

    await p.watcher?.trigger('unlink', p.remove('notes/a.adoc'));
    expect(p.store.keys()).toEqual(['b']);
  });
});

/** The meta key is an implementation detail, so take the single key the loader wrote */
function META_KEY_OF(p: FakeProject): string {
  const keys = [...p.meta.keys()];
  if (keys.length !== 1) throw new Error(`unexpected meta keys: ${keys.join(', ')}`);
  return keys[0] as string;
}
