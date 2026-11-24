// Builds the Loader
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Loader, LoaderContext } from 'astro/loaders';
import picomatch from 'picomatch';
import { glob } from 'tinyglobby';
import { Catalog } from './catalog.js';
import { fingerprintOptions } from './digest.js';
import { type ResolvedOptions, resolveOptions } from './options.js';
import { loadBaselineKeys } from './processor.js';
import { createShikiState, importShiki, type ShikiState } from './shiki.js';
import { LOADER_NAME, reconcile, type Session } from './sync.js';
import type { AsciidocLoaderOptions, ShikiOptions } from './types.js';
import { relativePosix } from './util.js';
import { createWatchState, type WatchState, watch } from './watch.js';

/** Key of the catalog in meta */
export const META_KEY = 'catalog';
/** Patterns that are always excluded (`.adoc` files under node_modules are never entries) */
const ALWAYS_IGNORED = ['**/node_modules/**'];

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function asciidocLoader(userOptions: AsciidocLoaderOptions): Loader {
  const options: ResolvedOptions = resolveOptions(userOptions);

  const watchStates = new Map<string, WatchState>();
  let shikiCache: { key: string; promise: Promise<ShikiState> } | undefined;
  const onceKeys = new Set<string>();

  const positivePatterns = options.patterns.filter((p) => !p.startsWith('!') || p.startsWith('!('));
  const negativePatterns = options.patterns
    .filter((p) => p.startsWith('!') && !p.startsWith('!('))
    .flatMap((p) => [p.slice(1), `${p.slice(1)}/**`]);
  const ignorePatterns = [...negativePatterns, ...ALWAYS_IGNORED];
  const matchesPattern = (entry: string): boolean =>
    !entry.startsWith('../') &&
    !isAbsolute(entry) &&
    picomatch.isMatch(entry, positivePatterns, { ignore: ignorePatterns });

  async function getShiki(shikiOptions: ShikiOptions): Promise<ShikiState> {
    const key = JSON.stringify(shikiOptions, (_k, v) => (typeof v === 'function' ? 'fn' : v));
    if (shikiCache?.key !== key) {
      const promise = importShiki().then((shiki) => createShikiState(shiki, shikiOptions));
      shikiCache = { key, promise };
      // On failure, allow the next load() to import it again
      promise.catch(() => {
        if (shikiCache?.promise === promise) shikiCache = undefined;
      });
    }
    return shikiCache.promise;
  }

  /** Files under base that match the patterns (paths relative to the root, sorted) */
  async function listFiles(context: LoaderContext, rootDir: string, baseDir: string) {
    const displayBase = relativePosix(rootDir, baseDir) || '.';
    if (!isDirectory(baseDir)) {
      context.logger.warn(`The base directory "${displayBase}" does not exist.`);
      return [];
    }
    const files = await glob(options.patterns, {
      cwd: baseDir,
      expandDirectories: false,
      ignore: ALWAYS_IGNORED,
    });
    if (files.length === 0) {
      context.logger.warn(
        `No files found matching "${options.patterns.join(', ')}" in "${displayBase}".`,
      );
    }
    return files.map((entry) => relativePosix(rootDir, resolve(baseDir, entry))).sort();
  }

  return {
    name: LOADER_NAME,
    async load(context: LoaderContext): Promise<void> {
      const { config, meta, watcher, collection } = context;
      let state = watchStates.get(collection);
      if (!state) {
        state = createWatchState();
        watchStates.set(collection, state);
      }
      // Stop the listeners of older generations, and wait for pending watcher tasks before the
      // full sync (otherwise a watcher task that finishes later overwrites new content with old)
      state.generation++;
      await state.queue;

      const rootDir = fileURLToPath(config.root);
      const baseUrl =
        options.base instanceof URL
          ? new URL(options.base.href.endsWith('/') ? options.base.href : `${options.base.href}/`)
          : new URL(options.base.endsWith('/') ? options.base : `${options.base}/`, config.root);
      const baseDir = fileURLToPath(baseUrl);

      let shikiOptions: ShikiOptions | false = false;
      let shiki: ShikiState | undefined;
      if (options.unusedShikiConfig && !onceKeys.has('unused-shiki-config')) {
        onceKeys.add('unused-shiki-config');
        context.logger.warn(
          'The "shikiConfig" option is ignored because "syntaxHighlight" is false.',
        );
      }
      if (options.syntaxHighlight) {
        shikiOptions = { ...config.markdown?.shikiConfig, ...options.shikiConfig };
        // Throws an Error with instructions if it cannot be imported. Not caught, even in dev
        shiki = await getShiki(shikiOptions);
      }

      const session: Session = {
        context,
        options,
        isDev: watcher !== undefined,
        rootDir,
        baseDir,
        baseUrl,
        fingerprint: fingerprintOptions(options, shikiOptions),
        baselineKeys: await loadBaselineKeys(baseDir, options),
        shiki,
        catalog: Catalog.parse(meta.get(META_KEY)),
        onceKeys,
      };
      const saveCatalog = () => meta.set(META_KEY, session.catalog.serialize());

      const files = await listFiles(context, rootDir, baseDir);
      await reconcile(session, files, 'full');
      saveCatalog();

      if (watcher) watch(state, session, matchesPattern, saveCatalog);
    },
  } satisfies Loader;
}
