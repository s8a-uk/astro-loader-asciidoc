// E2E tests of the published tarball (make e2e-pack, make e2e-pack-pnpm). Run before publishing
// and on a schedule. Installs the tarball made by npm pack (or the one in PACK_TARBALL) into an
// empty project that has only Astro, then runs astro build. Slow, because dependencies are
// fetched from the registry.
//
// The project is created in the OS temporary directory (the container's /tmp). Inside the
// repository, module resolution would walk up to the repository's node_modules and hide missing
// dependencies such as shiki.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureSite = fileURLToPath(new URL('../fixtures/site/', import.meta.url));
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const lockfile = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
const astroVersion: string = lockfile.packages['node_modules/astro'].version;
const shikiVersion: string = lockfile.packages['node_modules/shiki'].version;
const manager = process.env.PACK_MANAGER === 'pnpm' ? 'pnpm' : 'npm';
const PNPM = 'pnpm@10.34.9';

let workDir = '';
let siteDir = '';

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', CI: '1' },
  });
}

function pm(args: string[]): string {
  return manager === 'pnpm'
    ? run('npx', ['--yes', PNPM, ...args], siteDir)
    : run('npm', [...args, '--no-audit', '--no-fund', '--loglevel=error'], siteDir);
}

function build() {
  const result = spawnSync(process.execPath, ['node_modules/astro/bin/astro.mjs', 'build'], {
    cwd: siteDir,
    encoding: 'utf8',
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', FORCE_COLOR: '0' },
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), `pack-e2e-${manager}-`));
  // PACK_TARBALL tests an existing tarball (the release workflow publishes the tarball it tested).
  // Otherwise pack one here; prepack removes dist and builds it again
  const tarball =
    process.env.PACK_TARBALL ||
    join(
      workDir,
      run('npm', ['pack', '--silent', '--pack-destination', workDir], repoRoot)
        .trim()
        .split('\n')
        .pop() as string,
    );

  siteDir = join(workDir, 'site');
  cpSync(fixtureSite, siteDir, {
    recursive: true,
    filter: (src) => !/[/\\](\.tmp|\.astro|dist|node_modules)$/.test(src),
  });
  writeFileSync(
    join(siteDir, 'package.json'),
    JSON.stringify({
      name: 'pack-e2e-site',
      private: true,
      type: 'module',
      dependencies: {
        astro: astroVersion,
        [manifest.name]: `file:${resolve(tarball)}`,
      },
    }),
  );
  pm(['install']);
});

afterAll(() => {
  // Remove only the temporary directory this test created
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

function checkOutput() {
  const page = readFileSync(join(siteDir, 'dist/notes/hello/index.html'), 'utf8');
  expect(page).toContain('<pre class="astro-code nord"');
  expect(page).toContain('<pre class="mermaid">');
  expect(page).toMatch(/ src="\/_astro\/diagram\.[\w-]+\.webp"/);
  expect(page).not.toContain('__ASTRO_IMAGE_');
  expect(existsSync(join(siteDir, 'dist/notes/sub/inner/index.html'))).toBe(true);
}

describe(`tarball E2E (${manager})`, () => {
  it('contains only dist and package.json', () => {
    const installed = join(siteDir, 'node_modules', manifest.name);
    expect(existsSync(join(installed, 'dist/index.js'))).toBe(true);
    expect(existsSync(join(installed, 'dist/index.d.ts'))).toBe(true);
    expect(existsSync(join(installed, 'src'))).toBe(false);
    expect(existsSync(join(installed, 'test'))).toBe(false);
  });

  if (manager === 'npm') {
    it('highlights code with npm without installing shiki (it comes with Astro)', () => {
      expect(existsSync(join(siteDir, 'node_modules/shiki/package.json'))).toBe(true);
      const result = build();
      expect(result.status, result.output).toBe(0);
      checkOutput();
    });
  } else {
    it('does not need shiki installed separately with the pnpm default (hoist=true)', () => {
      expect(existsSync(join(siteDir, 'node_modules/shiki'))).toBe(false);
      expect(existsSync(join(siteDir, 'node_modules/.pnpm/node_modules/shiki/package.json'))).toBe(
        true,
      );
      const result = build();
      expect(result.status, result.output).toBe(0);
      checkOutput();
    });

    // pnpm resolves the optional peer shiki to the shiki Astro depends on and links it next to this
    // package in its virtual store directory. The same with hoist=false. The directory name is not
    // checked: pnpm shortens long names (such as a tarball path) to a hash
    it('resolves shiki as a peer of this package with hoist=false, without installing it', () => {
      writeFileSync(join(siteDir, '.npmrc'), 'hoist=false\n');
      rmSync(join(siteDir, 'node_modules'), { recursive: true, force: true });
      rmSync(join(siteDir, 'dist'), { recursive: true, force: true });
      pm(['install']);
      expect(existsSync(join(siteDir, 'node_modules/.pnpm/node_modules/shiki'))).toBe(false);
      // <store>/<entry>/node_modules/@s8a-uk/astro-loader-asciidoc -> <store>/<entry>/node_modules
      const installed = realpathSync(join(siteDir, 'node_modules', manifest.name));
      const peer = join(installed, '..', '..', 'shiki', 'package.json');
      expect(existsSync(peer)).toBe(true);
      expect(JSON.parse(readFileSync(peer, 'utf8')).version).toBe(shikiVersion);
      const result = build();
      expect(result.status, result.output).toBe(0);
      checkOutput();
    });
  }
});
