// Catalog: the per-file id, digest and dependencies that the loader saves in the collection meta
import { describe, expect, it } from 'vitest';
import { Catalog, type CatalogEntry } from '../../src/catalog.js';

describe('Catalog.parse with broken meta', () => {
  it.each([[undefined], [''], ['not json'], ['[]'], ['null'], ['"string"']])(
    'returns an empty catalog for unreadable input: %j',
    (raw) => {
      expect(Catalog.parse(raw).size).toBe(0);
    },
  );

  it('drops only the entries with an invalid shape', () => {
    const catalog = Catalog.parse(
      JSON.stringify({
        'a.adoc': { id: 'a', digest: 'x', deps: { 'p.adoc': 'h', 'i.png': true, 'm.adoc': null } },
        'b.adoc': { id: 'b', deps: {} },
        'c.adoc': { id: 1, deps: {} },
        'd.adoc': { id: 'd', deps: { 'p.adoc': 1 } },
        'e.adoc': null,
        'f.adoc': { id: 'f', includes: [] },
        'g.adoc': { id: '', deps: {} },
      }),
    );
    expect(catalog.paths()).toEqual(['a.adoc', 'b.adoc']);
    expect(catalog.get('b.adoc')).toEqual({ id: 'b', deps: {} });
  });

  it('serializes entries sorted by path and parses the result back', () => {
    const catalog = new Catalog(
      new Map<string, CatalogEntry>([
        ['b.adoc', { id: 'b', deps: {} }],
        ['a.adoc', { id: 'a', digest: 'x', deps: { 'p.adoc': null } }],
      ]),
    );
    const raw = catalog.serialize();
    expect(raw).toBe(
      '{"a.adoc":{"id":"a","digest":"x","deps":{"p.adoc":null}},"b.adoc":{"id":"b","deps":{}}}',
    );
    expect(Catalog.parse(raw).serialize()).toBe(raw);
  });
});

describe('Catalog reverse lookups', () => {
  const catalog = new Catalog(
    new Map<string, CatalogEntry>([
      ['c.adoc', { id: 'same', deps: { 'p.adoc': 'h' } }],
      ['a.adoc', { id: 'same', deps: { 'p.adoc': 'h', 'i.png': true } }],
      ['b.adoc', { id: 'b', deps: {} }],
    ]),
  );

  it('finds files by id, sorted', () => {
    expect(catalog.filesWithId('same')).toEqual(['a.adoc', 'c.adoc']);
    expect(catalog.filesWithId('none')).toEqual([]);
  });

  it('finds files by dependency, sorted', () => {
    expect(catalog.dependentsOf('p.adoc')).toEqual(['a.adoc', 'c.adoc']);
    expect(catalog.dependentsOf('i.png')).toEqual(['a.adoc']);
    expect(catalog.depPaths().sort()).toEqual(['i.png', 'p.adoc']);
  });

  it('with() leaves the original unchanged and rebuilds the reverse lookups', () => {
    const next = catalog.with(
      new Map([
        ['a.adoc', null],
        ['d.adoc', { id: 'same', deps: {} }],
      ]),
    );
    expect(next.filesWithId('same')).toEqual(['c.adoc', 'd.adoc']);
    expect(catalog.filesWithId('same')).toEqual(['a.adoc', 'c.adoc']);
    expect(next.dependentsOf('i.png')).toEqual([]);
  });
});
