// Checks behavior on a real astro dev server. Run with make test-dev (npm run test:dev).
// Copies test/fixtures/site under tmp/dev-sites/, starts astro dev there, and checks how the HTML
// changes while files are edited. Only the copy is edited, so the fixture and the E2E tests are
// unaffected. The tests run in order and build on the state left by the previous ones.
import { type ChildProcess, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureSite = fileURLToPath(new URL('../fixtures/site/', import.meta.url));
const astroBin = join(repoRoot, 'node_modules/astro/bin/astro.mjs');
const port = Number(process.env.DEV_TEST_PORT ?? 4399);
const origin = `http://127.0.0.1:${port}`;

let siteDir = '';
let server: ChildProcess | undefined;
let output = '';

const notes = (rel: string) => join(siteDir, 'src/content/notes', rel);
const read = (path: string) => readFileSync(path, 'utf8');
const write = (path: string, content: string | Buffer) => writeFileSync(path, content);

async function get(path: string): Promise<{ status: number; html: string }> {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, html: await response.text() };
}

/** Fetches the page until the predicate holds. On timeout, fails with the last HTML attached */
async function waitForPage(
  path: string,
  predicate: (html: string, status: number) => boolean,
  timeout = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeout;
  let last = { status: 0, html: '' };
  while (Date.now() < deadline) {
    try {
      last = await get(path);
      if (predicate(last.html, last.status)) return last.html;
    } catch {
      // e.g. while the server is restarting
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `timed out waiting for ${path} (status ${last.status})\n--- html ---\n${last.html.slice(0, 2000)}\n--- server output ---\n${output.slice(-4000)}`,
  );
}

async function waitForOutput(pattern: RegExp, from: number, timeout = 20_000): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const match = pattern.exec(output.slice(from));
    if (match) return match[0];
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${pattern} in server output:\n${output.slice(from)}`);
}

/** Creates a single-color PNG */
function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const x of buf) c = (table[(c ^ x) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from([r, g, b]))]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Content config of the copied site. It imports transformHtml from another module (used by the test
 * on edits to modules imported by the content config)
 */
const CONTENT_CONFIG = `import { asciidocLoader } from '@s8a-uk/astro-loader-asciidoc';
import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { transformHtml } from './loader-hooks';

const notes = defineCollection({
  loader: asciidocLoader({
    base: './src/content/notes',
    mermaid: true,
    transformHtml,
  }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    tags: z.string().default('').transform((s) => s.split(',').map((t) => t.trim()).filter(Boolean)),
    draft: z.union([z.boolean(), z.stringbool()]).default(false),
  }),
});

export const collections = { notes };
`;

// Throws for documents containing BOOM (used by the transformHtml error test)
const hooks = (marker: string) => `export const transformHtml = (html: string) => {
  if (html.includes('BOOM')) throw new Error('hook exploded');
  return \`\${html}<p id="hook-marker">${marker}</p>\`;
};
`;

/**
 * Environment of the child process. Passing on NODE_ENV=test and VITEST* set by vitest makes
 * astro dev stop serving pages (/ returns 404), so they are removed
 */
function serverEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ASTRO_TELEMETRY_DISABLED: '1',
    FORCE_COLOR: '0',
  };
  delete env.NODE_ENV;
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITEST') || key === 'TEST' || key === 'MODE') delete env[key];
  }
  return env;
}

beforeAll(async () => {
  // Astro does not pick up pages under a directory whose name starts with a dot (/ returns 404)
  const tmpRoot = join(repoRoot, 'tmp/dev-sites');
  mkdirSync(tmpRoot, { recursive: true });
  siteDir = mkdtempSync(join(tmpRoot, 'dev-site-'));
  cpSync(fixtureSite, siteDir, {
    recursive: true,
    filter: (src) => !/[/\\](\.tmp|\.astro|dist|node_modules)$/.test(src),
  });
  write(join(siteDir, 'src/content.config.ts'), CONTENT_CONFIG);
  write(join(siteDir, 'src/loader-hooks.ts'), hooks('hook v1'));

  server = spawn(
    process.execPath,
    [astroBin, 'dev', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: siteDir,
      env: serverEnv(),
    },
  );
  server.stdout?.on('data', (d) => {
    output += String(d);
  });
  server.stderr?.on('data', (d) => {
    output += String(d);
  });
  await waitForPage('/', (html, status) => status === 200 && html.includes('id="notes"'), 60_000);
}, 90_000);

afterAll(async () => {
  // Set DEV_TEST_LOG to a path to save the server output there (for debugging)
  if (process.env.DEV_TEST_LOG) writeFileSync(process.env.DEV_TEST_LOG, output);
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((r) => server?.once('exit', r));
  }
  // Remove only the temporary directory this test created
  if (siteDir) rmSync(siteDir, { recursive: true, force: true });
});

describe('astro dev', () => {
  it('serves the index and the documents on startup', async () => {
    const index = await waitForPage('/', () => true);
    for (const id of ['hello', 'draft', 'sub/inner']) expect(index).toContain(`data-id="${id}"`);
    const hello = await waitForPage('/notes/hello/', (_, s) => s === 200);
    expect(hello).toContain('<pre class="mermaid">');
    expect(hello).toContain('This paragraph comes from an included file.');
    expect(hello).toContain('<p id="hook-marker">hook v1</p>');
    expect(hello).toMatch(/<pre class="astro-code nord"/);
    expect(hello).toMatch(/<img [^>]*src="\/_image\?href=[^"]*diagram\.png/);
  });

  it('updates the page when a document is edited', async () => {
    const from = output.length;
    write(
      notes('hello.adoc'),
      read(notes('hello.adoc')).replace('A paragraph with', 'An edited paragraph with'),
    );
    await waitForPage('/notes/hello/', (html) => html.includes('An edited paragraph with'));
    expect(await waitForOutput(/Reloaded src\/content\/notes\/hello\.adoc/, from)).toBeTruthy();
  });

  it('reprocesses the including document when an included file is edited', async () => {
    const from = output.length;
    write(notes('_partial.adoc'), 'This paragraph was edited in the partial.\n');
    await waitForPage('/notes/hello/', (html) =>
      html.includes('This paragraph was edited in the partial.'),
    );
    expect(await waitForOutput(/Reloaded src\/content\/notes\/hello\.adoc/, from)).toBeTruthy();
    // The partial itself does not become an entry
    expect((await get('/')).html).not.toContain('data-id="_partial"');
  });

  it('adds and removes index entries when documents are added and deleted', async () => {
    write(notes('added.adoc'), '= Added Note\n:date: 2026-11-18\n\nNew article.\n');
    await waitForPage('/', (html) => html.includes('data-id="added"'));
    expect(await waitForPage('/notes/added/', (_, s) => s === 200)).toContain('New article.');

    rmSync(notes('added.adoc'));
    await waitForPage('/', (html) => !html.includes('data-id="added"'));
  });

  it('updates the page when an image is replaced', async () => {
    // 320x200 → 64x48. width=160 stays as specified, so height changes from 100 to 120
    const before = await waitForPage('/notes/hello/', () => true);
    expect(before).toMatch(/<img [^>]*height="100"[^>]*>|<img [^>]*height="100"/);
    write(notes('diagram.png'), png(64, 48, [40, 160, 40]));
    await waitForPage('/notes/hello/', (html) =>
      /<img [^>]*width="160"[^>]*height="120"/.test(html),
    );
  });

  // Records the current behavior of Astro 7.4.12. This is a limitation of Astro, not of this
  // loader: the built-in glob() loader and Markdown plugins behave the same way. When only a module
  // imported by the content config changes, Astro neither reloads the content config nor syncs.
  // When the content config itself changes, Astro clears the store, syncs again and uses the new
  // functions. If Astro's behavior changes and this test fails, revise the explanation in README
  // ("Caching and when you need --force")
  it('does not apply edits to a module imported by the content config until the content config changes', async () => {
    const from = output.length;
    write(join(siteDir, 'src/loader-hooks.ts'), hooks('hook v2'));
    // Just waiting could mistake "not applied yet" on a slow machine for "not applied". So also
    // edit a document, and check whether the hooks change was applied only after the document edit
    // shows up (that is, after the loader has run)
    write(
      notes('draft.adoc'),
      read(notes('draft.adoc')).replace('Work in progress.', 'Work in progress (probe).'),
    );
    await waitForPage('/notes/draft/', (html) => html.includes('Work in progress (probe).'));
    const stale = await waitForPage('/notes/draft/', (_, s) => s === 200);
    expect(stale).toContain('<p id="hook-marker">hook v1</p>');
    expect(output.slice(from)).not.toContain('Syncing content');

    const config = join(siteDir, 'src/content.config.ts');
    write(config, `${read(config)}\n// touched\n`);
    await waitForPage(
      '/notes/hello/',
      (html) => html.includes('<p id="hook-marker">hook v2</p>'),
      30_000,
    );
    expect(await waitForOutput(/Clearing content store/, from)).toBeTruthy();
  });

  it('missing include: logs an error without crashing and recovers when fixed', async () => {
    const original = read(notes('hello.adoc'));
    const from = output.length;
    write(notes('hello.adoc'), `${original}\ninclude::_missing.adoc[]\n`);
    await waitForOutput(/hello\.adoc:\d+: include file not found: .*_missing\.adoc/, from);
    // The entry is still stored, so the page is served
    const broken = await waitForPage(
      '/notes/hello/',
      (html, s) => s === 200 && html.includes('_missing.adoc'),
    );
    expect(broken).toContain('Unresolved directive');

    write(notes('hello.adoc'), original);
    await waitForPage('/notes/hello/', (html, s) => s === 200 && !html.includes('_missing.adoc'));
  });

  it('invalid data: logs an error without crashing and recovers when fixed', async () => {
    const original = read(notes('draft.adoc'));
    const from = output.length;
    write(notes('draft.adoc'), original.replace(':date: 2026-11-16', ':date: not-a-date'));
    await waitForOutput(/draft/, from);
    await waitForOutput(/\[ERROR\]|error/i, from);
    expect(server?.exitCode).toBeNull();
    expect((await get('/')).status).toBe(200);

    write(
      notes('draft.adoc'),
      original.replace(/Work in progress[^\n]*/, 'Work in progress, fixed.'),
    );
    await waitForPage(
      '/notes/draft/',
      (html, s) => s === 200 && html.includes('Work in progress, fixed.'),
    );
  });

  it('transformHtml error: keeps the previous content without crashing and recovers when fixed', async () => {
    const from = output.length;
    const original = read(notes('hello.adoc'));
    write(notes('hello.adoc'), `${original}\nBOOM\n`);
    await waitForOutput(/Failed to convert src\/content\/notes\/hello\.adoc: hook exploded/, from);
    const kept = await waitForPage('/notes/hello/', (_, s) => s === 200);
    expect(kept).not.toContain('BOOM');
    expect(kept).toContain('hook v2');

    write(
      notes('hello.adoc'),
      original.replace('An edited paragraph with', 'A recovered paragraph with'),
    );
    await waitForPage('/notes/hello/', (html) => html.includes('A recovered paragraph with'));
    expect(server?.exitCode).toBeNull();
  });

  it('applies an image that was missing once it is added', async () => {
    const from = output.length;
    write(notes('draft.adoc'), `${read(notes('draft.adoc'))}\nimage::later.png[Later image]\n`);
    await waitForOutput(/draft\.adoc: image "later\.png" was not found/, from);
    await waitForPage('/notes/draft/', (html) =>
      html.includes('<img src="later.png" alt="Later image">'),
    );

    write(notes('later.png'), png(30, 20, [200, 200, 0]));
    await waitForPage('/notes/draft/', (html) =>
      /<img [^>]*alt="Later image"[^>]*src="\/_image\?href=[^"]*later\.png/.test(html),
    );
  });
});
