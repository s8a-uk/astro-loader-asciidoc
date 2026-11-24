// Passes Asciidoctor log messages to the Astro logger
// (DEBUG and INFO -> debug, WARN -> warn, ERROR and FATAL -> error)
import type { MemoryLogger } from '@asciidoctor/core';
import type { AstroIntegrationLogger } from 'astro';
import { relativePosix } from './util.js';

type LogLevel = 'debug' | 'warn' | 'error';

export function levelForSeverity(severity: string | number): LogLevel {
  const name = String(severity).toUpperCase();
  if (name === 'WARN' || name === '2') return 'warn';
  if (name === 'ERROR' || name === 'FATAL' || name === '3' || name === '4') return 'error';
  return 'debug';
}

interface CursorLike {
  getFile?(): string | null | undefined;
  getLineNumber?(): number | null | undefined;
}

/**
 * Passes the messages collected in a MemoryLogger to the Astro logger.
 * The format is <path>:<line>: <text>, where the location comes from the message (a warning in an
 * included file has that file's path). Without a location it is <path>: <text>, with the path of
 * the document.
 */
export function forwardLogs(
  memoryLogger: MemoryLogger,
  logger: AstroIntegrationLogger,
  absPath: string,
  rootDir: string,
): void {
  for (const message of memoryLogger.getMessages()) {
    const level = levelForSeverity(message.getSeverity());
    const text = message.getText();
    const location = message.getSourceLocation() as CursorLike | undefined;
    const file = location?.getFile?.();
    const line = location?.getLineNumber?.();
    const path = relativePosix(rootDir, typeof file === 'string' && file !== '' ? file : absPath);
    const prefix = file && line ? `${path}:${line}` : path;
    logger[level](`${prefix}: ${text}`);
  }
}

type BufferedLevel = 'debug' | 'info' | 'warn' | 'error';

interface BufferedRecord {
  level: BufferedLevel;
  message: string;
  /** If set, flush() prints only one message per key */
  onceKey?: string;
}

/** A logger that buffers messages and passes them to the real logger in order on flush() */
export type BufferedLogger = AstroIntegrationLogger & {
  /** Messages with the same key are printed once per set passed to flush() */
  warnOnce(key: string, message: string): void;
  flush(onceKeys: Set<string>): void;
};

/**
 * A logger that buffers the messages of each file while files are converted concurrently.
 * Flushing the buffers in file order makes the output independent of the order in which the
 * conversions finish.
 */
export function createBufferedLogger(target: AstroIntegrationLogger): BufferedLogger {
  const records: BufferedRecord[] = [];
  const push = (level: BufferedLevel) => (message: string) => {
    records.push({ level, message });
  };
  const logger = {
    label: target.label,
    options: target.options,
    fork: (label: string) => target.fork(label),
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    warnOnce(key: string, message: string) {
      records.push({ level: 'warn', message, onceKey: key });
    },
    flush(onceKeys: Set<string>) {
      for (const { level, message, onceKey } of records.splice(0)) {
        if (onceKey !== undefined) {
          if (onceKeys.has(onceKey)) continue;
          onceKeys.add(onceKey);
        }
        target[level](message);
      }
    },
  };
  return logger as unknown as BufferedLogger;
}
