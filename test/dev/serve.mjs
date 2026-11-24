// Used by `make dev`. Copies test/fixtures/site to tmp/dev-server/ and starts astro dev there.
// The copy keeps .astro (generated types and caches) separate from the E2E tests. It is recreated
// on every start
import { spawn } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const source = fileURLToPath(new URL('../fixtures/site/', import.meta.url));
// Astro does not pick up pages under a directory whose name starts with a dot
const target = `${repoRoot}tmp/dev-server`;

rmSync(target, { recursive: true, force: true });
cpSync(source, target, {
  recursive: true,
  filter: (src) => !/[/\\](\.tmp|\.astro|dist|node_modules)$/.test(src),
});

const child = spawn(
  process.execPath,
  [`${repoRoot}node_modules/astro/bin/astro.mjs`, 'dev', '--host', '0.0.0.0', '--port', '4321'],
  { cwd: target, stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 0));
