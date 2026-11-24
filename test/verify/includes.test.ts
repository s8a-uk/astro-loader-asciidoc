// Verifies the Asciidoctor.js behavior that include tracking relies on:
// - Wrapping PreprocessorReader.prototype.pushInclude yields the absolute paths of all includes.
// - With { path, read } input, docfile and docdir are set, and relative includes in an article in a
//   subdirectory are resolved from that file's directory.
// It also pins the pushInclude contract and the log messages that src/includes.ts depends on.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Document, load, MemoryLogger, PreprocessorReader } from '@asciidoctor/core';
import { describe, expect, it } from 'vitest';

// The public type definitions (types/index.d.ts) do not declare the { path, read } form for load().
// It is accepted at runtime (types/load.d.ts and src/load.js), so only the type is widened
const loadSource = load as unknown as (
  input: { path: string; read(): string },
  options?: Record<string, unknown>,
) => Promise<Document>;
const fixtures = fileURLToPath(new URL('../fixtures/docs/verify/', import.meta.url));

type PushInclude = (this: unknown, data: unknown, file?: unknown, ...rest: unknown[]) => unknown;
const proto = PreprocessorReader.prototype as unknown as { pushInclude: PushInclude };

/**
 * Wraps PreprocessorReader.prototype.pushInclude only while fn runs and records the file argument
 * (relies on the same contract as src/includes.ts)
 */
async function withPushIncludeSpy<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; files: unknown[] }> {
  const files: unknown[] = [];
  const original = proto.pushInclude;
  proto.pushInclude = function (this: unknown, data, file, ...rest) {
    files.push(file);
    return original.call(this, data, file, ...rest);
  };
  try {
    return { value: await fn(), files };
  } finally {
    proto.pushInclude = original;
  }
}

async function convertFixture(relPath: string, sink: Set<string>) {
  const absPath = join(fixtures, relPath);
  const source = readFileSync(absPath, 'utf8');
  const logger = new MemoryLogger();
  const input = { path: absPath, read: () => source };
  const { value, files } = await withPushIncludeSpy(async () => {
    const doc = await loadSource(input, { safe: 'safe', standalone: false, logger });
    const html = await doc.convert();
    return { doc, html };
  });
  for (const file of files) {
    if (typeof file === 'string' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(file)) sink.add(file);
  }
  return { ...value, logger, absPath };
}

describe('recording includes through pushInclude', () => {
  it('records the absolute paths of all AsciiDoc, source code, nested, tag and lines includes', async () => {
    const sink = new Set<string>();
    const { html } = await convertFixture('main.adoc', sink);

    expect([...sink].sort()).toEqual(
      [
        join(fixtures, 'code.js'),
        join(fixtures, 'nested-a.adoc'),
        join(fixtures, 'partial.adoc'),
        join(fixtures, 'shared/nested-b.adoc'),
        join(fixtures, 'tagged.adoc'),
      ].sort(),
    );

    // The included content is in the output (the includes themselves work, not only the recording)
    expect(html).toContain('Text from partial.adoc.');
    expect(html).toContain('const c = 3;');
    expect(html).toContain('Text from nested-b.adoc.');
    expect(html).toContain('Text inside the keep tag.');
    expect(html).not.toContain('Text inside the drop tag.');
  });

  it('does not record a missing include target and logs it', async () => {
    const sink = new Set<string>();
    const { logger } = await convertFixture('main.adoc', sink);

    expect([...sink].some((p) => p.endsWith('missing.adoc'))).toBe(false);
    const messages = logger.getMessages().map((m) => ({
      severity: m.getSeverity(),
      text: m.getText(),
    }));
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('missing.adoc') }),
      ]),
    );
  });

  it('lists only AsciiDoc includes, without extensions, in catalog.includes (why the loader records its own)', async () => {
    const sink = new Set<string>();
    const { doc } = await convertFixture('main.adoc', sink);
    const keys = Object.keys(doc.getCatalog().includes).sort();
    expect(keys).not.toContain('code');
    expect(keys).toContain('partial');
  });
});

describe('{ path, read } input and relative includes from a subdirectory', () => {
  it('sets docfile, docdir and docname', async () => {
    const sink = new Set<string>();
    const { doc, absPath } = await convertFixture('sub/article.adoc', sink);
    expect(doc.getAttribute('docfile')).toBe(absPath);
    expect(doc.getAttribute('docdir')).toBe(dirname(absPath));
    expect(doc.getAttribute('docname')).toBe('article');
  });

  it('resolves relative includes from the directory of the article file', async () => {
    const sink = new Set<string>();
    const { html } = await convertFixture('sub/article.adoc', sink);
    expect(html).toContain('Text from sub/sibling.adoc.');
    expect(sink.has(join(fixtures, 'sub/sibling.adoc'))).toBe(true);
  });

  it('does not include files above the article directory in safe mode', async () => {
    const sink = new Set<string>();
    const { html, logger } = await convertFixture('sub/article.adoc', sink);
    expect(html).not.toContain('Text from partial.adoc.');
    expect(sink.has(join(fixtures, 'partial.adoc'))).toBe(false);
    // Something is logged about what happened
    const texts = logger.getMessages().map((m) => `${m.getSeverity()}: ${m.getText()}`);
    expect(texts.length).toBeGreaterThan(0);
  });
});

// The contract and messages that src/includes.ts relies on. If these fail after upgrading
// @asciidoctor/core, review src/includes.ts. It relies only on
// PreprocessorReader.prototype.pushInclude, which is in the public type definitions
// (types/reader.d.ts), and uses catalog.includes to detect broken tracking
describe('contract that include tracking relies on', () => {
  it('has PreprocessorReader.prototype.pushInclude as a function', () => {
    expect(typeof proto.pushInclude).toBe('function');
  });

  it('calls the prototype pushInclude with absolute paths for includes inside table cells (a|) too', async () => {
    const source = [
      'include::partial.adoc[]',
      '',
      '[cols="1a"]',
      '|===',
      '|',
      'include::tagged.adoc[tag=keep]',
      '|===',
    ].join('\n');
    const { value: html, files } = await withPushIncludeSpy(async () => {
      const doc = await loadSource(
        { path: join(fixtures, 'table.adoc'), read: () => source },
        { safe: 'safe', standalone: false },
      );
      return doc.convert();
    });
    expect(html).toContain('Text inside the keep tag.');
    expect(files).toEqual([join(fixtures, 'partial.adoc'), join(fixtures, 'tagged.adoc')]);
  });

  it('records includes of table cell documents in catalog.includes, which detection uses', async () => {
    const source = ['[cols="1a"]', '|===', '|', 'include::partial.adoc[]', '|==='].join('\n');
    const doc = await loadSource(
      { path: join(fixtures, 'table.adoc'), read: () => source },
      { safe: 'safe', standalone: false },
    );
    await doc.convert();
    expect(Object.keys(doc.getCatalog().includes)).toEqual(['partial']);
  });

  it('logs a fixed message for a missing include target with opts=optional', async () => {
    const logger = new MemoryLogger();
    const input = {
      path: join(fixtures, 'x.adoc'),
      read: () => 'include::no-such-file.adoc[opts=optional]',
    };
    const doc = await loadSource(input, { safe: 'safe', standalone: false, logger });
    await doc.convert();
    expect(logger.getMessages().map((m) => m.getText())).toEqual([
      `optional include dropped because include file not found: ${join(fixtures, 'no-such-file.adoc')}`,
    ]);
  });

  it('logs "include file not found: <absolute path>" for a missing include target', async () => {
    const logger = new MemoryLogger();
    const input = { path: join(fixtures, 'x.adoc'), read: () => 'include::no-such-file.adoc[]' };
    const doc = await loadSource(input, { safe: 'safe', standalone: false, logger });
    await doc.convert();
    expect(logger.getMessages().map((m) => m.getText())).toEqual([
      `include file not found: ${join(fixtures, 'no-such-file.adoc')}`,
    ]);
  });
});
