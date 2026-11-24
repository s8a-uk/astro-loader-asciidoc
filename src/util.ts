import { relative, sep } from 'node:path';

/** Uses / as the path separator */
export function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/** Relative path from from to to (with / as the separator) */
export function relativePosix(from: string, to: string): string {
  return toPosix(relative(from, to));
}

/** Whether value is a URI with a scheme (https://, file:// and so on) */
export function isUriish(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

/** Processes items with at most limit at a time. Fails with the first error if any fails */
export async function mapConcurrent<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** A short name of the type of a value, for error messages */
export function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof URL) return 'URL';
  return typeof value;
}
