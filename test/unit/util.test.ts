import { describe, expect, it } from 'vitest';
import { createBufferedLogger } from '../../src/logging.js';
import { isUriish, mapConcurrent, relativePosix } from '../../src/util.js';
import { createLogger } from '../helpers.js';

describe('mapConcurrent', () => {
  it('runs at most limit items at a time and processes all of them', async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await mapConcurrent([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5 * (8 - n)));
      done.push(n);
      running--;
    });
    expect(peak).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('does nothing for an empty array', async () => {
    await expect(mapConcurrent([], 3, async () => {})).resolves.toBeUndefined();
  });

  it('rejects with the error of a failed item and starts no new items', async () => {
    const started: number[] = [];
    await expect(
      mapConcurrent([1, 2, 3, 4, 5], 1, async (n) => {
        started.push(n);
        if (n === 2) throw new Error('two');
      }),
    ).rejects.toThrow('two');
    expect(started).toEqual([1, 2]);
  });
});

describe('createBufferedLogger', () => {
  it('buffers until flush() and forwards in order, with warnOnce once per key', () => {
    const target = createLogger();
    const buffered = createBufferedLogger(target);
    const onceKeys = new Set<string>();
    buffered.info('i');
    buffered.warnOnce('k', 'once');
    buffered.warn('w');
    buffered.error('e');
    buffered.debug('d');
    expect(target.records).toEqual([]);
    buffered.flush(onceKeys);
    expect(target.records).toEqual([
      { level: 'info', message: 'i' },
      { level: 'warn', message: 'once' },
      { level: 'warn', message: 'w' },
      { level: 'error', message: 'e' },
      { level: 'debug', message: 'd' },
    ]);

    const other = createBufferedLogger(target);
    other.warnOnce('k', 'once');
    other.flush(onceKeys);
    expect(target.records).toHaveLength(5);

    // A second flush() forwards nothing
    buffered.flush(onceKeys);
    expect(target.records).toHaveLength(5);
  });
});

describe('util', () => {
  it('isUriish', () => {
    expect(isUriish('https://example.com/a')).toBe(true);
    expect(isUriish('file:///a')).toBe(true);
    expect(isUriish('/abs/a')).toBe(false);
    expect(isUriish('c:/a')).toBe(false);
  });

  it('relativePosix', () => {
    expect(relativePosix('/a/b', '/a/b/c/d.adoc')).toBe('c/d.adoc');
  });
});
