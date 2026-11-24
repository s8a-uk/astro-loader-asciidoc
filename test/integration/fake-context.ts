// An in-memory LoaderContext for the integration tests
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LoaderContext } from 'astro/loaders';
import { createLogger, type TestLogger } from '../helpers.js';

type DataEntry = Parameters<LoaderContext['store']['set']>[0];

export class FakeStore {
  readonly entries = new Map<string, DataEntry>();
  readonly setCalls: string[] = [];

  get = (id: string) => this.entries.get(id) as never;
  set = (entry: DataEntry): boolean => {
    const existing = this.entries.get(entry.id);
    if (existing && existing.digest !== undefined && existing.digest === entry.digest) return false;
    this.setCalls.push(entry.id);
    this.entries.set(entry.id, entry);
    return true;
  };
  keys = () => [...this.entries.keys()];
  values = () => [...this.entries.values()];
  delete = (id: string) => void this.entries.delete(id);
  clear = () => this.entries.clear();
  has = (id: string) => this.entries.has(id);
  addModuleImport = () => {};
}

export class FakeWatcher extends EventEmitter {
  readonly added = new Set<string>();
  add(path: string) {
    this.added.add(path);
    return this;
  }
  /** Calls the listeners and awaits the promises they return */
  async trigger(event: 'change' | 'add' | 'unlink', path: string) {
    for (const listener of this.listeners(event)) await listener(path);
  }
}

export interface FakeContextOptions {
  watcher?: boolean;
  shikiConfig?: Record<string, unknown>;
  prerenderConflictBehavior?: 'error' | 'warn' | 'ignore';
  parseData?: LoaderContext['parseData'];
  /**
   * Uses an existing directory as the project root (to sync the same tree with another store and
   * meta)
   */
  root?: string;
}

/** A project in a temporary directory, and LoaderContexts that point at it */
export class FakeProject {
  readonly root: string;
  readonly store = new FakeStore();
  readonly meta = new Map<string, string>();
  logger: TestLogger = createLogger();
  watcher: FakeWatcher | undefined;

  constructor(private readonly options: FakeContextOptions = {}) {
    this.root = options.root ?? mkdtempSync(join(tmpdir(), 'asciidoc-loader-'));
    if (options.watcher) this.watcher = new FakeWatcher();
  }

  path(rel: string): string {
    return join(this.root, rel);
  }

  write(rel: string, content: string | Buffer): string {
    const path = this.path(rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  remove(rel: string): string {
    const path = this.path(rel);
    rmSync(path, { force: true });
    return path;
  }

  /** The catalog saved in meta (file → { id, digest, deps }) */
  catalog(): Record<string, { id: string; digest?: string; deps: Record<string, unknown> }> {
    return JSON.parse(this.meta.get('catalog') ?? '{}');
  }

  dispose(): void {
    if (this.options.root) return; // do not remove a borrowed directory
    rmSync(this.root, { recursive: true, force: true });
  }

  /**
   * Removes the watcher listeners before creating the context, as Astro does on every full sync.
   * With keepListeners they are kept (a resync through refreshContent({ loaders }) does not remove
   * them)
   */
  context(collection = 'notes', { keepListeners = false } = {}): LoaderContext {
    if (!keepListeners) this.watcher?.removeAllListeners();
    const parseData =
      this.options.parseData ?? (async ({ data }: { data: Record<string, unknown> }) => data);
    return {
      collection,
      store: this.store as unknown as LoaderContext['store'],
      meta: {
        get: (key: string) => this.meta.get(key),
        set: (key: string, value: string) => void this.meta.set(key, value),
        has: (key: string) => this.meta.has(key),
        delete: (key: string) => void this.meta.delete(key),
      },
      logger: this.logger,
      config: {
        root: pathToFileURL(`${this.root}/`),
        markdown: { shikiConfig: { theme: 'github-dark', ...this.options.shikiConfig } },
        prerenderConflictBehavior: this.options.prerenderConflictBehavior ?? 'warn',
      } as unknown as LoaderContext['config'],
      parseData: parseData as LoaderContext['parseData'],
      renderMarkdown: async () => {
        throw new Error('not used');
      },
      generateDigest: (data) =>
        createHash('sha1')
          .update(typeof data === 'string' ? data : JSON.stringify(data))
          .digest('hex'),
      ...(this.watcher ? { watcher: this.watcher as unknown as LoaderContext['watcher'] } : {}),
    } as LoaderContext;
  }
}
