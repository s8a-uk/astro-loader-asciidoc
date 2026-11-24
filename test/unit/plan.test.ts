// plan(): decides the data store writes and deletes of a sync, including how duplicate ids resolve
import { describe, expect, it } from 'vitest';
import { Catalog, type CatalogEntry } from '../../src/catalog.js';
import { type Prepared, plan } from '../../src/plan.js';

/** Builds a catalog from 'path=id' items. The digest is 'd:<path>' */
function catalogOf(...items: string[]): Catalog {
  return new Catalog(
    new Map(
      items.map((item) => {
        const [path, id] = item.split('=') as [string, string];
        return [path, { id, digest: `d:${path}`, deps: {} }];
      }),
    ),
  );
}

/** Builds a store from 'id=path' items. The digest is 'd:<path>' (matching the catalog) */
function storeOf(...items: string[]) {
  const entries = new Map(
    items.map((item) => {
      const [id, filePath] = item.split('=') as [string, string];
      return [id, { filePath, digest: `d:${filePath}` }];
    }),
  );
  return { get: (id: string) => entries.get(id), keys: () => entries.keys() };
}

const entryOf = (path: string, id: string): CatalogEntry => ({ id, digest: `d:${path}`, deps: {} });
const converted = (path: string, id: string): Prepared<string> => ({
  kind: 'converted',
  path,
  entry: entryOf(path, id),
  value: `${path}->${id}`,
});
const unchanged = (path: string, id: string): Prepared<string> => ({
  kind: 'unchanged',
  path,
  entry: entryOf(path, id),
});
const removed = (path: string): Prepared<string> => ({ kind: 'removed', path });
const failed = (path: string): Prepared<string> => ({ kind: 'failed', path });

interface Case {
  name: string;
  catalog: Catalog;
  store: ReturnType<typeof storeOf>;
  prepared: Prepared<string>[];
  scope: 'all' | 'targets';
  warn?: 'losers' | 'targets' | 'none';
  /** Expected operations ('set <path>' or 'delete <id>') */
  ops: string[];
  more?: string[];
  warnings?: string[];
  /** Expected next catalog ('path=id') */
  next?: string[];
}

const cases: Case[] = [
  {
    name: 'writes a new file',
    catalog: catalogOf(),
    store: storeOf(),
    prepared: [converted('a', 'a')],
    scope: 'all',
    ops: ['set a'],
    next: ['a=a'],
  },
  {
    name: 'does not write an unchanged file',
    catalog: catalogOf('a=a'),
    store: storeOf('a=a'),
    prepared: [unchanged('a', 'a')],
    scope: 'all',
    ops: [],
  },
  {
    name: 'deletes the ids of files not found in a full sync',
    catalog: catalogOf('a=a', 'b=b'),
    store: storeOf('a=a', 'b=b'),
    prepared: [unchanged('a', 'a')],
    scope: 'all',
    ops: ['delete b'],
    next: ['a=a'],
  },
  {
    name: 'does not report a false duplicate when slugs are swapped (ra: rx→rz, rb: rz→rw)',
    catalog: catalogOf('ra=rx', 'rb=rz'),
    store: storeOf('rx=ra', 'rz=rb'),
    prepared: [converted('ra', 'rz'), converted('rb', 'rw')],
    scope: 'all',
    ops: ['delete rx', 'set rb', 'set ra'].sort(byOp),
    warnings: [],
    next: ['ra=rz', 'rb=rw'],
  },
  {
    name: 'keeps the last file by path for a duplicate id, with one warning per losing file',
    catalog: catalogOf(),
    store: storeOf(),
    prepared: [converted('a', 'same'), converted('b', 'same'), converted('c', 'same')],
    scope: 'all',
    warn: 'losers',
    ops: ['set c'],
    warnings: [
      'a: Duplicate id "same" in collection "notes": a and c.',
      'b: Duplicate id "same" in collection "notes": b and c.',
    ],
  },
  {
    name: 'warns in a full sync even when the losing files are unchanged',
    catalog: catalogOf('a=same', 'b=same'),
    store: storeOf('same=b'),
    prepared: [unchanged('a', 'same'), unchanged('b', 'same')],
    scope: 'all',
    warn: 'losers',
    ops: [],
    warnings: ['a: Duplicate id "same" in collection "notes": a and b.'],
  },
  {
    name: 'watcher: warns about every pair that involves the converted file',
    catalog: catalogOf('a=same', 'b=same', 'c=same'),
    store: storeOf('same=c'),
    prepared: [converted('a', 'same')],
    scope: 'targets',
    warn: 'targets',
    ops: [],
    warnings: [
      'a: Duplicate id "same" in collection "notes": a and b.',
      'a: Duplicate id "same" in collection "notes": a and c.',
    ],
  },
  {
    name: 'also converts the next file when the winning file gives up the id',
    catalog: catalogOf('a=same', 'b=same'),
    store: storeOf('same=b'),
    prepared: [converted('b', 'other')],
    scope: 'targets',
    ops: ['set b'],
    more: ['a'],
    next: ['a=same', 'b=other'],
  },
  {
    name: 'also converts the next file when the winning file is removed',
    catalog: catalogOf('a=same', 'b=same'),
    store: storeOf('same=b'),
    prepared: [removed('b')],
    scope: 'targets',
    ops: [],
    more: ['a'],
    next: ['a=same'],
  },
  {
    name: 'does not delete an id now taken by another file, even if the removed file used to have it',
    catalog: catalogOf('a=y', 'b=x'),
    store: storeOf('x=b', 'y=a'),
    prepared: [removed('a')],
    scope: 'targets',
    ops: ['delete y'],
    next: ['b=x'],
  },
  {
    name: 'converts an unchanged file again when the store has no content for it (missing cache)',
    catalog: catalogOf('a=a'),
    store: storeOf(),
    prepared: [unchanged('a', 'a')],
    scope: 'all',
    ops: [],
    more: ['a'],
  },
  {
    name: 'keeps the previous catalog and store for a file that failed in dev, without converting it again',
    catalog: catalogOf('a=a'),
    store: storeOf(),
    prepared: [failed('a')],
    scope: 'all',
    ops: [],
    more: [],
    next: ['a=a'],
  },
  {
    name: 'leaves a new file that failed in dev out of the catalog',
    catalog: catalogOf(),
    store: storeOf(),
    prepared: [failed('a')],
    scope: 'all',
    ops: [],
    next: [],
  },
  {
    name: 'watcher: keeps files that are not targets in the catalog',
    catalog: catalogOf('a=a', 'b=b'),
    store: storeOf('a=a', 'b=b'),
    prepared: [converted('a', 'a')],
    scope: 'targets',
    ops: ['set a'],
    next: ['a=a', 'b=b'],
  },
];

function byOp(a: string, b: string): number {
  // Deletes first, then sets in path order
  const rank = (s: string) => (s.startsWith('delete') ? 0 : 1);
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

describe('plan()', () => {
  it.each(cases)('$name', (c) => {
    const result = plan(
      {
        catalog: c.catalog,
        prepared: c.prepared,
        store: c.store,
        scope: c.scope,
        warn: c.warn ?? 'none',
      },
      'notes',
    );
    expect(
      result.ops.map((op) => (op.type === 'set' ? `set ${op.path}` : `delete ${op.id}`)),
    ).toEqual(c.ops);
    if (c.more) expect(result.more).toEqual(c.more);
    else expect(result.more).toEqual([]);
    if (c.warnings) {
      expect(result.warnings.map((w) => `${w.path}: ${w.message}`)).toEqual(c.warnings);
    }
    if (c.next) {
      expect(
        result.nextCatalog.paths().map((p) => `${p}=${result.nextCatalog.get(p)?.id}`),
      ).toEqual(c.next);
    }
  });
});
