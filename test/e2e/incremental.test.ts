// A cached build where only some documents changed.
// Copies the site to tmp/e2e-sites/ and builds it twice with the same cacheDir. Before the second
// build, one document is edited, one is moved to another directory (keeping its slug), and one gets
// an image added.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureSite = fileURLToPath(new URL('../fixtures/site/', import.meta.url));
const astroBin = join(repoRoot, 'node_modules/astro/bin/astro.mjs');

/** A 1x1 PNG (its content differs from the other images in the fixture) */
const ADDED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

/** A 2x1 PNG (its content differs from the other images) */
const LATER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGPgOiGnYWQDAAW7AYdYAjx3AAAAAElFTkSuQmCC',
  'base64',
);

let siteDir = '';
const notes = (rel: string) => join(siteDir, 'src/content/notes', rel);
const out = (rel: string) => join(siteDir, 'out', rel);

function build() {
  const result = spawnSync(process.execPath, [astroBin, 'build'], {
    cwd: siteDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ASTRO_TELEMETRY_DISABLED: '1',
      FORCE_COLOR: '0',
      E2E_OUT_DIR: join(siteDir, 'out'),
      E2E_CACHE_DIR: join(siteDir, 'cache'),
    },
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

beforeAll(() => {
  // Place it inside the repository, so that the site can import this package by its package name.
  // Astro does not pick up pages under a directory whose name starts with a dot, so use tmp/
  const root = join(repoRoot, 'tmp/e2e-sites');
  mkdirSync(root, { recursive: true });
  siteDir = mkdtempSync(join(root, 'incremental-'));
  cpSync(fixtureSite, siteDir, {
    recursive: true,
    filter: (src) => !/[/\\](\.tmp|\.astro|dist|node_modules)$/.test(src),
  });
  // A document that references an image missing in the first build (before the second build, the
  // image is added without changing the document)
  writeFileSync(
    notes('waiting.adoc'),
    '= Waiting Note\n:date: 2026-11-18\n\nimage::later.png[Later image]\n',
  );
  // Give the document to be moved a slug from the start, so that its id survives the move
  writeFileSync(
    notes('sub/inner.adoc'),
    readFileSync(notes('sub/inner.adoc'), 'utf8').replace(':date:', ':slug: sub/inner\n:date:'),
  );
});

afterAll(() => {
  // Remove only the temporary directory this test created
  if (siteDir) rmSync(siteDir, { recursive: true, force: true });
});

describe('cached build after changing some documents', () => {
  it('applies edits, moves and added images, and keeps unchanged pages as they are', () => {
    const first = build();
    expect(first.status, first.output).toBe(0);
    const draftBefore = readFileSync(out('notes/draft/index.html'), 'utf8');
    expect(first.output).toContain('image "later.png" was not found');
    expect(readFileSync(out('notes/waiting/index.html'), 'utf8')).toContain(
      '<img src="later.png" alt="Later image">',
    );

    // Edit one document
    writeFileSync(
      notes('hello.adoc'),
      readFileSync(notes('hello.adoc'), 'utf8').replace(
        'A paragraph with',
        'An updated paragraph with',
      ),
    );
    // Move one document, with its image, to another directory (same slug)
    mkdirSync(notes('moved/deeper'), { recursive: true });
    renameSync(notes('sub'), notes('moved/deeper/sub'));
    // Add an image to one document (write the file first, then reference it from the document).
    // An image with the same content as another one would be merged into one by Vite under a
    // different name, so use an image with different content
    writeFileSync(notes('added.png'), ADDED_PNG);
    writeFileSync(
      notes('draft.adoc'),
      `${readFileSync(notes('draft.adoc'), 'utf8')}\nimage::added.png[Added image]\n`,
    );

    // Add only the image that was missing, without changing the document (with content that differs
    // from the other images)
    writeFileSync(notes('later.png'), LATER_PNG);

    const second = build();
    expect(second.status, second.output).toBe(0);
    expect(second.output).not.toContain('ImageNotFound');

    const hello = readFileSync(out('notes/hello/index.html'), 'utf8');
    expect(hello).toContain('An updated paragraph with');
    expect(hello, (hello.match(/<img\b[^>]*>/g) ?? []).join('\n')).toMatch(
      / src="\/_astro\/diagram\.[\w-]+\.webp"/,
    );

    // The moved document keeps its URL and its image is still optimized
    const inner = readFileSync(out('notes/sub/inner/index.html'), 'utf8');
    expect(inner).toMatch(/ src="\/_astro\/photo\.[\w-]+\.webp"/);
    expect(inner).not.toContain('__ASTRO_IMAGE_');

    const draft = readFileSync(out('notes/draft/index.html'), 'utf8');
    expect(draft).not.toBe(draftBefore);
    expect(draft).toMatch(/<img [^>]*alt="Added image"[^>]*src="\/_astro\/added\.[\w-]+\.webp"/);

    const waiting = readFileSync(out('notes/waiting/index.html'), 'utf8');
    expect(waiting).toMatch(/<img [^>]*alt="Later image"[^>]*src="\/_astro\/later\.[\w-]+\.webp"/);
    expect(second.output).not.toContain('was not found');

    for (const html of [hello, inner, draft, waiting]) {
      for (const src of html.match(/\/_astro\/[\w.-]+\.webp/g) ?? []) {
        expect(existsSync(out(src)), src).toBe(true);
      }
    }
  });
});
