// Shiki adapter for Asciidoctor.js. The output matches Astro's Markdown
import type { SyntaxHighlighterBase } from '@asciidoctor/core';
import type { AstroIntegrationLogger } from 'astro';
import type { Highlighter, ShikiTransformer } from 'shiki';
import { escapeHtml } from './html.js';
import type { ShikiOptions } from './types.js';

type ShikiModule = typeof import('shiki');

export const SHIKI_LOAD_ERROR_MESSAGE =
  '[asciidoc-loader] Syntax highlighting is enabled, but the "shiki" package could not be loaded.\n' +
  'Install it (for example: npm install shiki), or disable highlighting with `syntaxHighlight: false`.';

/** Lets tests replace how shiki is imported */
export const shikiImporter = {
  load: (): Promise<ShikiModule> => import('shiki'),
};

export async function importShiki(): Promise<ShikiModule> {
  try {
    return await shikiImporter.load();
  } catch (cause) {
    throw new Error(SHIKI_LOAD_ERROR_MESSAGE, { cause });
  }
}

/** The highlighter and its settings, one per loader */
export interface ShikiState {
  shiki: ShikiModule;
  highlighter: Highlighter;
  options: ShikiOptions;
  themeOptions: { theme: unknown } | { themes: Record<string, unknown> };
  /** Languages already warned about (to warn once per language) */
  warnedLanguages: Set<string>;
}

export async function createShikiState(
  shiki: ShikiModule,
  options: ShikiOptions,
): Promise<ShikiState> {
  const themes = (options.themes ?? {}) as Record<string, unknown>;
  const hasThemes = Object.values(themes).length > 0;
  const theme =
    options.theme === 'css-variables'
      ? shiki.createCssVariablesTheme({ variablePrefix: '--astro-code-' })
      : (options.theme ?? 'github-dark');
  const highlighter = await shiki.createHighlighter({
    langs: ['plaintext', ...((options.langs ?? []) as never[])],
    langAlias: { ...(options.langAlias ?? {}) },
    themes: (hasThemes ? Object.values(themes) : [theme]) as never[],
  });
  return {
    shiki,
    highlighter,
    options,
    themeOptions: hasThemes ? { themes } : { theme },
    warnedLanguages: new Set(),
  };
}

async function resolveLanguage(
  state: ShikiState,
  lang: string | null | undefined,
  logger: AstroIntegrationLogger,
): Promise<string> {
  if (!lang) return 'plaintext';
  const { highlighter, shiki } = state;
  if (shiki.isSpecialLang(lang)) return lang;
  const resolved = (state.options.langAlias as Record<string, string> | undefined)?.[lang] ?? lang;
  if (highlighter.getLoadedLanguages().includes(resolved)) return lang;
  try {
    await highlighter.loadLanguage(resolved as never);
    return lang;
  } catch {
    const message = `Unknown language "${lang}"; falling back to plaintext.`;
    const warnOnce = (logger as { warnOnce?: (key: string, message: string) => void }).warnOnce;
    if (typeof warnOnce === 'function') {
      // In the loader, limit it to once when the buffered logs are flushed, so which file warns
      // does not depend on the order in which concurrent conversions finish
      warnOnce.call(logger, `shiki-language:${lang}`, message);
    } else if (!state.warnedLanguages.has(lang)) {
      state.warnedLanguages.add(lang);
      logger.warn(message);
    }
    return 'plaintext';
  }
}

function classList(value: unknown): string {
  return Array.isArray(value) ? value.join(' ') : typeof value === 'string' ? value : '';
}

/** A transformer that makes the output look like Astro's Markdown */
export function astroCompat(language: string, wrap: boolean | null | undefined): ShikiTransformer {
  return {
    name: 'asciidoc-loader:astro-compat',
    pre(node) {
      node.properties.class = classList(node.properties.class).replace(/shiki/g, 'astro-code');
      node.properties.dataLanguage = language;
      const style = classList(node.properties.style);
      if (wrap === false || wrap === undefined) {
        node.properties.style = `${style}; overflow-x: auto;`;
      } else if (wrap === true) {
        node.properties.style = `${style}; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word;`;
      }
    },
  };
}

/** Adds the highlighted class to <span class="line"> of the given lines */
export function highlightLines(lines: readonly number[] | null | undefined): ShikiTransformer {
  const set = new Set(lines ?? []);
  return {
    name: 'asciidoc-loader:highlight-lines',
    line(node, line) {
      if (set.has(line)) this.addClassToHast(node, 'highlighted');
    },
  };
}

const SHIKI_OUTPUT_RX = /^<pre([^>]*)><code[^>]*>([\s\S]*)<\/code><\/pre>$/;

interface BlockLike {
  content(): Promise<string> | string;
}

/**
 * Creates the syntax highlighter class for Asciidoctor.js. One is created per document (to put
 * the file path in warnings).
 * Called in the order format() -> node.content() -> highlight(); Asciidoctor.js restores the
 * callouts. highlight() receives the source before escaping.
 */
export function createShikiAdapter(
  Base: typeof SyntaxHighlighterBase,
  state: ShikiState,
  logger: AstroIntegrationLogger,
  displayPath: string,
): typeof SyntaxHighlighterBase {
  const preAttributes = new WeakMap<object, string>();

  class ShikiAdapter extends Base {
    override handlesHighlighting(): boolean {
      return true;
    }

    // The type definitions say opts.highlight_lines, but at runtime it is passed in camel case as
    // highlightLines
    override async highlight(
      node: object,
      source: string,
      lang: string,
      opts: object,
    ): Promise<string> {
      const lines = (opts as { highlightLines?: number[] | null }).highlightLines;
      const language = await resolveLanguage(state, lang, logger);
      const html = state.highlighter.codeToHtml(source.replace(/(?:\r\n|\r|\n)$/, ''), {
        lang: language,
        ...(state.themeOptions as { theme: string }),
        ...(state.options.defaultColor !== undefined
          ? { defaultColor: state.options.defaultColor }
          : {}),
        transformers: [
          astroCompat(language, state.options.wrap),
          highlightLines(lines),
          ...((state.options.transformers ?? []) as ShikiTransformer[]),
        ],
      });
      const match = SHIKI_OUTPUT_RX.exec(html);
      if (!match) {
        logger.warn(
          `${displayPath}: unexpected Shiki output; the code block is left unhighlighted.`,
        );
        return escapeHtml(source);
      }
      preAttributes.set(node, match[1] ?? '');
      return match[2] ?? '';
    }

    override async format(node: object): Promise<string> {
      const content = await (node as BlockLike).content();
      const attributes = preAttributes.get(node);
      if (attributes === undefined) {
        // If highlight() did not get the expected shape, use a shape close to Asciidoctor's default
        return `<pre class="highlight"><code>${content}</code></pre>`;
      }
      return `<pre${attributes}><code>${content}</code></pre>`;
    }
  }

  return ShikiAdapter as unknown as typeof SyntaxHighlighterBase;
}
