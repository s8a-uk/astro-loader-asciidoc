import type * as AsciidoctorModule from '@asciidoctor/core';
import type { Registry } from '@asciidoctor/core';
import type { AstroConfig, AstroIntegrationLogger } from 'astro';

export interface AsciidocLoaderOptions {
  /**
   * Glob patterns, relative to `base`. Default: `['**\/*.adoc', '!**\/_*', '!**\/_*\/**']`,
   * which skips files whose names start with `_` and everything under directories whose names
   * start with `_` (partials meant to be included). If you set `pattern`, only your patterns are
   * used and this exclusion does not apply. `**\/node_modules/**` is always excluded.
   * Patterns cannot start with `../` or `/`, or contain `..` segments.
   */
  pattern?: string | string[];

  /** Directory to search, relative to the project root, or a URL. Required. */
  base: string | URL;

  /**
   * Creates the entry id. Must return a non-empty string.
   * Default: the `slug` header attribute if it is set and not empty; otherwise the path relative
   * to `base` without the extension, with a trailing `/index` removed. Paths are not slugified.
   */
  generateId?: (options: GenerateIdOptions) => string;

  /** Keep the AsciiDoc source in `entry.body`. Default: `true` */
  retainBody?: boolean;

  /**
   * Asciidoctor safe mode. Default: `'safe'`.
   * Safe mode only limits what can be included; it is not a sandbox, and HTML is not sanitized.
   */
  safe?: 'unsafe' | 'safe' | 'server' | 'secure';

  /**
   * Asciidoctor attributes passed to every document. Default: `{}`.
   * `true` sets an attribute (as an empty string), `false` and `null` unset it, and numbers become
   * strings. As is standard in the Asciidoctor API, documents cannot override these attributes
   * unless the name ends with `@` (for example `'icons@': 'font'`). `backend` cannot be set.
   */
  attributes?: Record<string, string | number | boolean | null>;

  /**
   * Syntax highlighting for source blocks. Default: `'shiki'` (named after Astro's
   * `markdown.syntaxHighlight`, which this loader does not read).
   * - `'shiki'`: highlight with Shiki, using `markdown.shikiConfig` with `shikiConfig` merged
   *   over it.
   * - `false`: no highlighting. If `shikiConfig` is set, it is ignored and a warning is printed
   *   once.
   */
  syntaxHighlight?: 'shiki' | false;

  /**
   * Shiki settings, in the same shape as Astro's `markdown.shikiConfig`. They override
   * `markdown.shikiConfig` key by key, for AsciiDoc only. Default: `{}`
   */
  shikiConfig?: ShikiOptions;

  /**
   * Turn listing and literal blocks with the `mermaid` style into `<pre class="mermaid">`.
   * Loading mermaid.js on the page is up to your site. Default: `false`
   */
  mermaid?: boolean;

  /**
   * Optimize local images in the HTML with `astro:assets`, like images in Markdown.
   * Default: `true`
   */
  images?: boolean;

  /** Direct access to Asciidoctor.js. Default: `{}` */
  asciidoctor?: AsciidoctorHooks;

  /**
   * Post-processes the HTML of each document. Runs after conversion and before image
   * optimization, so images it adds are optimized too. Changing heading ids here does not update
   * `headings`. Must return a string.
   */
  transformHtml?: (html: string, context: TransformHtmlContext) => string | Promise<string>;
}

export interface GenerateIdOptions {
  /** Path of the file relative to `base`, with `/` as the separator */
  entry: string;
  /** URL of the `base` directory */
  base: URL;
  /** The raw `data` from the header attributes, before schema validation */
  data: Record<string, unknown>;
}

/** The same shape as Astro's `markdown.shikiConfig` */
export type ShikiOptions = Partial<AstroConfig['markdown']['shikiConfig']>;

export interface AsciidoctorHooks {
  /**
   * Registers extensions. Called with a new registry for every document.
   * The second argument is the `@asciidoctor/core` module this loader uses.
   */
  extensions?: (registry: Registry, asciidoctor: typeof AsciidoctorModule) => void | Promise<void>;

  /**
   * Replaces the converter of the html5 backend. Passed as the `converter` option of
   * Asciidoctor.js.
   */
  converter?: unknown;

  /**
   * Other options passed to `load()` of Asciidoctor.js.
   * Keys the loader sets, and keys that change the output format or how much is parsed
   * (`safe`, `attributes`, `extension_registry`, `logger`, `converter`, `syntax_highlighters`,
   * `standalone`, `backend`, `parse`, `parse_header_only`, `to_file`, ...), are rejected with
   * an error.
   */
  loadOptions?: Record<string, unknown>;
}

export interface TransformHtmlContext {
  /** The entry id */
  id: string;
  /** The collection name */
  collection: string;
  /** Absolute path of the `.adoc` file */
  filePath: string;
  /** The raw `data` from the header attributes, before schema validation */
  data: Record<string, unknown>;
  /** The loader's logger */
  logger: AstroIntegrationLogger;
}
