// Sync: prepare (concurrently) -> plan -> apply, repeated until no extra conversion is needed
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { LoaderContext } from 'astro/loaders';
import type { Catalog, CatalogEntry } from './catalog.js';
import { type DepState, hashContent, makeDigest } from './digest.js';
import { markImages } from './images.js';
import { TRACKING_WARNING } from './includes.js';
import { type BufferedLogger, createBufferedLogger } from './logging.js';
import type { ResolvedOptions } from './options.js';
import { type Prepared, plan } from './plan.js';
import { processFile } from './processor.js';
import type { ShikiState } from './shiki.js';
import { mapConcurrent, relativePosix } from './util.js';

export const LOADER_NAME = 'asciidoc-loader';
const CONCURRENCY = 10;

type DataEntry = Parameters<LoaderContext['store']['set']>[0];

/** State shared by one load() and the watcher events after it */
export interface Session {
  context: LoaderContext;
  options: ResolvedOptions;
  isDev: boolean;
  rootDir: string;
  baseDir: string;
  baseUrl: URL;
  fingerprint: string;
  baselineKeys: ReadonlySet<string>;
  shiki: ShikiState | undefined;
  /** The only state. reconcile() replaces it with a new table */
  catalog: Catalog;
  /** Keys of the logs printed once by warnOnce() (shared across the whole loader) */
  onceKeys: Set<string>;
}

/**
 * Asciidoctor.js wraps exceptions thrown in load() as "asciidoctor: FAILED: <absolute path>: ...
 * - <original message>", with the original exception in cause. The loader adds the path itself,
 * so unwrap the original exception
 */
function unwrapError(error: unknown): unknown {
  if (
    error instanceof Error &&
    error.message.startsWith('asciidoctor: FAILED: ') &&
    error.cause instanceof Error
  ) {
    return error.cause;
  }
  return error;
}

export function errorMessage(error: unknown): string {
  const original = unwrapError(error);
  return original instanceof Error ? original.message : String(original);
}

/**
 * Result of preparing a file, and its buffered logs. If error is set, it is thrown when the
 * result is applied (in a build, and for invalid data in a full sync)
 */
interface Outcome {
  prepared: Prepared<DataEntry>;
  logger: BufferedLogger;
  error?: unknown;
}

/** Current states of the dependencies. Within one round of preparation, a path is read once */
type StateCache = Map<string, Promise<DepState>>;

function currentState(
  rootDir: string,
  path: string,
  stored: DepState,
  cache: StateCache,
): Promise<DepState> {
  const key = `${typeof stored === 'boolean' ? 'f' : 'i'}:${path}`;
  let state = cache.get(key);
  if (!state) {
    const abs = resolve(rootDir, path);
    state =
      typeof stored === 'boolean'
        ? Promise.resolve(existsSync(abs))
        : readFile(abs, 'utf8').then(hashContent, () => null);
    cache.set(key, state);
  }
  return state;
}

const sortedDeps = (deps: Record<string, DepState>): Array<[string, DepState]> =>
  Object.entries(deps).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * Prepares one file: reads it, checks for changes, converts, validates and post-processes it,
 * without touching the shared state (store, catalog). Safe to call concurrently. Does not throw;
 * errors go into the result.
 * With force, converts even if unchanged (when the store has no content for it)
 */
async function prepare(
  session: Session,
  path: string,
  mode: 'full' | 'watch',
  force: boolean,
  cache: StateCache,
): Promise<Outcome> {
  const { context, options, rootDir, baseDir, isDev } = session;
  const { parseData, generateDigest, collection } = context;
  const logger = createBufferedLogger(context.logger);
  const absPath = resolve(rootDir, path);
  const entry = relativePosix(baseDir, absPath);
  const previous = session.catalog.get(path);

  /** A conversion failure. Thrown in a build; in dev, logged, and the previous content is kept */
  const conversionFailed = (error: unknown): Outcome => {
    if (isDev) {
      logger.error(`Failed to convert ${path}: ${errorMessage(error)}`);
      return { prepared: { kind: 'failed', path }, logger };
    }
    return {
      prepared: { kind: 'failed', path },
      logger,
      error: new Error(`[${LOADER_NAME}] Failed to convert ${path}: ${errorMessage(error)}`, {
        cause: unwrapError(error),
      }),
    };
  };
  /**
   * Errors the user has to fix, such as invalid data. Thrown in a full sync (so they also stop the
   * dev server from starting, as with glob()). In the watcher, logged, and the previous content is
   * kept (so other files keep updating)
   */
  const fatal = (error: unknown): Outcome => {
    if (mode === 'watch') {
      logger.error(errorMessage(error));
      return { prepared: { kind: 'failed', path }, logger };
    }
    return { prepared: { kind: 'failed', path }, logger, error };
  };

  try {
    let source: string;
    try {
      source = await readFile(absPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error(`Could not read ${path}: ${errorMessage(error)}`);
      }
      return { prepared: { kind: 'removed', path }, logger };
    }

    // 1. Skip the conversion if nothing changed (same source, fingerprint, path, and current
    //    states of all dependencies)
    if (previous?.digest !== undefined && !force) {
      const deps = await Promise.all(
        sortedDeps(previous.deps).map(
          async ([dep, stored]): Promise<[string, DepState]> => [
            dep,
            await currentState(rootDir, dep, stored, cache),
          ],
        ),
      );
      const digest = makeDigest(generateDigest, {
        fingerprint: session.fingerprint,
        relPath: path,
        source,
        deps,
      });
      if (digest === previous.digest) {
        return { prepared: { kind: 'unchanged', path, entry: previous }, logger };
      }
    }

    // 2. Convert
    let result: Awaited<ReturnType<typeof processFile>>;
    try {
      result = await processFile({
        absPath,
        source,
        options,
        baselineKeys: session.baselineKeys,
        shiki: session.shiki,
        logger,
        rootDir,
      });
    } catch (error) {
      return conversionFailed(error);
    }

    // 3. id
    const id: unknown = options.generateId({ entry, base: session.baseUrl, data: result.data });
    if (typeof id !== 'string') {
      return fatal(
        new Error(
          `[${LOADER_NAME}] generateId must return a string, got ${typeof id} for ${path}.`,
        ),
      );
    }
    if (id === '') {
      return fatal(new Error(`[${LOADER_NAME}] generateId returned an empty id for ${path}.`));
    }

    // 4. Validate data (errors are passed on as is)
    let data: Record<string, unknown>;
    try {
      data = await parseData({ id, data: result.data, filePath: absPath });
    } catch (error) {
      return fatal(error);
    }

    // 5. Post-processing and images
    let html = result.html;
    let imagePaths: string[] = [];
    const deps: Record<string, DepState> = {};
    const rel = (abs: string) => relativePosix(rootDir, abs);
    for (const [abs, content] of result.includes) {
      deps[rel(abs)] = content === null ? null : hashContent(content);
    }
    for (const abs of result.missingIncludes) deps[rel(abs)] ??= null;
    try {
      if (options.transformHtml) {
        const transformed: unknown = await options.transformHtml(html, {
          id,
          collection,
          filePath: absPath,
          data: result.data,
          logger,
        });
        if (typeof transformed !== 'string') {
          throw new Error(`transformHtml must return a string, got ${typeof transformed}.`);
        }
        html = transformed;
      }
      if (options.images) {
        const marked = markImages(html, absPath, logger, path);
        html = marked.html;
        imagePaths = marked.imagePaths;
        for (const abs of marked.found) deps[rel(abs)] = true;
        for (const abs of marked.missing) deps[rel(abs)] = false;
      }
    } catch (error) {
      return conversionFailed(error);
    }

    if (result.trackingBroken) logger.warnOnce('include-tracking', TRACKING_WARNING);
    // The digest uses the content as it was when included. If an included file changed during
    // the conversion, the digest does not match the current state at the next sync, so the file
    // is converted again
    const digest = result.trackingBroken
      ? undefined
      : makeDigest(generateDigest, {
          fingerprint: session.fingerprint,
          relPath: path,
          source,
          deps: sortedDeps(deps),
        });
    const catalogEntry: CatalogEntry = { id, ...(digest !== undefined ? { digest } : {}), deps };
    const value: DataEntry = {
      id,
      data,
      ...(options.retainBody ? { body: source } : {}),
      filePath: path,
      ...(digest !== undefined ? { digest } : {}),
      rendered: {
        html,
        metadata: {
          headings: result.headings,
          frontmatter: result.data,
          ...(imagePaths.length ? { imagePaths } : {}),
        },
      },
      ...(imagePaths.length ? { assetImports: imagePaths } : {}),
    };
    return { prepared: { kind: 'converted', path, entry: catalogEntry, value }, logger };
  } catch (error) {
    // Unexpected errors (bugs in the loader and so on)
    return fatal(error);
  }
}

export interface ReconcileResult {
  /** Files written to the store (sorted) */
  written: string[];
  /** Whether the catalog changed */
  changed: boolean;
}

/**
 * Syncs targets (paths relative to the root). With full, targets are all files: files not in
 * targets are removed from the catalog, and ids no file claims are deleted from the store. With
 * watch, only targets are synced.
 * Both repeat until no extra conversion is needed (to take over released ids and so on)
 */
export async function reconcile(
  session: Session,
  targets: readonly string[],
  mode: 'full' | 'watch',
): Promise<ReconcileResult> {
  const { context } = session;
  const { store, collection, logger } = context;
  const behavior = (context.config as { prerenderConflictBehavior?: string })
    .prerenderConflictBehavior;
  const before = session.catalog;
  const written: string[] = [];
  /** Files this sync tried to convert (so extra conversions are not repeated) */
  const attempted = new Set<string>();

  let round = [...new Set(targets)].sort();
  let force = false;
  let first = true;
  while (round.length > 0 || first) {
    const cache: StateCache = new Map();
    const outcomes: Outcome[] = new Array(round.length);
    await mapConcurrent(
      round.map((path, i) => [path, i] as const),
      CONCURRENCY,
      async ([path, i]) => {
        outcomes[i] = await prepare(session, path, mode, force, cache);
      },
    );
    for (const o of outcomes) {
      if (o.prepared.kind === 'converted' || o.prepared.kind === 'failed') {
        attempted.add(o.prepared.path);
      }
    }

    // In the watcher, among files claiming the same id, treat the ones that no longer exist as
    // removed (so a rename whose add arrives before its unlink is not a false duplicate; the same
    // as glob())
    const prepared = outcomes.map((o) => o.prepared);
    if (mode === 'watch') {
      const inRound = new Set(round);
      for (const o of outcomes) {
        if (o.prepared.kind !== 'converted') continue;
        for (const other of session.catalog.filesWithId(o.prepared.entry.id)) {
          if (inRound.has(other) || existsSync(resolve(session.rootDir, other))) continue;
          inRound.add(other);
          prepared.push({ kind: 'removed', path: other });
        }
      }
    }

    const result = plan(
      {
        catalog: session.catalog,
        prepared,
        store: store as unknown as Parameters<typeof plan>[0]['store'],
        scope: mode === 'full' && first ? 'all' : 'targets',
        warn: mode === 'watch' ? 'targets' : first ? 'losers' : 'none',
      },
      collection,
    );

    // Flush the logs in file order. In a build, throw the first error in file order
    const warningsByPath = new Map<string, typeof result.warnings>();
    for (const w of result.warnings) {
      warningsByPath.set(w.path, [...(warningsByPath.get(w.path) ?? []), w]);
    }
    const flushWarnings = (path: string) => {
      for (const { message } of warningsByPath.get(path) ?? []) {
        if (behavior === 'error') {
          if (mode === 'full') throw new Error(`[${LOADER_NAME}] ${message}`);
          logger.error(message);
        } else if (behavior !== 'ignore') {
          logger.warn(message);
        }
      }
      warningsByPath.delete(path);
    };
    for (const o of outcomes) {
      o.logger.flush(session.onceKeys);
      if (o.error !== undefined) throw o.error;
      flushWarnings(o.prepared.path);
    }
    for (const path of [...warningsByPath.keys()].sort()) flushWarnings(path);

    for (const op of result.ops) {
      if (op.type === 'delete') {
        store.delete(op.id);
      } else {
        store.set(op.value);
        written.push(op.path);
      }
    }
    session.catalog = result.nextCatalog;

    round = result.more.filter((path) => !attempted.has(path));
    force = true;
    first = false;
  }

  return { written: [...new Set(written)].sort(), changed: session.catalog !== before };
}

/** Whether a path relative to the root is outside baseDir */
export function isOutside(session: Session, path: string): boolean {
  const rel = relativePosix(session.baseDir, resolve(session.rootDir, path));
  return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
}
