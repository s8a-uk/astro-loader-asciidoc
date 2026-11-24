// When the loader detects that include tracking is broken (it relies on wrapping Asciidoctor.js's
// PreprocessorReader.prototype.pushInclude to record every included file)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asciidocLoader } from '../../src/index.js';
import { FakeProject } from './fake-context.js';

vi.mock('../../src/includes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/includes.js')>()),
  isTrackingBroken: () => true,
}));

const projects: FakeProject[] = [];
afterEach(() => {
  for (const p of projects.splice(0)) p.dispose();
});

describe('when include tracking is broken', () => {
  it('warns once, saves no digest and reconverts on every sync', async () => {
    const p = new FakeProject();
    projects.push(p);
    p.write('notes/a.adoc', '= A\n\ninclude::_p.adoc[]\n');
    p.write('notes/b.adoc', '= B\n\ninclude::_p.adoc[]\n');
    p.write('notes/_p.adoc', 'Partial.');
    const loader = asciidocLoader({ base: 'notes', syntaxHighlight: false });
    await loader.load(p.context());
    await loader.load(p.context());

    expect(p.logger.messages('warn')).toEqual([
      expect.stringContaining('Included files cannot be tracked'),
    ]);
    expect(p.store.get('a')).not.toHaveProperty('digest');
    expect(p.catalog()['notes/a.adoc']).not.toHaveProperty('digest');
    expect(p.store.setCalls).toEqual(['a', 'b', 'a', 'b']);
  });
});
