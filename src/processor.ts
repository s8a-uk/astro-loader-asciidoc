// Converts one file
import { join } from 'node:path';
import type { Document } from '@asciidoctor/core';
import * as Asciidoctor from '@asciidoctor/core';
import type { AstroIntegrationLogger, MarkdownHeading } from 'astro';
import { toData } from './attributes.js';
import { extractHeadings } from './headings.js';
import { isTrackingBroken, missingIncludeFromLog, trackIncludes } from './includes.js';
import { forwardLogs } from './logging.js';
import { registerMermaid } from './mermaid.js';
import type { ResolvedOptions } from './options.js';
import { createShikiAdapter, type ShikiState } from './shiki.js';
import { relativePosix } from './util.js';

/**
 * load() in the public type definitions (types/index.d.ts) does not declare the { path, read }
 * input, but accepts it at runtime (src/load.js), and sets docfile, docdir and docname from the
 * path. Relative includes are then resolved from the directory of the file.
 */
const loadSource = Asciidoctor.load as unknown as (
  input: { path: string; read(): string },
  options: Record<string, unknown>,
) => Promise<Document>;

export interface ProcessInput {
  absPath: string;
  source: string;
  options: ResolvedOptions;
  baselineKeys: ReadonlySet<string>;
  shiki?: ShikiState | undefined;
  logger: AstroIntegrationLogger;
  rootDir: string;
}

export interface ProcessResult {
  /** The raw data, before schema validation */
  data: Record<string, unknown>;
  /** HTML for embedding (not a standalone page) */
  html: string;
  headings: MarkdownHeading[];
  /** Absolute path of each included file -> its content when it was read (null if unreadable) */
  includes: Map<string, string | null>;
  /** Absolute paths of missing include targets (used to convert again when they are added) */
  missingIncludes: string[];
  /**
   * Include tracking failed, so includes cannot be trusted. No digest is saved, and the file is
   * converted every time
   */
  trackingBroken: boolean;
}

/** Collects missing include targets from the MemoryLogger messages */
function collectMissingIncludes(
  memoryLogger: InstanceType<typeof Asciidoctor.MemoryLogger>,
): string[] {
  const paths = new Set<string>();
  for (const message of memoryLogger.getMessages()) {
    const path = missingIncludeFromLog(message.getText());
    if (path) paths.add(path);
  }
  return [...paths];
}

/** load() options the loader decides (they take precedence over the user's loadOptions) */
function baseLoadOptions(options: ResolvedOptions): Record<string, unknown> {
  return {
    ...options.hooks.loadOptions,
    safe: options.safe,
    attributes: options.attributes,
    standalone: false,
    ...(options.hooks.converter ? { converter: options.hooks.converter } : {}),
  };
}

/**
 * Loads an empty document with the same options and returns the set of its attribute keys.
 * Keys in this set are attributes that Asciidoctor or the loader sets, so they are left out of
 * data. Only keys are compared: some values (localtime and so on) change on every call.
 * The file does not need to exist. No extension registry is passed.
 */
export async function loadBaselineKeys(
  baseDir: string,
  options: ResolvedOptions,
): Promise<Set<string>> {
  const doc = await loadSource(
    { path: join(baseDir, '__baseline__.adoc'), read: () => '' },
    { ...baseLoadOptions(options), logger: new Asciidoctor.MemoryLogger() },
  );
  return new Set(Object.keys(doc.getAttributes() as Record<string, unknown>));
}

export async function processFile(input: ProcessInput): Promise<ProcessResult> {
  const { absPath, source, options, baselineKeys, shiki, logger, rootDir } = input;
  const displayPath = relativePosix(rootDir, absPath);

  // A new registry for each document (so that state does not mix between concurrent conversions)
  const registry = Asciidoctor.Extensions.create();
  if (options.mermaid) registerMermaid(registry);
  if (options.hooks.extensions) await options.hooks.extensions(registry, Asciidoctor);

  const memoryLogger = new Asciidoctor.MemoryLogger();
  try {
    // Record the files included in load() and convert() (including documents in table cells)
    const tracked = await trackIncludes(async () => {
      const doc = await loadSource(
        { path: absPath, read: () => source },
        {
          ...baseLoadOptions(options),
          extension_registry: registry,
          logger: memoryLogger,
          ...(shiki
            ? {
                syntax_highlighters: {
                  shiki: createShikiAdapter(
                    Asciidoctor.SyntaxHighlighterBase,
                    shiki,
                    logger,
                    displayPath,
                  ),
                },
              }
            : {}),
        },
      );
      // Build data before converting. After conversion, attributes defined in the body are also
      // document attributes
      const data = toData(doc, baselineKeys);
      const html = await doc.convert();
      return { doc, data, html };
    });
    const { doc, data, html } = tracked.value;
    return {
      data,
      html,
      headings: extractHeadings(doc),
      includes: tracked.record.includes,
      missingIncludes: collectMissingIncludes(memoryLogger),
      trackingBroken: isTrackingBroken(doc, tracked),
    };
  } finally {
    forwardLogs(memoryLogger, logger, absPath, rootDir);
  }
}
