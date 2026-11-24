// Digests and the fingerprint of the options
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getVersion } from '@asciidoctor/core';
import type { ResolvedOptions } from './options.js';
import type { ShikiOptions } from './types.js';

let loaderVersion: string | undefined;

/** Version of this package. Reading ../package.json works from both src and dist */
export function getLoaderVersion(): string {
  loaderVersion ??= JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    .version as string;
  return loaderVersion;
}

/** Replaces values that cannot be JSON (functions and so on) with 'fn' */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'function' || typeof value === 'symbol') return 'fn';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof RegExp) return value.toString();
  return value;
}

/**
 * Turns the options that affect the conversion result into one string. Functions cannot be
 * compared by content, so only whether they are set is included.
 * shikiOptions is markdown.shikiConfig with shikiConfig merged over it (false when not
 * highlighting).
 */
export function fingerprintOptions(
  options: ResolvedOptions,
  shikiOptions: ShikiOptions | false,
): string {
  return JSON.stringify(
    {
      safe: options.safe,
      attributes: options.attributes,
      mermaid: options.mermaid,
      images: options.images,
      retainBody: options.retainBody,
      syntaxHighlight: shikiOptions,
      hooks: {
        extensions: Boolean(options.hooks.extensions),
        converter: Boolean(options.hooks.converter),
        transformHtml: Boolean(options.transformHtml),
      },
      loadOptions: options.hooks.loadOptions,
      versions: { loader: getLoaderVersion(), asciidoctor: getVersion() },
    },
    replacer,
  );
}

/**
 * State of a dependency: for an included file, the hash of its content (null if unreadable);
 * for an image, whether it exists. Image content is not included; Vite handles image changes.
 */
export type DepState = string | null | boolean;

export interface DigestInput {
  /** Fingerprint of the options */
  fingerprint: string;
  /**
   * Path of the `.adoc` file relative to the root. Moving the file converts it again, so that
   * filePath is updated
   */
  relPath: string;
  /** Content of the `.adoc` file */
  source: string;
  /** Dependencies (paths relative to the root) and their states, sorted by path */
  deps: Array<[path: string, state: DepState]>;
}

/** Digest of an entry */
export function makeDigest(
  generateDigest: (data: Record<string, unknown> | string) => string,
  input: DigestInput,
): string {
  return generateDigest({
    o: input.fingerprint,
    p: input.relPath,
    s: input.source,
    d: input.deps,
  });
}

/** Hash of the content of an included file (stored in the catalog as the dependency state) */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('base64url');
}
