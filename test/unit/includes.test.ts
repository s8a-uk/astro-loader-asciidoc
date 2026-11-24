import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, PreprocessorReader } from '@asciidoctor/core';
import { describe, expect, it, vi } from 'vitest';
import { isTrackingBroken, missingIncludeFromLog } from '../../src/includes.js';
import { convert, fixturesDir } from '../helpers.js';

const verifyDir = join(fixturesDir, 'verify');
/** load() with { path, read } input (not in the public type definitions, so the type is widened) */
const loadAny = load as unknown as (
  input: { path: string; read(): string },
  options: Record<string, unknown>,
) => Promise<{ convert(): Promise<string> }>;
const read = (rel: string) => readFileSync(join(verifyDir, rel), 'utf8');

describe('recording includes', () => {
  it('records AsciiDoc, source code, nested, tag and lines includes by absolute path', async () => {
    const { includes, html, logger } = await convert(read('main.adoc'), {
      path: 'verify/main.adoc',
    });
    expect([...includes.keys()].sort()).toEqual(
      ['code.js', 'nested-a.adoc', 'partial.adoc', 'shared/nested-b.adoc', 'tagged.adoc']
        .map((p) => join(verifyDir, p))
        .sort(),
    );
    expect(html).toContain('Text from nested-b.adoc.');
    expect(html).toContain('Text inside the keep tag.');
    expect(html).not.toContain('Text inside the drop tag.');
    // A missing include target is not recorded and is logged as an error with its location
    expect(logger.messages('error')).toEqual([
      expect.stringMatching(/^verify\/main\.adoc:\d+: include file not found: .*missing\.adoc$/),
    ]);
  });

  it('resolves relative includes in an article in a subdirectory from the article directory', async () => {
    const { includes, html } = await convert(read('sub/article.adoc'), {
      path: 'verify/sub/article.adoc',
    });
    expect(html).toContain('Text from sub/sibling.adoc.');
    expect([...includes.keys()]).toEqual([join(verifyDir, 'sub/sibling.adoc')]);
  });

  it('cannot include files above the article in safe mode but can in unsafe mode', async () => {
    const safe = await convert(read('sub/article.adoc'), { path: 'verify/sub/article.adoc' });
    expect(safe.html).not.toContain('Text from partial.adoc.');
    expect(safe.logger.messages('warn')).toEqual([
      'verify/sub/article.adoc: include file has illegal reference to ancestor of jail; recovering automatically',
    ]);

    const unsafe = await convert(read('sub/article.adoc'), {
      path: 'verify/sub/article.adoc',
      loaderOptions: { safe: 'unsafe' },
    });
    expect(unsafe.html).toContain('Text from partial.adoc.');
    expect([...unsafe.includes.keys()]).toContain(join(verifyDir, 'partial.adoc'));
  });

  it('does not include anything in secure mode', async () => {
    const { includes, html } = await convert(read('sub/article.adoc'), {
      path: 'verify/sub/article.adoc',
      loaderOptions: { safe: 'secure' },
    });
    expect([...includes.keys()]).toEqual([]);
    expect(html).not.toContain('Text from sub/sibling.adoc.');
  });
});

describe('includes inside table cells (a|) and missing include targets', () => {
  it('records includes inside a cell', async () => {
    const { includes, html } = await convert(
      ['[cols="1a"]', '|===', '|', 'include::partial.adoc[]', '|==='].join('\n'),
      { path: 'verify/table.adoc' },
    );
    expect(html).toContain('Text from partial.adoc.');
    expect([...includes.keys()]).toEqual([join(verifyDir, 'partial.adoc')]);
  });

  it('returns the absolute paths of missing include targets, including those inside cells', async () => {
    const { missingIncludes } = await convert(
      [
        'include::nothing.adoc[]',
        '',
        '[cols="1a"]',
        '|===',
        '|',
        'include::also-nothing.adoc[]',
        '|===',
      ].join('\n'),
      { path: 'verify/missing.adoc' },
    );
    expect(missingIncludes.sort()).toEqual(
      [join(verifyDir, 'also-nothing.adoc'), join(verifyDir, 'nothing.adoc')].sort(),
    );
  });
});

describe('edge cases of recording includes', () => {
  it('records a missing include target with opts=optional', async () => {
    const { missingIncludes } = await convert('include::later.adoc[opts=optional]\n', {
      path: 'verify/optional.adoc',
    });
    expect(missingIncludes).toEqual([join(verifyDir, 'later.adoc')]);
    expect(
      missingIncludeFromLog('optional include dropped because include file not found: /a/b.adoc'),
    ).toBe('/a/b.adoc');
    expect(
      missingIncludeFromLog('include file not found: https://example.com/x.adoc'),
    ).toBeUndefined();
  });

  it('does not record a target that an include processor passes on as something other than a path', async () => {
    const { includes, html } = await convert(
      'include::virtual:thing[]\n\ninclude::partial.adoc[]\n',
      {
        path: 'verify/virtual.adoc',
        loaderOptions: {
          asciidoctor: {
            extensions(registry) {
              // biome-ignore lint/suspicious/noExplicitAny: loose DSL this and reader types
              (registry.includeProcessor as any)(function (this: any) {
                this.handles((target: string) => target.startsWith('virtual:'));
                type ReaderLike = { pushInclude(...args: unknown[]): unknown };
                this.process(
                  (_doc: unknown, reader: ReaderLike, target: string, attrs: unknown) => {
                    reader.pushInclude(['Virtual content.'], target, target, 1, attrs);
                  },
                );
              });
            },
          },
        },
      },
    );
    expect(html).toContain('Virtual content.');
    expect([...includes.keys()]).toEqual([join(verifyDir, 'partial.adoc')]);
  });

  it('wraps the prototype only once (re-evaluating the module neither wraps it again nor changes the record)', async () => {
    const proto = PreprocessorReader.prototype as unknown as { pushInclude: unknown };
    await convert('x', {});
    const wrapped = proto.pushInclude;
    vi.resetModules();
    const again = await import('../../src/includes.js');
    const { record } = await again.trackIncludes(async () => {
      const doc = await loadAny(
        { path: join(verifyDir, 'again.adoc'), read: () => 'include::partial.adoc[]\n' },
        { safe: 'safe', standalone: false },
      );
      return doc.convert();
    });
    expect(proto.pushInclude).toBe(wrapped);
    expect([...record.includes.keys()]).toEqual([join(verifyDir, 'partial.adoc')]);
  });

  it('keeps the records of concurrent conversions apart', async () => {
    const sources = Array.from({ length: 12 }, (_, i) =>
      i % 3 === 0
        ? 'include::partial.adoc[]\n'
        : i % 3 === 1
          ? '[cols="1a"]\n|===\n|\ninclude::tagged.adoc[tag=keep]\n|===\n'
          : 'No includes.\n',
    );
    const results = await Promise.all(
      sources.map((source, i) => convert(source, { path: `verify/concurrent-${i}.adoc` })),
    );
    results.forEach(({ includes }, i) => {
      const expected =
        i % 3 === 0
          ? [join(verifyDir, 'partial.adoc')]
          : i % 3 === 1
            ? [join(verifyDir, 'tagged.adoc')]
            : [];
      expect([...includes.keys()], `document ${i}`).toEqual(expected);
    });
  });

  it('does nothing for calls without a record (Asciidoctor.js used elsewhere)', async () => {
    const doc = await loadAny(
      { path: join(verifyDir, 'outside.adoc'), read: () => 'include::partial.adoc[]\n' },
      { safe: 'safe', standalone: false },
    );
    expect(await doc.convert()).toContain('Text from partial.adoc.');
  });
});

describe('detecting broken include tracking', () => {
  const tracked = (calls: number, unavailable = false) => ({
    record: { includes: new Map(), calls },
    unavailable,
  });
  const docWith = (includes: Record<string, unknown> | undefined) => ({
    getCatalog: () => (includes === undefined ? {} : { includes }),
  });

  it.each([
    ['no includes, pushInclude not called', docWith({}), tracked(0), false],
    ['includes, pushInclude called', docWith({ partial: true }), tracked(1), false],
    ['includes, but pushInclude not called', docWith({ partial: true }), tracked(0), true],
    ['no pushInclude, includes', docWith({ partial: true }), tracked(0, true), true],
    ['no pushInclude, no includes', docWith({}), tracked(0, true), false],
    ['catalog shape changed, pushInclude present', docWith(undefined), tracked(0), false],
    ['catalog shape changed, no pushInclude', docWith(undefined), tracked(0, true), true],
  ])('%s', (_name, doc, t, broken) => {
    expect(isTrackingBroken(doc, t)).toBe(broken);
  });
});
