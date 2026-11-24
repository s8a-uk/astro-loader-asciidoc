import { describe, expect, it } from 'vitest';
import type { AsciidocLoaderOptions } from '../../src/index.js';
import {
  defaultGenerateId,
  mergeAttributes,
  RESERVED_LOAD_OPTIONS,
  resolveOptions,
} from '../../src/options.js';

const resolve = (options: Record<string, unknown>) =>
  resolveOptions({ base: 'notes', ...options } as unknown as AsciidocLoaderOptions);

describe('resolveOptions', () => {
  it('fills in the defaults', () => {
    const options = resolve({});
    expect(options).toMatchObject({
      patterns: ['**/*.adoc', '!**/_*', '!**/_*/**'],
      base: 'notes',
      retainBody: true,
      safe: 'safe',
      syntaxHighlight: true,
      shikiConfig: {},
      unusedShikiConfig: false,
      mermaid: false,
      images: true,
      hooks: { loadOptions: {} },
    });
    expect(options.generateId).toBe(defaultGenerateId);
    expect(options.transformHtml).toBeUndefined();
    expect(options.attributes).toEqual({
      'idprefix@': '',
      'idseparator@': '-',
      'source-highlighter@': 'shiki',
    });
  });

  it('requires base and rejects a blank string', () => {
    expect(() => resolveOptions({} as AsciidocLoaderOptions)).toThrow(
      '[asciidoc-loader] The "base" option is required',
    );
    expect(() => resolveOptions(undefined as unknown as AsciidocLoaderOptions)).toThrow(
      'Invalid option "options"',
    );
    expect(() => resolve({ base: ' ' })).toThrow(
      'Invalid option "base": expected a non-empty string or URL, got string.',
    );
  });

  it('accepts a URL as base', () => {
    const base = new URL('file:///site/content/');
    expect(resolve({ base }).base).toBe(base);
  });

  it('rejects an object for syntaxHighlight and points to shikiConfig', () => {
    expect(() => resolve({ syntaxHighlight: { theme: 'nord' } })).toThrow(
      '[asciidoc-loader] Invalid option "syntaxHighlight": expected "shiki" or false, got object. Pass Shiki options in "shikiConfig".',
    );
  });

  it('accepts shikiConfig and sets unusedShikiConfig when it comes with syntaxHighlight: false', () => {
    expect(resolve({ shikiConfig: { theme: 'nord' } })).toMatchObject({
      syntaxHighlight: true,
      shikiConfig: { theme: 'nord' },
      unusedShikiConfig: false,
    });
    expect(resolve({ syntaxHighlight: false, shikiConfig: {} }).unusedShikiConfig).toBe(true);
    expect(resolve({ syntaxHighlight: false }).unusedShikiConfig).toBe(false);
  });

  it('does not pass source-highlighter when syntaxHighlight is false', () => {
    expect(resolve({ syntaxHighlight: false }).attributes).toEqual({
      'idprefix@': '',
      'idseparator@': '-',
    });
  });

  it('drops the default exclusions (names starting with _) when pattern is given', () => {
    expect(resolve({ pattern: '**/*.adoc' }).patterns).toEqual(['**/*.adoc']);
    expect(resolve({ pattern: ['**/*.adoc'] }).patterns).toEqual(['**/*.adoc']);
  });

  it('normalizes pattern to an array', () => {
    expect(resolve({ pattern: ['a/*.adoc', '!b/**'] }).patterns).toEqual(['a/*.adoc', '!b/**']);
  });

  it.each([['../x/*.adoc'], ['/abs/*.adoc'], [['ok/*.adoc', '!../x']]])(
    'rejects patterns starting with ../ or /: %j',
    (pattern) => {
      expect(() => resolve({ pattern })).toThrow(
        '[asciidoc-loader] Glob patterns cannot start with "../" or "/". Set the "base" option instead.',
      );
    },
  );

  it.each([['./../x/*.adoc'], ['a/../../x.adoc'], ['a/..'], ['!a/../b']])(
    'rejects patterns containing a .. segment: %s',
    (pattern) => {
      expect(() => resolve({ pattern })).toThrow(
        '[asciidoc-loader] Glob patterns cannot contain ".." segments. Set the "base" option instead.',
      );
    },
  );

  it('accepts patterns that contain .. only as part of a name', () => {
    expect(resolve({ pattern: 'a..b/*.adoc' }).patterns).toEqual(['a..b/*.adoc']);
  });

  it('rejects unknown keys by name', () => {
    expect(() => resolve({ patern: '*.adoc' })).toThrow(
      '[asciidoc-loader] Unknown option "patern".',
    );
    expect(() => resolve({ asciidoctor: { extension: () => {} } })).toThrow(
      'Unknown option "asciidoctor.extension".',
    );
    expect(() => resolve({ shikiConfig: { them: 'nord' } })).toThrow(
      'Unknown option "shikiConfig.them".',
    );
  });

  it.each([
    ['base', 1, 'a string or URL', 'number'],
    ['generateId', 'x', 'a function', 'string'],
    ['retainBody', 'yes', 'a boolean', 'string'],
    ['safe', 'paranoid', 'one of unsafe, safe, server, secure', 'string'],
    ['syntaxHighlight', 'prism', '"shiki" or false', 'string'],
    ['shikiConfig', 'nord', 'an object', 'string'],
    ['mermaid', 1, 'a boolean', 'number'],
    ['images', null, 'a boolean', 'null'],
    ['attributes', [], 'an object', 'array'],
    ['transformHtml', {}, 'a function', 'object'],
  ])('rejects %s of the wrong type', (name, value, expected, actual) => {
    expect(() => resolve({ [name]: value })).toThrow(
      `[asciidoc-loader] Invalid option "${name}": expected ${expected}, got ${actual}.`,
    );
  });

  it('checks the types of attribute values and turns numbers into strings', () => {
    expect(() => resolve({ attributes: { icons: {} } })).toThrow(
      'Invalid option "attributes.icons": expected a string, number, boolean, or null, got object.',
    );
    expect(() => resolve({ attributes: { n: Number.NaN } })).toThrow('attributes.n');
    expect(resolve({ attributes: { leveloffset: 1, toclevels: 3 } }).attributes).toMatchObject({
      leveloffset: '1',
      toclevels: '3',
    });
  });

  it('requires asciidoctor.extensions to be a function', () => {
    expect(() => resolve({ asciidoctor: { extensions: 'x' } })).toThrow(
      'Invalid option "asciidoctor.extensions": expected a function, got string.',
    );
  });

  it('rejects reserved loadOptions keys', () => {
    for (const key of [
      'backend',
      'parse_header_only',
      'extension_registry',
      'safe',
      'standalone',
    ]) {
      expect(RESERVED_LOAD_OPTIONS.has(key), key).toBe(true);
      expect(() => resolve({ asciidoctor: { loadOptions: { [key]: 'x' } } })).toThrow(
        `[asciidoc-loader] The "${key}" key cannot be set in "asciidoctor.loadOptions"; it is controlled by the loader.`,
      );
    }
    expect(
      resolve({ asciidoctor: { loadOptions: { doctype: 'book' } } }).hooks.loadOptions,
    ).toEqual({
      doctype: 'book',
    });
  });
});

describe('reserved attributes', () => {
  it.each([['backend'], ['backend@'], ['!backend'], ['Backend']])('rejects %s', (name) => {
    expect(() => resolve({ attributes: { [name]: 'docbook5' } })).toThrow(
      '[asciidoc-loader] The "backend" attribute cannot be set in "attributes"; the loader always converts to HTML5.',
    );
  });
});

describe('mergeAttributes', () => {
  it('soft-sets the defaults (with @) and lets the user attributes override them', () => {
    expect(mergeAttributes({ idprefix: 'x', icons: 'font' }, true)).toEqual({
      'idseparator@': '-',
      'source-highlighter@': 'shiki',
      idprefix: 'x',
      icons: 'font',
    });
  });

  it('compares names ignoring a trailing @ or !', () => {
    expect(mergeAttributes({ 'idseparator@': '_', 'source-highlighter!': '' }, true)).toEqual({
      'idprefix@': '',
      'idseparator@': '_',
      'source-highlighter': null,
    });
  });

  it('turns true into an empty string and false or null into unset', () => {
    expect(mergeAttributes({ a: true, b: false, c: null, 'd@': false, '!e': 'x' }, false)).toEqual({
      'idprefix@': '',
      'idseparator@': '-',
      a: '',
      b: null,
      c: null,
      'd!@': '',
      e: null,
    });
  });

  it('lowercases names', () => {
    expect(mergeAttributes({ SectNums: true }, false)).toMatchObject({ sectnums: '' });
  });
});
