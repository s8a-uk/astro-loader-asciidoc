import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeMarkerValue, markImages } from '../../src/images.js';
import { createLogger, fixturesDir } from '../helpers.js';

// fixtures/docs/images/ contains a.png, sub/b.png and my image.png
const absPath = join(fixturesDir, 'images/article.adoc');

function mark(html: string) {
  const logger = createLogger();
  return { ...markImages(html, absPath, logger, 'images/article.adoc'), logger };
}

function marker(html: string): Record<string, unknown> {
  const raw = /__ASTRO_IMAGE_="([^"]*)"/.exec(html)?.[1];
  if (raw === undefined) throw new Error(`no marker in ${html}`);
  // Decode in the same order as runtime.js in Astro 7.4
  return JSON.parse(
    raw
      .replace(/&(?:#x22|quot);/g, '"')
      .replace(/&(?:#x27|apos);/g, "'")
      .replace(/&(?:amp|#x26|#38);/g, '&'),
  );
}

describe('markImages', () => {
  it('marks an image with a relative path, leaving only class outside the marker', () => {
    const { html, imagePaths } = mark('<img class="frame" src="a.png" alt="Alt" width="600">');
    expect(html).toBe(
      '<img class="frame" __ASTRO_IMAGE_="{&quot;alt&quot;:&quot;Alt&quot;,&quot;width&quot;:600,&quot;src&quot;:&quot;./a.png&quot;,&quot;index&quot;:0}">',
    );
    expect(imagePaths).toEqual(['./a.png']);
  });

  it.each([
    ['already marked', '<img __ASTRO_IMAGE_="{}" src="a.png">'],
    ['no src', '<img alt="x">'],
    ['empty src', '<img src="">'],
    ['unquoted src', '<img src=a.png>'],
    ['URL', '<img src="https://example.com/a.png">'],
    ['data: URI', '<img src="data:image/png;base64,AAAA">'],
    ['starts with /', '<img src="/images/a.png">'],
    ['contains ?', '<img src="a.png?v=1">'],
    ['contains #', '<img src="a.png#x">'],
    ['unsupported extension', '<img src="a.bmp">'],
    ['no extension', '<img src="a">'],
  ])('leaves the image alone: %s', (_name, input) => {
    const { html, imagePaths, logger } = mark(input);
    expect(html).toBe(input);
    expect(imagePaths).toEqual([]);
    expect(logger.records).toEqual([]);
  });

  it('warns and leaves the image as is when the file does not exist', () => {
    const input = '<img src="missing.png" alt="x">';
    const { html, imagePaths, logger } = mark(input);
    expect(html).toBe(input);
    expect(imagePaths).toEqual([]);
    expect(logger.messages('warn')).toEqual([
      'images/article.adoc: image "missing.png" was not found and is left as is.',
    ]);
  });

  it('matches extensions case-insensitively, keeps ../ and ./, and handles subdirectories', () => {
    const { imagePaths } = mark(
      '<img src="sub/b.png"><img src="./a.png"><img src="../images/a.png"><img src="sub/B.PNG">',
    );
    // sub/B.PNG does not exist because the file name differs in case (on Linux)
    expect(imagePaths).toEqual(['./sub/b.png', './a.png', '../images/a.png']);
  });

  it('decodes character references and URI encoding', () => {
    const { html, imagePaths } = mark('<img src="my%20image.png" alt="A &amp; &quot;B&quot;">');
    expect(imagePaths).toEqual(['./my image.png']);
    expect(marker(html)).toEqual({ alt: 'A & "B"', src: './my image.png', index: 0 });
  });

  it('turns width and height into numbers when they are digits only, otherwise drops them with a warning', () => {
    const { html, logger } = mark('<img src="a.png" width="50%" height=" 30 ">');
    expect(marker(html)).toEqual({ height: 30, src: './a.png', index: 0 });
    expect(logger.messages('warn')).toEqual([
      'images/article.adoc: image "a.png" has a non-numeric width ("50%"), which is ignored.',
    ]);
  });

  it('counts occurrences of the same src as index and returns the paths without duplicates', () => {
    const { html, imagePaths } = mark('<img src="a.png"><img src="sub/b.png"><img src="./a.png">');
    const indexes = [...html.matchAll(/__ASTRO_IMAGE_="([^"]*)"/g)].map(
      (m) => marker(m[0] ?? '').index,
    );
    expect(indexes).toEqual([0, 0, 1]);
    expect(imagePaths).toEqual(['./a.png', './sub/b.png']);
  });

  it('escapes the JSON by replacing & first and " second, so Astro decodes it to the original value', () => {
    expect(encodeMarkerValue('{"a":"x & y &amp; z"}')).toBe(
      '{&quot;a&quot;:&quot;x &amp; y &amp;amp; z&quot;}',
    );
    const { html } = mark('<img src="a.png" alt="&quot;&amp;amp;&quot; &lt;x&gt;">');
    expect(marker(html).alt).toBe('"&amp;" <x>');
    // No bare " inside the marker value (< stays as is; it is allowed inside an attribute value)
    expect(html).toBe(
      '<img __ASTRO_IMAGE_="{&quot;alt&quot;:&quot;\\&quot;&amp;amp;\\&quot; <x>&quot;,&quot;src&quot;:&quot;./a.png&quot;,&quot;index&quot;:0}">',
    );
  });

  it('handles a self-closing /', () => {
    const { imagePaths } = mark('<img src="a.png" />');
    expect(imagePaths).toEqual(['./a.png']);
  });
});

describe('markImages scope and attributes', () => {
  it('does not mark <img> inside HTML comments, <script> or <style>', () => {
    const input =
      '<!-- <img src="a.png"> --><script>const s = \'<img src="a.png">\';</script>' +
      '<style>/* <img src="a.png"> */</style><img src="a.png">';
    const { html, imagePaths } = mark(input);
    expect(html.startsWith('<!-- <img src="a.png"> --><script>')).toBe(true);
    expect(html).toContain('<style>/* <img src="a.png"> */</style>');
    expect(html.match(/__ASTRO_IMAGE_/g)).toHaveLength(1);
    expect(imagePaths).toEqual(['./a.png']);
  });

  it('puts only the attributes meaningful for the image into the marker and leaves the rest outside', () => {
    const { html } = mark(
      '<img src="a.png" alt="A" title="T" loading="lazy" decoding="async" style="x&quot;y" data-x="1" id="pic" class="c">',
    );
    expect(marker(html)).toEqual({
      alt: 'A',
      title: 'T',
      loading: 'lazy',
      decoding: 'async',
      src: './a.png',
      index: 0,
    });
    expect(html).toMatch(/^<img style="x&quot;y" data-x="1" id="pic" class="c" __ASTRO_IMAGE_="/);
  });

  it('returns the absolute paths of missing images without duplicates', () => {
    const { missing } = mark(
      '<img src="missing.png"><img src="./missing.png"><img src="sub/none.png">',
    );
    expect(missing).toEqual([
      join(fixturesDir, 'images/missing.png'),
      join(fixturesDir, 'images/sub/none.png'),
    ]);
  });
});
