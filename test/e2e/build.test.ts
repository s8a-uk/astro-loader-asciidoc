// E2E tests. Runs a real astro build of test/fixtures/site and checks the generated HTML.
// The site imports this package by its package name, which resolves to the build in dist/ (Node's
// package self-referencing). Run npm run build first (make e2e does this).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const siteRoot = fileURLToPath(new URL('../fixtures/site/', import.meta.url));
const astroBin = join(repoRoot, 'node_modules/astro/bin/astro.mjs');

// Keep the output on the same file system as /workspace. Astro renames files during the build, so
// pointing it at the container's /tmp (a different file system) fails with EXDEV
const tmpRoot = join(siteRoot, '.tmp');
const createdDirs: string[] = [];

function newDirs() {
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, 'build-'));
  createdDirs.push(dir);
  return { outDir: join(dir, 'dist'), cacheDir: join(dir, 'cache') };
}

function build(dirs: { outDir: string; cacheDir: string }) {
  const result = spawnSync(process.execPath, [astroBin, 'build'], {
    cwd: siteRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ASTRO_TELEMETRY_DISABLED: '1',
      E2E_OUT_DIR: dirs.outDir,
      E2E_CACHE_DIR: dirs.cacheDir,
    },
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

const imgTags = (html: string) => html.match(/<img\b[^>]*>/g) ?? [];

afterAll(() => {
  // Remove only the temporary directories this test created
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

describe('astro build', () => {
  const dirs = newDirs();
  let first: ReturnType<typeof build>;
  const page = (id: string) => readFileSync(join(dirs.outDir, 'notes', id, 'index.html'), 'utf8');

  beforeAll(() => {
    if (!existsSync(join(repoRoot, 'dist/index.js'))) {
      throw new Error('dist/ is missing. Run npm run build first');
    }
    first = build(dirs);
  });

  it('generates an HTML page for each document', () => {
    expect(first.status, first.output).toBe(0);
    for (const id of ['hello', 'draft', 'sub/inner']) {
      expect(existsSync(join(dirs.outDir, 'notes', id, 'index.html')), id).toBe(true);
    }
    // Files and directories starting with _ (meant for include) are excluded by the default pattern
    expect(existsSync(join(dirs.outDir, 'notes', '_partial'))).toBe(false);
    expect(existsSync(join(dirs.outDir, 'notes', '_parts'))).toBe(false);
  });

  it('uses the data validated and transformed by the schema', () => {
    expect(page('hello')).toContain(
      '<p id="meta" data-date="2026-11-17T00:00:00.000Z" data-tags="astro|asciidoc" data-draft="false">',
    );
    expect(page('draft')).toContain('data-draft="true"');
    // :draft: false is the string 'false', which the schema (z.stringbool()) turns into false
    expect(page('sub/inner')).toContain('data-draft="false"');
    expect(page('hello')).toContain('<title>Hello AsciiDoc</title>');
  });

  it('puts header attribute values into data as strings with character references decoded', () => {
    // Astro escapes & and " in attribute values (but not < and >). There is no double escaping
    // (&amp;amp;)
    expect(page('hello')).toContain(
      '<meta name="description" content="Fish &amp; Chips <small> &quot;quoted&quot;">',
    );
  });

  it('type-checks the site content config against the .d.ts files in dist with tsc', () => {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', siteRoot, '--noEmit'],
      { cwd: siteRoot, encoding: 'utf8' },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('gives headings ids like hello-world that match the slugs in headings', () => {
    const html = page('hello');
    const toc = [
      ...html.matchAll(/<li data-depth="(\d)"><a href="#([^"]+)">([^<]+)<\/a><\/li>/g),
    ].map((m) => [Number(m[1]), m[2], m[3]]);
    expect(toc).toEqual([
      [2, 'hello-world', 'Hello World'],
      [3, 'source-code', 'Source Code'],
      [2, 'included-content', 'Included Content'],
      [2, 'diagram', 'Diagram'],
      [2, 'images', 'Images'],
    ]);
    for (const [, slug] of toc) expect(html).toMatch(new RegExp(`<h[23] id="${slug}">`));
  });

  it('renders code blocks with the astro-code class and the markdown.shikiConfig theme', () => {
    const html = page('hello');
    expect(html).toContain(
      '<pre class="astro-code nord" style="background-color:#2e3440ff;color:#d8dee9ff; overflow-x: auto;" tabindex="0" data-language="js">',
    );
    // Token boundaries are not checked. When tokenizing a line takes longer than tokenizeTimeLimit
    // (500ms by default), Shiki puts the rest of the line into a single token. The first
    // tokenization includes compiling the regular expressions and can exceed the limit under heavy
    // load
    // (regardless of the Node version; Astro's Markdown runs with the same default)
    expect(html).toMatch(/<span style="color:#81A1C1">const/);
    expect(html).toContain('<b class="conum">(1)</b>');
  });

  it('outputs <pre class="mermaid">', () => {
    expect(page('hello')).toContain('<pre class="mermaid">graph TD\n  A --&gt; B</pre>');
  });

  it('includes the content of included files in the output', () => {
    expect(page('hello')).toContain('This paragraph comes from an included file.');
    expect(page('hello')).toContain('This paragraph comes from a file in an underscore directory.');
  });

  it('rewrites images to optimized paths that exist in dist, leaving no __ASTRO_IMAGE_', () => {
    const hello = page('hello');
    const inner = page('sub/inner');
    expect(hello).not.toContain('__ASTRO_IMAGE_');
    expect(inner).not.toContain('__ASTRO_IMAGE_');

    const [block, inline, remote] = imgTags(hello);
    expect(block).toMatch(/ src="\/_astro\/diagram\.[\w-]+\.webp"/);
    expect(block).toContain('alt="A &quot;quoted&quot; &amp; ampersand alt"');
    expect(block).toContain('width="160"');
    expect(inline).toMatch(/ src="\/_astro\/diagram\.[\w-]+\.webp"/);
    expect(inline).toContain('width="40"');
    expect(remote).toBe('<img src="https://example.com/remote.png" alt="Remote">');

    const [photo] = imgTags(inner);
    expect(photo).toMatch(/ src="\/_astro\/photo\.[\w-]+\.webp"/);
    expect(photo).toContain('width="240"');

    for (const tag of [block, inline, photo]) {
      const src = /src="([^"]+)"/.exec(tag ?? '')?.[1] ?? '';
      expect(existsSync(join(dirs.outDir, src)), src).toBe(true);
    }
  });

  it('produces the same output when built again with the data store cache', () => {
    const before = ['hello', 'draft', 'sub/inner'].map(page);
    const second = build(dirs);
    expect(second.status, second.output).toBe(0);
    expect(['hello', 'draft', 'sub/inner'].map(page)).toEqual(before);
  });
});
