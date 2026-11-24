// Runs random sequences of operations and, after each step, compares the store with the result of
// an initial sync of the same tree
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { type AsciidocLoaderOptions, asciidocLoader } from '../../src/index.js';
import { FakeProject } from './fake-context.js';

const projects: FakeProject[] = [];
afterEach(() => {
  for (const p of projects.splice(0)) p.dispose();
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

const OPTIONS: AsciidocLoaderOptions = { base: 'notes', syntaxHighlight: false };

/** Seeded pseudo-random numbers (mulberry32) */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)] as T;
  const chance = (p: number) => next() < p;
  return { int, pick, chance };
}

type Rng = ReturnType<typeof random>;

const ARTICLES = ['notes/a.adoc', 'notes/b.adoc', 'notes/c.adoc', 'notes/sub/d.adoc'];
const PARTIALS = ['notes/_p1.adoc', 'notes/_p2.adoc'];
const IMAGES = ['notes/img1.png', 'notes/img2.png'];

/** A document body. May contain colliding slugs, includes, includes in table cells and images */
function article(rng: Rng, path: string, version: number): string {
  const lines = [`= ${path} v${version}`];
  if (rng.chance(0.4)) lines.push(`:slug: ${rng.pick(['same', 'other'])}`);
  lines.push('', `Body ${version}.`, '');
  // Includes and images in a document in a subdirectory are resolved from that directory (so they
  // become missing dependencies)
  if (rng.chance(0.5)) lines.push(`include::${rng.pick(['_p1', '_p2'])}.adoc[]`, '');
  if (rng.chance(0.3)) lines.push('|===', `a|include::_p2.adoc[]`, '|===', '');
  if (rng.chance(0.5)) lines.push(`image::${rng.pick(['img1', 'img2'])}.png[Pic]`, '');
  return `${lines.join('\n')}\n`;
}

type OpKind =
  | 'article'
  | 'deleteArticle'
  | 'partial'
  | 'deletePartial'
  | 'image'
  | 'deleteImage'
  | 'restart';

interface Scenario {
  name: string;
  seed: number;
  steps: number;
  /**
   * watch: send a watcher event after each operation. build: run a full sync with a new loader
   * after each operation
   */
  mode: 'watch' | 'build';
  kinds: OpKind[];
}

type Snapshot = Record<string, unknown>;

function snapshot(p: FakeProject): Snapshot {
  const result: Snapshot = {};
  for (const id of p.store.keys().sort()) {
    const e = p.store.get(id) as {
      filePath?: string;
      data: unknown;
      rendered?: { html: string; metadata: Record<string, unknown> };
    };
    result[id] = {
      filePath: e.filePath,
      data: e.data,
      html: e.rendered?.html,
      imagePaths: e.rendered?.metadata.imagePaths,
    };
  }
  return result;
}

/** The result of an initial sync of the same tree with an empty store and meta */
async function fresh(p: FakeProject): Promise<Snapshot> {
  const q = new FakeProject({ root: p.root });
  projects.push(q);
  await asciidocLoader(OPTIONS).load(q.context());
  return snapshot(q);
}

/** Runs the operations and compares the store with an initial sync after each step */
async function run(scenario: Scenario): Promise<void> {
  const rng = random(scenario.seed);
  const watch = scenario.mode === 'watch';
  const p = new FakeProject({ watcher: watch });
  projects.push(p);
  const log: string[] = [];
  let version = 0;

  // Initial tree
  for (const path of ARTICLES.slice(0, 3)) p.write(path, article(rng, path, version));
  for (const path of PARTIALS) p.write(path, `Partial ${path} v0.`);
  p.write(IMAGES[0] as string, PNG);
  await asciidocLoader(OPTIONS).load(p.context());

  const event = async (kind: 'add' | 'change' | 'unlink', path: string) => {
    if (watch) await p.watcher?.trigger(kind, p.path(path));
    else await asciidocLoader(OPTIONS).load(p.context());
  };
  const write = async (path: string, content: string | Buffer) => {
    const existed = existsSync(p.path(path));
    p.write(path, content);
    await event(existed ? 'change' : 'add', path);
  };
  const remove = async (path: string) => {
    if (!existsSync(p.path(path))) return;
    p.remove(path);
    await event('unlink', path);
  };

  for (let step = 0; step < scenario.steps; step++) {
    version++;
    const kind = rng.pick(scenario.kinds);
    switch (kind) {
      case 'article': {
        const path = rng.pick(ARTICLES);
        log.push(`write ${path}`);
        await write(path, article(rng, path, version));
        break;
      }
      case 'deleteArticle': {
        const path = rng.pick(ARTICLES);
        log.push(`delete ${path}`);
        await remove(path);
        break;
      }
      case 'partial': {
        const path = rng.pick(PARTIALS);
        log.push(`write ${path}`);
        await write(path, `Partial ${path} v${version}.`);
        break;
      }
      case 'deletePartial': {
        const path = rng.pick(PARTIALS);
        log.push(`delete ${path}`);
        await remove(path);
        break;
      }
      case 'image': {
        const path = rng.pick(IMAGES);
        log.push(`write ${path}`);
        await write(path, PNG);
        break;
      }
      case 'deleteImage': {
        const path = rng.pick(IMAGES);
        log.push(`delete ${path}`);
        await remove(path);
        break;
      }
      case 'restart': {
        log.push('restart');
        await asciidocLoader(OPTIONS).load(p.context());
        break;
      }
    }
    expect(snapshot(p), log.join('\n')).toEqual(await fresh(p));
  }
}

const WITHOUT_IMAGE_DELETE: OpKind[] = [
  'article',
  'article',
  'deleteArticle',
  'partial',
  'deletePartial',
  'image',
  'restart',
];
const WITH_IMAGE_DELETE: OpKind[] = [...WITHOUT_IMAGE_DELETE, 'deleteImage', 'deleteImage'];

const scenarios: Scenario[] = [
  { name: 'watch', seed: 1, steps: 40, mode: 'watch', kinds: WITHOUT_IMAGE_DELETE },
  { name: 'watch', seed: 2, steps: 40, mode: 'watch', kinds: WITHOUT_IMAGE_DELETE },
  { name: 'build', seed: 3, steps: 25, mode: 'build', kinds: WITHOUT_IMAGE_DELETE },
  {
    name: 'watch (with image deletion)',
    seed: 101,
    steps: 40,
    mode: 'watch',
    kinds: WITH_IMAGE_DELETE,
  },
  {
    name: 'build (with image deletion)',
    seed: 5,
    steps: 25,
    mode: 'build',
    kinds: WITH_IMAGE_DELETE,
  },
];

describe('the store after random operations matches an initial sync', () => {
  // Each run usually takes about 0.5 s, but under heavy load (in CI, for example) it can exceed the
  // default 5 s timeout, so use a longer one
  it.each(scenarios)(
    '$name (seed $seed, $steps steps)',
    async (scenario) => {
      await run(scenario);
    },
    30_000,
  );
});
