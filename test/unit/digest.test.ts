import { createHash } from 'node:crypto';
import { getVersion } from '@asciidoctor/core';
import { describe, expect, it } from 'vitest';
import {
  type DigestInput,
  fingerprintOptions,
  getLoaderVersion,
  makeDigest,
} from '../../src/digest.js';
import type { AsciidocLoaderOptions } from '../../src/index.js';
import { resolveOptions } from '../../src/options.js';

const fp = (
  options: Partial<AsciidocLoaderOptions>,
  shiki: Parameters<typeof fingerprintOptions>[1] = {},
) => fingerprintOptions(resolveOptions({ base: 'notes', ...options }), shiki);

describe('fingerprintOptions', () => {
  it('changes when an option that affects conversion changes', () => {
    const base = fp({});
    for (const options of [
      { safe: 'unsafe' },
      { attributes: { icons: 'font' } },
      { mermaid: true },
      { images: false },
      { retainBody: false },
      { asciidoctor: { loadOptions: { doctype: 'book' } } },
      { asciidoctor: { extensions: () => {} } },
      { asciidoctor: { converter: class {} } },
      { transformHtml: (html: string) => html },
    ] as Partial<AsciidocLoaderOptions>[]) {
      expect(fp(options), JSON.stringify(options)).not.toBe(base);
    }
    expect(fp({}, { theme: 'nord' })).not.toBe(base);
    expect(fp({ syntaxHighlight: false }, false)).not.toBe(base);
  });

  // Only whether a function is given goes into the fingerprint, not its source. Astro does not
  // re-sync when only a module imported by the content config changes (Markdown plugins behave the
  // same), so the loader deliberately does not work around it; `astro build --force` picks up the
  // change.
  it('does not change with the body of a function', () => {
    expect(fp({ transformHtml: (html) => html })).toBe(
      fp({ transformHtml: (html) => html.toUpperCase() }),
    );
    expect(fp({}, { transformers: [{ pre() {} }] })).toBe(
      fp({}, { transformers: [{ pre: () => undefined }] }),
    );
  });

  it('includes the versions of this package and @asciidoctor/core', () => {
    const parsed = JSON.parse(fp({}));
    expect(parsed.versions).toEqual({ loader: getLoaderVersion(), asciidoctor: getVersion() });
  });
});

describe('makeDigest', () => {
  const generateDigest = (data: Record<string, unknown> | string) =>
    createHash('sha1')
      .update(typeof data === 'string' ? data : JSON.stringify(data))
      .digest('hex');
  const base: DigestInput = {
    fingerprint: 'o',
    relPath: 'notes/a.adoc',
    source: 's',
    deps: [
      ['notes/missing.png', false],
      ['notes/p.adoc', 'x'],
    ],
  };
  const digest = (patch: Partial<DigestInput>) => makeDigest(generateDigest, { ...base, ...patch });

  it('is the same for the same input', () => {
    expect(digest({})).toBe(digest({}));
  });

  it.each<[string, Partial<DigestInput>]>([
    ['a different fingerprint', { fingerprint: 'o2' }],
    ['a moved file (different path)', { relPath: 'notes/deep/a.adoc' }],
    ['a different source', { source: 's2' }],
    [
      'different content in an included file',
      {
        deps: [
          ['notes/missing.png', false],
          ['notes/p.adoc', 'y'],
        ],
      },
    ],
    [
      'an included file becoming unreadable',
      {
        deps: [
          ['notes/missing.png', false],
          ['notes/p.adoc', null],
        ],
      },
    ],
    [
      'a missing image appearing',
      {
        deps: [
          ['notes/missing.png', true],
          ['notes/p.adoc', 'x'],
        ],
      },
    ],
    ['a removed dependency', { deps: [['notes/p.adoc', 'x']] }],
  ])('%s changes the digest', (_name, patch) => {
    expect(digest(patch)).not.toBe(digest({}));
  });
});
