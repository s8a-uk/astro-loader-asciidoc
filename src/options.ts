// Validates the options and applies defaults
import type {
  AsciidocLoaderOptions,
  AsciidoctorHooks,
  GenerateIdOptions,
  ShikiOptions,
  TransformHtmlContext,
} from './types.js';
import { describeType } from './util.js';

export type SafeMode = 'unsafe' | 'safe' | 'server' | 'secure';

/** The shape of the attributes option of Asciidoctor.js */
export type AsciidoctorAttributes = Record<string, string | null | false>;

export interface ResolvedOptions {
  patterns: string[];
  base: string | URL;
  generateId: (options: GenerateIdOptions) => string;
  retainBody: boolean;
  safe: SafeMode;
  /** Attributes after merging (see mergeAttributes()), in the shape Asciidoctor.js takes */
  attributes: AsciidoctorAttributes;
  /** Whether to highlight with Shiki */
  syntaxHighlight: boolean;
  /** Settings merged over markdown.shikiConfig */
  shikiConfig: ShikiOptions;
  /** shikiConfig was given although syntaxHighlight is false (load() warns) */
  unusedShikiConfig: boolean;
  mermaid: boolean;
  images: boolean;
  hooks: {
    extensions?: AsciidoctorHooks['extensions'];
    converter?: unknown;
    loadOptions: Record<string, unknown>;
  };
  transformHtml?: (html: string, context: TransformHtmlContext) => string | Promise<string>;
}

/** Names of the accepted options (a test checks that they match the table in README) */
export const KNOWN_OPTIONS: ReadonlySet<string> = new Set([
  'pattern',
  'base',
  'generateId',
  'retainBody',
  'safe',
  'attributes',
  'syntaxHighlight',
  'shikiConfig',
  'mermaid',
  'images',
  'asciidoctor',
  'transformHtml',
]);

const KNOWN_HOOKS = new Set(['extensions', 'converter', 'loadOptions']);

/**
 * Attributes that cannot be set in attributes. They change the output from HTML5 and break what
 * the loader relies on (HTML post-processing, image markers, headings). Names are compared
 * without a trailing @ and a leading or trailing !
 */
export const RESERVED_ATTRIBUTES: ReadonlySet<string> = new Set(['backend']);

/** Keys of Astro's markdown.shikiConfig (the ones accepted in shikiConfig) */
const KNOWN_SHIKI_OPTIONS = new Set([
  'theme',
  'themes',
  'defaultColor',
  'langs',
  'langAlias',
  'wrap',
  'transformers',
]);

/**
 * Keys that cannot be set in asciidoctor.loadOptions: the ones the loader sets, and the ones that
 * break what the loader relies on (output format, how much is parsed, writing to files). They
 * are rejected with an error instead of being silently overridden
 */
export const RESERVED_LOAD_OPTIONS: ReadonlySet<string> = new Set([
  'safe',
  'attributes',
  'extension_registry',
  'extensions',
  'logger',
  'converter',
  'converter_factory',
  'syntax_highlighters',
  'syntax_highlighter_factory',
  'standalone',
  'header_footer',
  'backend',
  'parse',
  'parse_header_only',
  'to_file',
  'to_dir',
  'mkdirs',
]);

const SAFE_MODES: readonly SafeMode[] = ['unsafe', 'safe', 'server', 'secure'];

export class OptionsError extends Error {
  constructor(message: string) {
    super(`[asciidoc-loader] ${message}`);
    this.name = 'OptionsError';
  }
}

function invalid(name: string, expected: string, actual: unknown): never {
  throw new OptionsError(
    `Invalid option "${name}": expected ${expected}, got ${describeType(actual)}.`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The default generateId */
export function defaultGenerateId({ entry, data }: GenerateIdOptions): string {
  if (typeof data.slug === 'string' && data.slug !== '') return data.slug;
  const withoutExtension = entry.replace(/\.[^/.]+$/, '');
  if (withoutExtension === 'index') return 'index';
  return withoutExtension.replace(/\/index$/, '');
}

interface AttributeEntry {
  /** A soft setting, which documents can override */
  soft: boolean;
  /** null unsets the attribute */
  value: string | null;
}

/**
 * Splits an attribute name into the name without a trailing @ and a leading or trailing !, and
 * what those marks mean
 */
function parseAttributeName(name: string): { key: string; soft: boolean; unset: boolean } {
  let key = name;
  let soft = false;
  let unset = false;
  if (key.endsWith('@')) {
    soft = true;
    key = key.slice(0, -1);
  }
  if (key.startsWith('!')) {
    unset = true;
    key = key.slice(1);
  } else if (key.endsWith('!')) {
    unset = true;
    key = key.slice(0, -1);
  }
  return { key: key.toLowerCase(), soft, unset };
}

/**
 * Merges the attributes and returns them in the shape Asciidoctor.js takes. Later ones replace
 * earlier ones with the same name: first the loader's defaults, all soft so that documents can
 * override them (idprefix: empty, idseparator: -, source-highlighter: shiki when highlighting),
 * then the user's attributes.
 * - A soft value is written with a trailing @ on the name, a soft unset with a trailing !@
 * - A hard unset is written as the value null
 */
export function mergeAttributes(
  user: Record<string, string | boolean | null>,
  syntaxHighlight: boolean,
): AsciidoctorAttributes {
  const merged = new Map<string, AttributeEntry>();
  merged.set('idprefix', { soft: true, value: '' });
  merged.set('idseparator', { soft: true, value: '-' });
  if (syntaxHighlight) merged.set('source-highlighter', { soft: true, value: 'shiki' });

  for (const [name, raw] of Object.entries(user)) {
    const { key, soft, unset } = parseAttributeName(name);
    const value = unset || raw === false || raw === null ? null : raw === true ? '' : raw;
    merged.delete(key); // Move the key to the position of the later setting
    merged.set(key, { soft, value });
  }

  const result: AsciidoctorAttributes = {};
  for (const [key, { soft, value }] of merged) {
    if (soft) {
      if (value === null) result[`${key}!@`] = '';
      else result[`${key}@`] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Default of pattern. Skips files whose names start with `_` and everything under directories
 * whose names start with `_` (following Astro pages and the usual naming of AsciiDoc partials).
 * Not used when the user sets pattern
 */
export const DEFAULT_PATTERNS: readonly string[] = ['**/*.adoc', '!**/_*', '!**/_*/**'];

/** Uses the default only for undefined (null goes on to validation as an invalid value) */
function orDefault<T, D>(value: T | undefined, fallback: D): T | D {
  return value === undefined ? fallback : value;
}

export function resolveOptions(options: AsciidocLoaderOptions): ResolvedOptions {
  if (!isPlainObject(options as unknown)) invalid('options', 'an object', options);

  for (const name of Object.keys(options)) {
    if (!KNOWN_OPTIONS.has(name)) throw new OptionsError(`Unknown option "${name}".`);
  }

  // pattern
  const rawPattern = orDefault(options.pattern, [...DEFAULT_PATTERNS]);
  const patterns = Array.isArray(rawPattern) ? rawPattern : [rawPattern];
  if (patterns.length === 0)
    invalid('pattern', 'a non-empty string or array of strings', rawPattern);
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern === '') {
      invalid('pattern', 'a non-empty string or array of strings', pattern);
    }
    const positive = pattern.startsWith('!') ? pattern.slice(1) : pattern;
    if (positive.startsWith('../') || positive.startsWith('/')) {
      throw new OptionsError(
        'Glob patterns cannot start with "../" or "/". Set the "base" option instead.',
      );
    }
    // Reject .. in any segment, so patterns cannot point outside base (also ./../x, a/../../x)
    if (positive.split(/[/\\]/).includes('..')) {
      throw new OptionsError(
        'Glob patterns cannot contain ".." segments. Set the "base" option instead.',
      );
    }
  }

  // base (required)
  const base = options.base;
  if (base === undefined) {
    throw new OptionsError(
      'The "base" option is required (for example: asciidocLoader({ base: \'./src/content/notes\' })).',
    );
  }
  if (typeof base !== 'string' && !(base instanceof URL)) invalid('base', 'a string or URL', base);
  if (typeof base === 'string' && base.trim() === '') {
    invalid('base', 'a non-empty string or URL', base);
  }

  // generateId
  const generateId = orDefault(options.generateId, defaultGenerateId);
  if (typeof generateId !== 'function') invalid('generateId', 'a function', generateId);

  // retainBody
  const retainBody = orDefault(options.retainBody, true);
  if (typeof retainBody !== 'boolean') invalid('retainBody', 'a boolean', retainBody);

  // safe
  const safe = orDefault(options.safe, 'safe');
  if (!SAFE_MODES.includes(safe as SafeMode))
    invalid('safe', `one of ${SAFE_MODES.join(', ')}`, safe);

  // syntaxHighlight
  const rawHighlight = orDefault(options.syntaxHighlight, 'shiki');
  if (isPlainObject(rawHighlight as unknown)) {
    throw new OptionsError(
      'Invalid option "syntaxHighlight": expected "shiki" or false, got object. Pass Shiki options in "shikiConfig".',
    );
  }
  if (rawHighlight !== 'shiki' && rawHighlight !== false) {
    invalid('syntaxHighlight', '"shiki" or false', rawHighlight);
  }
  const syntaxHighlight = rawHighlight === 'shiki';

  // shikiConfig
  const rawShikiConfig = options.shikiConfig;
  if (rawShikiConfig !== undefined && !isPlainObject(rawShikiConfig as unknown)) {
    invalid('shikiConfig', 'an object', rawShikiConfig);
  }
  const shikiConfig: ShikiOptions = { ...rawShikiConfig };
  for (const name of Object.keys(shikiConfig)) {
    if (!KNOWN_SHIKI_OPTIONS.has(name)) {
      throw new OptionsError(`Unknown option "shikiConfig.${name}".`);
    }
  }

  // attributes
  const rawAttributes: Record<string, string | number | boolean | null> = orDefault(
    options.attributes,
    {},
  );
  if (!isPlainObject(rawAttributes as unknown)) invalid('attributes', 'an object', rawAttributes);
  const userAttributes: Record<string, string | boolean | null> = {};
  for (const [name, value] of Object.entries(rawAttributes)) {
    const { key } = parseAttributeName(name);
    if (RESERVED_ATTRIBUTES.has(key)) {
      throw new OptionsError(
        `The "${key}" attribute cannot be set in "attributes"; the loader always converts to HTML5.`,
      );
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Pass numbers as strings (as with :leveloffset: 1)
      userAttributes[name] = String(value);
    } else if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
      userAttributes[name] = value;
    } else {
      invalid(`attributes.${name}`, 'a string, number, boolean, or null', value);
    }
  }

  // mermaid, images
  const mermaid = orDefault(options.mermaid, false);
  if (typeof mermaid !== 'boolean') invalid('mermaid', 'a boolean', mermaid);
  const images = orDefault(options.images, true);
  if (typeof images !== 'boolean') invalid('images', 'a boolean', images);

  // asciidoctor
  const hooks: AsciidoctorHooks = orDefault(options.asciidoctor, {});
  if (!isPlainObject(hooks as unknown)) invalid('asciidoctor', 'an object', hooks);
  for (const name of Object.keys(hooks)) {
    if (!KNOWN_HOOKS.has(name)) throw new OptionsError(`Unknown option "asciidoctor.${name}".`);
  }
  if (hooks.extensions !== undefined && typeof hooks.extensions !== 'function') {
    invalid('asciidoctor.extensions', 'a function', hooks.extensions);
  }
  const loadOptions: Record<string, unknown> = orDefault(hooks.loadOptions, {});
  if (!isPlainObject(loadOptions as unknown))
    invalid('asciidoctor.loadOptions', 'an object', loadOptions);
  for (const name of Object.keys(loadOptions)) {
    if (RESERVED_LOAD_OPTIONS.has(name)) {
      throw new OptionsError(
        `The "${name}" key cannot be set in "asciidoctor.loadOptions"; it is controlled by the loader.`,
      );
    }
  }

  // transformHtml
  const transformHtml = options.transformHtml;
  if (transformHtml !== undefined && typeof transformHtml !== 'function') {
    invalid('transformHtml', 'a function', transformHtml);
  }

  return {
    patterns,
    base,
    generateId,
    retainBody,
    safe,
    attributes: mergeAttributes(userAttributes, syntaxHighlight),
    syntaxHighlight,
    shikiConfig,
    unusedShikiConfig: !syntaxHighlight && rawShikiConfig !== undefined,
    mermaid,
    images,
    hooks: {
      ...(hooks.extensions ? { extensions: hooks.extensions } : {}),
      ...(hooks.converter !== undefined ? { converter: hooks.converter } : {}),
      loadOptions: { ...loadOptions },
    },
    ...(transformHtml ? { transformHtml } : {}),
  };
}
