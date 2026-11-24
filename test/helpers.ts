// Shared test helpers
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegrationLogger } from 'astro';
import type { AsciidocLoaderOptions } from '../src/index.js';
import { resolveOptions } from '../src/options.js';
import { loadBaselineKeys, processFile } from '../src/processor.js';
import { createShikiState, importShiki, type ShikiState } from '../src/shiki.js';
import type { ShikiOptions } from '../src/types.js';

export const fixturesDir = fileURLToPath(new URL('./fixtures/docs/', import.meta.url));

export interface LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export interface TestLogger extends AstroIntegrationLogger {
  records: LogRecord[];
  messages(level: LogRecord['level']): string[];
}

/** A logger that records every message it receives */
export function createLogger(label = 'asciidoc-loader'): TestLogger {
  const records: LogRecord[] = [];
  const logger = {
    label,
    options: {},
    records,
    messages: (level: LogRecord['level']) =>
      records.filter((r) => r.level === level).map((r) => r.message),
    fork: (newLabel: string) => createLogger(newLabel),
    debug: (message: string) => void records.push({ level: 'debug', message }),
    info: (message: string) => void records.push({ level: 'info', message }),
    warn: (message: string) => void records.push({ level: 'warn', message }),
    error: (message: string) => void records.push({ level: 'error', message }),
  };
  return logger as unknown as TestLogger;
}

const shikiStates = new Map<string, Promise<ShikiState>>();

export function getShikiState(options: ShikiOptions = {}): Promise<ShikiState> {
  const key = JSON.stringify(options);
  let state = shikiStates.get(key);
  if (!state) {
    state = importShiki().then((shiki) => createShikiState(shiki, options));
    shikiStates.set(key, state);
  }
  return state;
}

export interface ConvertOptions {
  /** Path relative to fixtures/docs. The file does not need to exist */
  path?: string;
  loaderOptions?: Partial<AsciidocLoaderOptions>;
  /** No highlighting by default (keeps tests that are not about Shiki fast) */
  shiki?: ShikiOptions | false;
  logger?: TestLogger;
}

/** Calls processFile() with the real @asciidoctor/core */
export async function convert(source: string, options: ConvertOptions = {}) {
  const absPath = join(fixturesDir, options.path ?? 'inline.adoc');
  const shikiOptions = options.shiki ?? false;
  const resolved = resolveOptions({
    base: '.',
    ...(shikiOptions === false ? { syntaxHighlight: false } : {}),
    ...options.loaderOptions,
  });
  const logger = options.logger ?? createLogger();
  const baselineKeys = await loadBaselineKeys(fixturesDir, resolved);
  const result = await processFile({
    absPath,
    source,
    options: resolved,
    baselineKeys,
    shiki: shikiOptions === false ? undefined : await getShikiState(shikiOptions),
    logger,
    rootDir: fixturesDir,
  });
  return { ...result, logger };
}
