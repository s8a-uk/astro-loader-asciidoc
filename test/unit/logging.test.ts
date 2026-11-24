import { join } from 'node:path';
import { MemoryLogger } from '@asciidoctor/core';
import { describe, expect, it } from 'vitest';
import { forwardLogs, levelForSeverity } from '../../src/logging.js';
import { convert, createLogger, fixturesDir } from '../helpers.js';

describe('levelForSeverity', () => {
  it.each([
    ['DEBUG', 'debug'],
    ['INFO', 'debug'],
    ['WARN', 'warn'],
    ['ERROR', 'error'],
    ['FATAL', 'error'],
  ])('%s → %s', (severity, level) => {
    expect(levelForSeverity(severity)).toBe(level);
  });
});

describe('forwardLogs', () => {
  it('formats a message with a location as <path>:<line>: <text>', async () => {
    const { logger } = await convert('= T\n\nText.\n\ninclude::nothing.adoc[]\n', {
      path: 'logs/article.adoc',
    });
    expect(logger.messages('error')).toEqual([
      expect.stringMatching(/^logs\/article\.adoc:5: include file not found: .*nothing\.adoc$/),
    ]);
  });

  it('formats a message without a location as <path>: <text>, using the article file as the path', () => {
    const memory = new MemoryLogger();
    memory.warn('something happened');
    memory.info('just info');
    const logger = createLogger();
    forwardLogs(memory, logger, join(fixturesDir, 'a/b.adoc'), fixturesDir);
    expect(logger.records).toEqual([
      { level: 'warn', message: 'a/b.adoc: something happened' },
      { level: 'debug', message: 'a/b.adoc: just info' },
    ]);
  });

  it('forwards the logs collected so far even when the conversion throws', async () => {
    const logger = createLogger();
    await expect(
      convert('= T\n\ninclude::nothing.adoc[]\n', {
        logger,
        loaderOptions: {
          asciidoctor: {
            extensions(registry) {
              // biome-ignore lint/suspicious/noExplicitAny: the DSL's this type is loose
              (registry.treeProcessor as any)(function (this: any) {
                this.process(() => {
                  throw new Error('boom');
                });
              });
            },
          },
        },
      }),
    ).rejects.toThrow('boom');
    expect(logger.messages('error')).toEqual([expect.stringContaining('include file not found')]);
  });
});
