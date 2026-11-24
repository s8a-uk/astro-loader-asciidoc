// Planning a sync: a pure function that decides the next catalog and the data store operations
// from the prepared results
import { Catalog, type CatalogEntry } from './catalog.js';

/** Result of preparing one file */
export type Prepared<V> =
  /** Converted. Write value to the store (unless the file loses an id conflict) */
  | { kind: 'converted'; path: string; entry: CatalogEntry; value: V }
  /** Unchanged since last time. Not converted */
  | { kind: 'unchanged'; path: string; entry: CatalogEntry }
  /** Failed in dev. Keep the previous content */
  | { kind: 'failed'; path: string }
  /** The file does not exist (cannot be read) */
  | { kind: 'removed'; path: string };

/** The part of the data store the plan needs */
export interface StoreView {
  get(
    id: string,
  ): { filePath?: string | undefined; digest?: string | number | undefined } | undefined;
  keys(): Iterable<string>;
}

export interface PlanInput<V> {
  catalog: Catalog;
  prepared: readonly Prepared<V>[];
  store: StoreView;
  /**
   * all: prepared has every file (full sync). Files not in prepared are removed from the catalog,
   * and ids in the store that no file claims are deleted.
   * targets: prepared has some files (watcher, extra conversions). Other files stay in the catalog
   */
  scope: 'all' | 'targets';
  /**
   * How to warn about duplicate ids. losers: for each losing file, the pair with the winner (full
   * sync). targets: for each converted file, every pair it is part of (watcher). none: no warnings
   */
  warn: 'losers' | 'targets' | 'none';
}

export type Op<V> = { type: 'set'; path: string; value: V } | { type: 'delete'; id: string };

export interface Warning {
  /** The file the warning belongs to (printed after that file's log) */
  path: string;
  id: string;
  message: string;
}

export interface PlanResult<V> {
  nextCatalog: Catalog;
  /** Data store operations. Deletes first, then sets in file order */
  ops: Op<V>[];
  warnings: Warning[];
  /** Files that need an extra conversion to be written to the store (sorted) */
  more: string[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const duplicateMessage = (id: string, collection: string, a: string, b: string): string => {
  const [first, second] = [a, b].sort(compare);
  return `Duplicate id "${id}" in collection "${collection}": ${first} and ${second}.`;
};

/**
 * Makes the plan. Rules:
 * - If several files claim an id, the last one in path order wins (and is written to the store)
 * - Ids that no file claims are deleted from the store (only the catalog decides who owns an id)
 * - If the store does not have the winner's content (it was not converted, or the store has
 *   another file's content), the winner goes into more
 *   (taking over a released id, a missing cache entry). Files that failed in dev are not added
 */
export function plan<V>(input: PlanInput<V>, collection: string): PlanResult<V> {
  const { catalog, prepared, store, scope, warn } = input;

  const changes = new Map<string, CatalogEntry | null>();
  const byPath = new Map<string, Prepared<V>>();
  for (const p of prepared) {
    byPath.set(p.path, p);
    if (p.kind === 'converted' || p.kind === 'unchanged') changes.set(p.path, p.entry);
    else if (p.kind === 'removed') changes.set(p.path, null);
    else if (scope === 'all') {
      const previous = catalog.get(p.path);
      changes.set(p.path, previous ?? null);
    }
  }
  const nextCatalog =
    scope === 'all'
      ? new Catalog(new Map([...changes].filter((e): e is [string, CatalogEntry] => e[1] !== null)))
      : catalog.with(changes);

  // Ids affected by this plan
  const affected = new Set<string>();
  if (scope === 'all') {
    for (const id of nextCatalog.ids()) affected.add(id);
    for (const id of store.keys()) affected.add(id);
  } else {
    for (const p of prepared) {
      const before = catalog.get(p.path)?.id;
      const after = nextCatalog.get(p.path)?.id;
      if (before !== undefined) affected.add(before);
      if (after !== undefined) affected.add(after);
    }
  }

  const deletes: Op<V>[] = [];
  const sets: Array<Op<V> & { type: 'set' }> = [];
  const warnings: Warning[] = [];
  const seen = new Set<string>();
  const more: string[] = [];

  for (const id of [...affected].sort(compare)) {
    const claimants = nextCatalog.filesWithId(id);
    const winner = claimants.at(-1);
    if (winner === undefined) {
      if (store.get(id) !== undefined) deletes.push({ type: 'delete', id });
      continue;
    }
    const p = byPath.get(winner);
    if (p?.kind === 'converted') {
      sets.push({ type: 'set', path: winner, value: p.value });
    } else if (p?.kind !== 'failed') {
      const existing = store.get(id);
      const digest = nextCatalog.get(winner)?.digest;
      const current =
        existing !== undefined &&
        existing.filePath === winner &&
        digest !== undefined &&
        existing.digest === digest;
      if (!current) more.push(winner);
    }

    if (claimants.length < 2) continue;
    const add = (path: string, other: string) => {
      const message = duplicateMessage(id, collection, path, other);
      if (seen.has(message)) return;
      seen.add(message);
      warnings.push({ path, id, message });
    };
    if (warn === 'losers') {
      for (const loser of claimants.slice(0, -1)) add(loser, winner);
    } else if (warn === 'targets') {
      for (const path of claimants) {
        if (byPath.get(path)?.kind !== 'converted') continue;
        for (const other of claimants) if (other !== path) add(path, other);
      }
    }
  }

  sets.sort((a, b) => compare(a.path, b.path));
  warnings.sort((a, b) => compare(a.path, b.path));
  return { nextCatalog, ops: [...deletes, ...sets], warnings, more: more.sort(compare) };
}
