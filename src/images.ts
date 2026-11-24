// Adds Astro's image markers to the images in the HTML, so that `render(entry)` replaces them
// with optimized images, as for images in Markdown
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AstroIntegrationLogger } from 'astro';
import { parseAttributes } from './html.js';

/** VALID_INPUT_FORMATS of Astro 7 */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpeg',
  'jpg',
  'png',
  'apng',
  'tiff',
  'webp',
  'gif',
  'svg',
  'avif',
]);

/**
 * Finds `<img>`. Skips HTML comments, `<script>` and `<style>` (no marker for `<img>` inside them)
 */
const SCAN_RX =
  /<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<img\b([^>]*)>/gi;
const MARKER = '__ASTRO_IMAGE_';

/**
 * Attributes that go into the marker JSON (the ones meaningful to Astro's image options).
 * Other attributes (class, style, data-* and so on) are kept outside the marker as is.
 * Astro replaces only the marker attribute, so attributes kept outside stay in the output
 */
export const MARKER_PROPERTIES: ReadonlySet<string> = new Set([
  'alt',
  'width',
  'height',
  'title',
  'loading',
  'decoding',
]);

export interface MarkImagesResult {
  html: string;
  /** The src values that were marked (no duplicates, in order of appearance) */
  imagePaths: string[];
  /** Absolute paths of images found (no duplicates, in order). Used to convert again on delete */
  found: string[];
  /** Absolute paths of images not found (no duplicates, in order). Used to convert again on add */
  missing: string[];
}

/**
 * Turns the marker JSON into an attribute value. Escapes & first, then ".
 * When Astro (7.3 and later) reads a marker, it decodes `&quot;` and the like first, and `&amp;`
 * last. Without escaping &, a literal `&amp;` in a value would turn into `&`.
 */
export function encodeMarkerValue(json: string): string {
  return json.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

/** Escapes an attribute value (for the attributes kept outside the marker) */
function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * Replaces each `<img>` that meets the conditions with an `__ASTRO_IMAGE_` marker.
 * absPath is the absolute path of the `.adoc` file, displayPath is the path shown in warnings.
 */
export function markImages(
  html: string,
  absPath: string,
  logger: Pick<AstroIntegrationLogger, 'warn'>,
  displayPath: string,
): MarkImagesResult {
  const imagePaths: string[] = [];
  const found: string[] = [];
  const missing: string[] = [];
  const counts = new Map<string, number>();
  const docDir = dirname(absPath);

  const marked = html.replace(SCAN_RX, (whole, attributeText: string | undefined) => {
    if (attributeText === undefined) return whole; // A comment, <script> or <style>
    const attributes = parseAttributes(attributeText.replace(/\/\s*$/, ''));
    if (attributes.some((a) => a.name === MARKER.toLowerCase())) return whole;

    const srcAttribute = attributes.find((a) => a.name === 'src');
    if (!srcAttribute?.quoted || srcAttribute.value === '') return whole;
    const rawSrc = srcAttribute.value;
    if (URL.canParse(rawSrc)) return whole;
    if (rawSrc.startsWith('/')) return whole;
    if (rawSrc.includes('?') || rawSrc.includes('#')) return whole;
    if (!IMAGE_EXTENSIONS.has(extensionOf(rawSrc))) return whole;

    const decoded = safeDecodeUri(rawSrc);
    const src = decoded.startsWith('./') || decoded.startsWith('../') ? decoded : `./${decoded}`;
    const imageFile = resolve(docDir, src);
    if (!existsSync(imageFile)) {
      logger.warn(`${displayPath}: image "${rawSrc}" was not found and is left as is.`);
      if (!missing.includes(imageFile)) missing.push(imageFile);
      return whole;
    }
    if (!found.includes(imageFile)) found.push(imageFile);

    const props: Record<string, unknown> = {};
    let outside = '';
    for (const attribute of attributes) {
      if (attribute.name === 'src') continue;
      if (attribute.name === 'width' || attribute.name === 'height') {
        if (/^\d+$/.test(attribute.value.trim())) {
          props[attribute.name] = Number(attribute.value.trim());
        } else {
          logger.warn(
            `${displayPath}: image "${rawSrc}" has a non-numeric ${attribute.name} ("${attribute.value}"), which is ignored.`,
          );
        }
      } else if (MARKER_PROPERTIES.has(attribute.name)) {
        props[attribute.name] = attribute.value;
      } else {
        outside += ` ${attribute.name}="${escapeAttribute(attribute.value)}"`;
      }
    }
    const index = counts.get(src) ?? 0;
    counts.set(src, index + 1);
    props.src = src;
    props.index = index;
    if (!imagePaths.includes(src)) imagePaths.push(src);

    return `<img${outside} ${MARKER}="${encodeMarkerValue(JSON.stringify(props))}">`;
  });

  return { html: marked, imagePaths, found, missing };
}
