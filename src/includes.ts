// Records the files included during a conversion
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { PreprocessorReader } from '@asciidoctor/core';

type PushInclude = (this: unknown, data: unknown, file?: unknown, ...rest: unknown[]) => unknown;

/**
 * Where one conversion records its includes. includes maps the absolute path of each included
 * file to its content at the time it was read (null if unreadable). calls counts the calls to
 * pushInclude (used to check that tracking works)
 */
export interface IncludeRecord {
  includes: Map<string, string | null>;
  calls: number;
}

/**
 * Marker that the prototype has been wrapped, and the state shared by the wrapper. It is put on
 * the prototype with Symbol.for, so that even if this package is evaluated twice (another copy
 * is loaded), the wrappers do not stack and use the same record store
 */
const PATCH_KEY = Symbol.for('@s8a-uk/astro-loader-asciidoc/pushInclude');

interface PatchState {
  storage: AsyncLocalStorage<IncludeRecord>;
  /** pushInclude was missing, so it could not be wrapped */
  unavailable: boolean;
}

function readContent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Wraps PreprocessorReader.prototype.pushInclude (a method in the public type definitions) once.
 * Asciidoctor.js does not record every include itself (`document.catalog.includes` only has
 * AsciiDoc files, keyed without the extension), but the reader calls
 * this.pushInclude(data, file, ...) for every include, whatever its kind (file is a resolved
 * absolute path or a URI). Documents in table cells (a|) use another reader,
 * so the prototype is wrapped, not an instance. Records are kept per conversion in an
 * AsyncLocalStorage, so concurrent conversions do not mix.
 * Calls outside a conversion (Asciidoctor.js used elsewhere by the user, for example) do nothing
 */
function patchState(): PatchState {
  const proto = PreprocessorReader.prototype as unknown as Record<
    symbol,
    PatchState | undefined
  > & { pushInclude?: PushInclude };
  const existing = proto[PATCH_KEY];
  if (existing) return existing;

  const state: PatchState = { storage: new AsyncLocalStorage(), unavailable: false };
  const original = proto.pushInclude;
  if (typeof original !== 'function') {
    state.unavailable = true;
  } else {
    proto.pushInclude = function (this: unknown, data, file, ...rest) {
      const record = state.storage.getStore();
      if (record) {
        record.calls++;
        // A user's include processor may pass a target that is not a path (virtual:thing and so
        // on), so record absolute paths only
        if (typeof file === 'string' && isAbsolute(file) && !record.includes.has(file)) {
          record.includes.set(file, readContent(file));
        }
      }
      return original.call(this, data, file, ...rest);
    };
  }
  Object.defineProperty(proto, PATCH_KEY, { value: state });
  return state;
}

/** Records the files included inside fn (including its asynchronous continuations) */
export async function trackIncludes<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; record: IncludeRecord; unavailable: boolean }> {
  const state = patchState();
  const record: IncludeRecord = { includes: new Map(), calls: 0 };
  const value = await state.storage.run(record, fn);
  return { value, record, unavailable: state.unavailable };
}

/**
 * Tells whether tracking failed: pushInclude was missing, or Asciidoctor recorded an AsciiDoc
 * include in the document catalog but pushInclude was never called. Documents with only source
 * code includes cannot be checked, because the catalog has AsciiDoc includes only.
 * catalog.includes is shared with documents in table cells (pinned in test/verify/includes.test.ts)
 */
export function isTrackingBroken(
  doc: { getCatalog?: () => unknown },
  tracked: { record: IncludeRecord; unavailable: boolean },
): boolean {
  const catalog = typeof doc.getCatalog === 'function' ? doc.getCatalog() : undefined;
  const includes = (catalog as { includes?: unknown } | undefined)?.includes;
  // If the catalog has changed shape and cannot be checked, only a failed wrap counts as broken
  if (typeof includes !== 'object' || includes === null) return tracked.unavailable;
  return Object.keys(includes).length > 0 && (tracked.unavailable || tracked.record.calls === 0);
}

export const TRACKING_WARNING =
  'Included files cannot be tracked with this version of @asciidoctor/core, so documents with includes are converted on every sync. Please report this issue.';

/**
 * Extracts the absolute path of a missing include target from an Asciidoctor log message. The
 * messages (Asciidoctor.js 4.2.1) are "include file not found: <path>" and, with opts=optional,
 * "optional include dropped because include file not found: <path>".
 * Pinned in test/verify/includes.test.ts
 */
export function missingIncludeFromLog(text: string): string | undefined {
  const path = /include file not found: (.+)$/.exec(text)?.[1];
  return path && isAbsolute(path) ? path : undefined;
}
