// The file watcher in astro dev
import { afterEach, describe, expect, it } from 'vitest';
import { asciidocLoader } from '../../src/index.js';
import { FakeProject } from './fake-context.js';

const projects: FakeProject[] = [];
afterEach(() => {
  for (const p of projects.splice(0)) p.dispose();
});

async function setup() {
  const p = new FakeProject({ watcher: true });
  projects.push(p);
  p.write('notes/a.adoc', '= A\n\ninclude::shared.adoc[]\n');
  p.write('notes/b.adoc', '= B\n\ninclude::shared.adoc[]\n');
  p.write('notes/shared.adoc', 'Shared v1.');
  p.write('outside/c.txt', 'outside');
  const loader = asciidocLoader({
    base: 'notes',
    pattern: ['*.adoc', '!shared.adoc'],
    syntaxHighlight: false,
  });
  await loader.load(p.context());
  const watcher = p.watcher;
  if (!watcher) throw new Error('no watcher');
  return { p, loader, watcher };
}

const html = (p: FakeProject, id: string) =>
  (p.store.get(id) as { rendered: { html: string } } | undefined)?.rendered.html;

describe('watcher', () => {
  it('adds the base directory to the watcher', async () => {
    const { p, watcher } = await setup();
    expect([...watcher.added]).toEqual([p.path('notes/')]);
  });

  it('change: reprocesses only the matching file and logs one info line', async () => {
    const { p, watcher } = await setup();
    p.write('notes/a.adoc', '= A changed\n');
    await watcher.trigger('change', p.path('notes/a.adoc'));
    expect(p.store.get('a')).toMatchObject({ data: { title: 'A changed' } });
    expect(p.logger.messages('info')).toEqual(['Reloaded notes/a.adoc']);
  });

  it('change: reprocesses every entry that includes a changed file', async () => {
    const { p, watcher } = await setup();
    p.write('notes/shared.adoc', 'Shared v2.');
    await watcher.trigger('change', p.path('notes/shared.adoc'));
    expect(html(p, 'a')).toContain('Shared v2.');
    expect(html(p, 'b')).toContain('Shared v2.');
    // shared.adoc itself is excluded by the pattern, so it does not become an entry
    expect(p.store.keys().sort()).toEqual(['a', 'b']);
    expect(p.logger.messages('info')).toEqual(['Reloaded notes/a.adoc, notes/b.adoc']);
  });

  it('add: turns a new file into an entry and records it in meta', async () => {
    const { p, watcher } = await setup();
    p.write('notes/new.adoc', '= New\n');
    await watcher.trigger('add', p.path('notes/new.adoc'));
    expect(p.store.get('new')).toMatchObject({ data: { title: 'New' } });
    expect(Object.keys(p.catalog())).toEqual(['notes/a.adoc', 'notes/b.adoc', 'notes/new.adoc']);
  });

  it('unlink: removes the entry', async () => {
    const { p, watcher } = await setup();
    await watcher.trigger('unlink', p.remove('notes/b.adoc'));
    expect(p.store.keys()).toEqual(['a']);
    expect(Object.keys(p.catalog())).toEqual(['notes/a.adoc']);
  });

  it('unlink: reprocesses the entries that include a deleted file', async () => {
    const { p, watcher } = await setup();
    await watcher.trigger('unlink', p.remove('notes/shared.adoc'));
    expect(html(p, 'a')).not.toContain('Shared v1.');
    expect(p.logger.messages('error')).toEqual(
      expect.arrayContaining([expect.stringContaining('include file not found')]),
    );
  });

  it('removes the old id when a change modifies the slug', async () => {
    const { p, watcher } = await setup();
    p.write('notes/a.adoc', '= A\n:slug: renamed\n');
    await watcher.trigger('change', p.path('notes/a.adoc'));
    expect(p.store.keys().sort()).toEqual(['b', 'renamed']);
  });

  it('ignores files that neither match the pattern nor are included', async () => {
    const { p, watcher } = await setup();
    p.write('notes/readme.txt', 'x');
    await watcher.trigger('change', p.path('notes/readme.txt'));
    expect(p.logger.messages('info')).toEqual([]);
  });

  it('default pattern: reprocesses on changes to included _ files, but adds no entry for new _ files', async () => {
    const p = new FakeProject({ watcher: true });
    projects.push(p);
    p.write('notes/a.adoc', '= A\n\ninclude::_partial.adoc[]\n\ninclude::_parts/x.adoc[]\n');
    p.write('notes/_partial.adoc', 'Partial v1.');
    p.write('notes/_parts/x.adoc', 'Parts v1.');
    const loader = asciidocLoader({ base: 'notes', syntaxHighlight: false });
    await loader.load(p.context());
    expect(p.store.keys()).toEqual(['a']);

    p.write('notes/_partial.adoc', 'Partial v2.');
    await p.watcher?.trigger('change', p.path('notes/_partial.adoc'));
    p.write('notes/_parts/x.adoc', 'Parts v2.');
    await p.watcher?.trigger('change', p.path('notes/_parts/x.adoc'));
    expect(html(p, 'a')).toContain('Partial v2.');
    expect(html(p, 'a')).toContain('Parts v2.');
    expect(p.logger.messages('info')).toEqual(['Reloaded notes/a.adoc', 'Reloaded notes/a.adoc']);

    p.write('notes/_new.adoc', '= New\n');
    await p.watcher?.trigger('add', p.path('notes/_new.adoc'));
    p.write('notes/_parts/y.adoc', '= Y\n');
    await p.watcher?.trigger('add', p.path('notes/_parts/y.adoc'));
    expect(p.store.keys()).toEqual(['a']);

    await p.watcher?.trigger('unlink', p.remove('notes/_partial.adoc'));
    expect(p.store.keys()).toEqual(['a']);
    expect(html(p, 'a')).not.toContain('Partial v2.');
  });

  it('summarizes the log when many documents are reloaded', async () => {
    const p = new FakeProject({ watcher: true });
    projects.push(p);
    const names = Array.from({ length: 12 }, (_, i) => `n${String(i).padStart(2, '0')}`);
    for (const name of names) p.write(`notes/${name}.adoc`, `= ${name}\n\ninclude::_p.adoc[]\n`);
    p.write('notes/_p.adoc', 'v1');
    const loader = asciidocLoader({ base: 'notes', syntaxHighlight: false });
    await loader.load(p.context());
    p.write('notes/_p.adoc', 'v2');
    await p.watcher?.trigger('change', p.path('notes/_p.adoc'));
    const shown = names.slice(0, 10).map((n) => `notes/${n}.adoc`);
    expect(p.logger.messages('info')).toEqual([`Reloaded ${shown.join(', ')} and 2 more`]);
  });

  it('also watches included files outside base (safe: unsafe)', async () => {
    const p = new FakeProject({ watcher: true });
    projects.push(p);
    p.write('notes/a.adoc', '= A\n\ninclude::../outside/c.txt[]\n');
    p.write('outside/c.txt', 'outside v1');
    const loader = asciidocLoader({ base: 'notes', safe: 'unsafe', syntaxHighlight: false });
    await loader.load(p.context());
    expect([...(p.watcher?.added ?? [])]).toEqual([p.path('notes/'), p.path('outside/c.txt')]);
    p.write('outside/c.txt', 'outside v2');
    await p.watcher?.trigger('change', p.path('outside/c.txt'));
    expect(html(p, 'a')).toContain('outside v2');
  });

  it('keeps the previous content without throwing when a conversion fails in dev', async () => {
    const p = new FakeProject({ watcher: true });
    projects.push(p);
    p.write('notes/a.adoc', '= A\n');
    const loader = asciidocLoader({
      base: 'notes',
      syntaxHighlight: false,
      transformHtml: (html) => {
        if (html.includes('boom')) throw new Error('hook failed');
        return html;
      },
    });
    await loader.load(p.context());
    p.write('notes/a.adoc', '= A\n\nboom\n');
    await p.watcher?.trigger('change', p.path('notes/a.adoc'));
    expect(p.logger.messages('error')).toEqual(['Failed to convert notes/a.adoc: hook failed']);
    expect(html(p, 'a')).not.toContain('boom');
  });

  it('makes listeners from an earlier sync do nothing after a full sync that keeps them (refreshContent)', async () => {
    const { p, loader, watcher } = await setup();
    await loader.load(p.context('notes', { keepListeners: true }));
    expect(watcher.listenerCount('change')).toBe(2);
    p.write('notes/a.adoc', '= A changed\n');
    await watcher.trigger('change', p.path('notes/a.adoc'));
    expect(p.logger.messages('info')).toEqual(['Reloaded notes/a.adoc']);
    expect(p.store.setCalls.filter((id) => id === 'a')).toHaveLength(2);
  });

  it('does not duplicate listeners on another full sync (Astro removes them)', async () => {
    const { p, loader, watcher } = await setup();
    await loader.load(p.context());
    expect(watcher.listenerCount('change')).toBe(1);
  });
});
