// The log message for files the watcher reloads
import { describe, expect, it } from 'vitest';
import { RELOADED_LIMIT, reloadedMessage } from '../../src/watch.js';

const paths = (n: number) => Array.from({ length: n }, (_, i) => `notes/n${i}.adoc`);

describe('reloadedMessage', () => {
  it('has a limit of 10 paths', () => {
    expect(RELOADED_LIMIT).toBe(10);
  });

  it('lists every path up to 10 paths', () => {
    expect(reloadedMessage(paths(1))).toBe('Reloaded notes/n0.adoc');
    expect(reloadedMessage(paths(10))).toBe(`Reloaded ${paths(10).join(', ')}`);
  });

  it('lists the first 10 paths from 11 on and summarizes the rest as a count', () => {
    expect(reloadedMessage(paths(11))).toBe(`Reloaded ${paths(10).join(', ')} and 1 more`);
    expect(reloadedMessage(paths(6000))).toBe(`Reloaded ${paths(10).join(', ')} and 5990 more`);
  });
});
