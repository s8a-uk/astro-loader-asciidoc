// The catalog: the only state of a sync. It is saved in the data store's meta as JSON so that
// unchanged files can be skipped while their ids and dependencies are still known.
import type { DepState } from './digest.js';

/** One catalog entry. The key is the path of the `.adoc` file, relative to the project root */
export interface CatalogEntry {
  /** The id this file claims (kept even if the file loses an id conflict) */
  id: string;
  /** Digest of the last conversion. Absent when include tracking broke (convert every time) */
  digest?: string;
  /** Dependency (path relative to the root) -> its state at the time of conversion */
  deps: Record<string, DepState>;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isDepState = (value: unknown): value is DepState =>
  value === null || typeof value === 'string' || typeof value === 'boolean';

function parseEntry(value: unknown): CatalogEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { id, digest, deps } = value as Record<string, unknown>;
  if (typeof id !== 'string' || id === '') return undefined;
  if (digest !== undefined && typeof digest !== 'string') return undefined;
  if (typeof deps !== 'object' || deps === null || Array.isArray(deps)) return undefined;
  if (!Object.values(deps).every(isDepState)) return undefined;
  return {
    id,
    ...(digest !== undefined ? { digest } : {}),
    deps: deps as Record<string, DepState>,
  };
}

/**
 * Table of file -> { id, digest, deps }. Immutable: with() returns a new table.
 * The reverse lookups (id -> files, dependency -> files) are built on first use and kept
 */
export class Catalog {
  readonly #entries: ReadonlyMap<string, CatalogEntry>;
  #byId: Map<string, string[]> | undefined;
  #byDep: Map<string, string[]> | undefined;

  constructor(entries: ReadonlyMap<string, CatalogEntry> = new Map()) {
    this.#entries = entries;
  }

  /** Reads the meta string. Discards anything unreadable or of the wrong shape */
  static parse(raw: string | undefined): Catalog {
    const entries = new Map<string, CatalogEntry>();
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          for (const [path, value] of Object.entries(parsed)) {
            const entry = parseEntry(value);
            if (entry) entries.set(path, entry);
          }
        }
      } catch {
        // Treat a broken meta as empty
      }
    }
    return new Catalog(entries);
  }

  /** JSON, sorted by file */
  serialize(): string {
    return JSON.stringify(Object.fromEntries(this.paths().map((p) => [p, this.#entries.get(p)])));
  }

  get size(): number {
    return this.#entries.size;
  }

  get(path: string): CatalogEntry | undefined {
    return this.#entries.get(path);
  }

  has(path: string): boolean {
    return this.#entries.has(path);
  }

  /** Files (sorted) */
  paths(): string[] {
    return [...this.#entries.keys()].sort(compare);
  }

  /** Files that claim the id (sorted) */
  filesWithId(id: string): readonly string[] {
    this.#byId ??= this.#index((entry) => [entry.id]);
    return this.#byId.get(id) ?? [];
  }

  /** All ids */
  ids(): string[] {
    this.#byId ??= this.#index((entry) => [entry.id]);
    return [...this.#byId.keys()];
  }

  /** Files that have path as a dependency (sorted) */
  dependentsOf(path: string): readonly string[] {
    this.#byDep ??= this.#index((entry) => Object.keys(entry.deps));
    return this.#byDep.get(path) ?? [];
  }

  /** Paths of all dependencies */
  depPaths(): string[] {
    this.#byDep ??= this.#index((entry) => Object.keys(entry.deps));
    return [...this.#byDep.keys()];
  }

  /** A new table with changes applied (path -> new entry; null deletes) */
  with(changes: ReadonlyMap<string, CatalogEntry | null>): Catalog {
    if (changes.size === 0) return this;
    const entries = new Map(this.#entries);
    for (const [path, entry] of changes) {
      if (entry === null) entries.delete(path);
      else entries.set(path, entry);
    }
    return new Catalog(entries);
  }

  #index(keysOf: (entry: CatalogEntry) => string[]): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const path of this.paths()) {
      for (const key of keysOf(this.#entries.get(path) as CatalogEntry)) {
        const list = index.get(key);
        if (list) list.push(path);
        else index.set(key, [path]);
      }
    }
    return index;
  }
}
