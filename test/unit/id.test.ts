import { describe, expect, it } from 'vitest';
import { defaultGenerateId } from '../../src/options.js';

const base = new URL('file:///site/notes/');
const id = (entry: string, data: Record<string, unknown> = {}) =>
  defaultGenerateId({ entry, base, data });

describe('defaultGenerateId', () => {
  it('removes the last extension', () => {
    expect(id('hello.adoc')).toBe('hello');
    expect(id('a/b/hello.world.adoc')).toBe('a/b/hello.world');
  });

  it('removes a trailing /index but keeps index when it is the whole path', () => {
    expect(id('guide/index.adoc')).toBe('guide');
    expect(id('index.adoc')).toBe('index');
    expect(id('a/reindex.adoc')).toBe('a/reindex');
  });

  it('does not slugify (keeps uppercase letters and spaces)', () => {
    expect(id('My Note.adoc')).toBe('My Note');
  });

  it('prefers the slug attribute when it is a non-empty string', () => {
    expect(id('hello.adoc', { slug: 'custom/slug' })).toBe('custom/slug');
    expect(id('hello.adoc', { slug: '' })).toBe('hello');
    expect(id('hello.adoc', { slug: true })).toBe('hello');
  });
});
