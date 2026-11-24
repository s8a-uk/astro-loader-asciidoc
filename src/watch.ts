// The dev watcher. Turns events into sync targets and puts them in a serial queue
import { resolve } from 'node:path';
import { errorMessage, isOutside, reconcile, type Session } from './sync.js';
import { relativePosix } from './util.js';

/** Number of paths listed in the Reloaded log. Any more are summarized as a count */
export const RELOADED_LIMIT = 10;

/** The reload log. When there are many, lists the first RELOADED_LIMIT and adds "and N more" */
export function reloadedMessage(paths: readonly string[]): string {
  if (paths.length <= RELOADED_LIMIT) return `Reloaded ${paths.join(', ')}`;
  const shown = paths.slice(0, RELOADED_LIMIT).join(', ');
  return `Reloaded ${shown} and ${paths.length - RELOADED_LIMIT} more`;
}

/** State per collection, kept across load() calls */
export interface WatchState {
  /** A chain of Promises that serializes watcher tasks and full syncs */
  queue: Promise<void>;
  /**
   * Generation of the full sync. A listener remembers the generation it was registered in, and
   * does nothing if it is old. Astro does not remove listeners on refreshContent({ loaders }), so
   * listeners can pile up
   */
  generation: number;
  /** Paths added with watcher.add() */
  watched: Set<string>;
}

export function createWatchState(): WatchState {
  return { queue: Promise.resolve(), generation: 0, watched: new Set() };
}

/** Appends task to the queue. Errors go to logger.error and do not stop the queue */
export function enqueue(
  state: WatchState,
  session: Session,
  task: () => Promise<void>,
): Promise<void> {
  const run = state.queue.then(task).catch((error: unknown) => {
    session.context.logger.error(errorMessage(error));
  });
  state.queue = run;
  return run;
}

/** Watches base, and dependencies outside base */
function addWatched(state: WatchState, session: Session): void {
  const watcher = session.context.watcher;
  if (!watcher) return;
  const paths = [
    session.baseDir,
    ...session.catalog
      .depPaths()
      .filter((p) => isOutside(session, p))
      .sort()
      .map((p) => resolve(session.rootDir, p)),
  ];
  for (const path of paths) {
    if (state.watched.has(path)) continue;
    state.watched.add(path);
    watcher.add(path);
  }
}

/** Call after a full sync. Registers the listeners of this generation */
export function watch(
  state: WatchState,
  session: Session,
  matchesPattern: (entry: string) => boolean,
  saveCatalog: () => void,
): void {
  const { watcher, logger } = session.context;
  if (!watcher) return;
  const generation = ++state.generation;
  state.watched.clear();
  addWatched(state, session);

  const onEvent = (changedPath: string) => {
    if (generation !== state.generation) return Promise.resolve();
    return enqueue(state, session, async () => {
      if (generation !== state.generation) return;
      const abs = resolve(changedPath);
      const path = relativePosix(session.rootDir, abs);
      const targets = new Set(session.catalog.dependentsOf(path));
      // Files that match the patterns, or that are in the catalog (removed if they are gone)
      if (matchesPattern(relativePosix(session.baseDir, abs)) || session.catalog.has(path)) {
        targets.add(path);
      }
      if (targets.size === 0) return;
      const { written, changed } = await reconcile(session, [...targets], 'watch');
      if (changed) saveCatalog();
      addWatched(state, session);
      if (written.length) logger.info(reloadedMessage(written));
    });
  };

  watcher.on('change', onEvent);
  watcher.on('add', onEvent);
  watcher.on('unlink', onEvent);
}
