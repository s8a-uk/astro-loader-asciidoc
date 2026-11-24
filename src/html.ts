// Small helpers for HTML strings

/**
 * Named character references to decode: the ones Asciidoctor outputs (amp, lt, gt, quot, apos,
 * nbsp) and ones that authors often write by hand. References with other names are left as is.
 * A Map, so that prototype properties are not looked up (`&constructor;` is not decoded)
 */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', '\u00a0'],
  ['copy', '\u00a9'],
  ['reg', '\u00ae'],
  ['trade', '\u2122'],
  ['hellip', '\u2026'],
  ['mdash', '\u2014'],
  ['ndash', '\u2013'],
  ['lsquo', '\u2018'],
  ['rsquo', '\u2019'],
  ['ldquo', '\u201c'],
  ['rdquo', '\u201d'],
  ['laquo', '\u00ab'],
  ['raquo', '\u00bb'],
  ['times', '\u00d7'],
  ['divide', '\u00f7'],
  ['deg', '\u00b0'],
  ['plusmn', '\u00b1'],
  ['middot', '\u00b7'],
  ['bull', '\u2022'],
  ['sect', '\u00a7'],
  ['para', '\u00b6'],
  ['euro', '\u20ac'],
  ['pound', '\u00a3'],
  ['yen', '\u00a5'],
  ['cent', '\u00a2'],
  ['larr', '\u2190'],
  ['rarr', '\u2192'],
  ['uarr', '\u2191'],
  ['darr', '\u2193'],
  ['harr', '\u2194'],
  ['lArr', '\u21d0'],
  ['rArr', '\u21d2'],
  ['hArr', '\u21d4'],
  ['le', '\u2264'],
  ['ge', '\u2265'],
  ['ne', '\u2260'],
  ['infin', '\u221e'],
  ['shy', '\u00ad'],
]);

const ENTITY_RX = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g;

/** Escapes &, <, > and " as character references */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Decodes character references: numeric ones, and named ones listed in NAMED_ENTITIES.
 * Unknown names are left as is. Replaces in a single pass, so `&amp;lt;` becomes `&lt;`.
 */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY_RX, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole;
      return String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES.get(body) ?? whole;
  });
}

/** Removes tags, decodes character references, and trims surrounding whitespace */
export function toPlainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).trim();
}

export interface HtmlAttribute {
  name: string;
  /** The value with character references decoded. An empty string for attributes without a value */
  value: string;
  /** Whether the value was quoted */
  quoted: boolean;
}

const ATTRIBUTE_RX = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Reads the attribute part of a start tag (between `<img` and `>`) */
export function parseAttributes(text: string): HtmlAttribute[] {
  const attributes: HtmlAttribute[] = [];
  for (const match of text.matchAll(ATTRIBUTE_RX)) {
    const [, name, doubleQuoted, singleQuoted, unquoted] = match;
    if (!name) continue;
    const raw = doubleQuoted ?? singleQuoted ?? unquoted;
    attributes.push({
      name: name.toLowerCase(),
      value: raw === undefined ? '' : decodeEntities(raw),
      quoted: doubleQuoted !== undefined || singleQuoted !== undefined,
    });
  }
  return attributes;
}
