# @s8a-uk/astro-loader-asciidoc

An [Astro](https://astro.build/) content loader for [AsciiDoc](https://asciidoc.org/), powered by [Asciidoctor.js](https://github.com/asciidoctor/asciidoctor.js).

It turns `.adoc` files into content collection entries, the same way the built-in `glob()` loader handles Markdown:

- The document header (title and attributes) becomes `data`, validated by your collection schema.
- The body is converted to HTML and rendered with `render(entry)`; `headings` works for tables of contents.
- Syntax highlighting uses Shiki with your `markdown.shikiConfig`, so code looks the same as in Markdown.
- Images next to your documents go through `astro:assets` optimization, like images in Markdown.
- In `astro dev`, changes are applied incrementally, including changes to included files and images.
- Builds reuse the data store cache: unchanged documents are not converted again.

## Requirements

- `astro` `^7.4.0`
- Node.js `>=22.12.0` (Astro itself checks the Node.js version it needs; Astro 7.4.12 requires `>=22.23.4`)
- `shiki` `^4.6.0` for syntax highlighting. It is an optional peer dependency. With npm and pnpm you do not need to install it yourself: the copy Astro depends on is used. If it cannot be resolved, the build stops with a message telling you to install `shiki` or to set `syntaxHighlight: false`.

## Installation

```sh
npm install @s8a-uk/astro-loader-asciidoc
```

## Quick start

`src/content.config.ts`:

```ts
import { defineCollection } from 'astro:content';
import { asciidocLoader } from '@s8a-uk/astro-loader-asciidoc';
import { z } from 'astro/zod';

const notes = defineCollection({
  loader: asciidocLoader({
    base: './src/content/notes',
    mermaid: true,
  }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    tags: z
      .string()
      .default('')
      .transform((s) =>
        s
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    // `:draft:` (no value) is true and `:draft: false` is the string 'false'; accept both
    draft: z.union([z.boolean(), z.stringbool()]).default(false),
    description: z.string().optional(),
  }),
});

export const collections = { notes };
```

`src/content/notes/hello.adoc`:

```asciidoc
= Hello AsciiDoc
:date: 2026-11-17
:tags: astro, asciidoc
:description: A first note

== Hello World

A paragraph with *strong* text.

[source,js]
----
const answer = 42;
----

image::diagram.png[A diagram,width=160]
```

`src/pages/notes/[...slug].astro`:

```astro
---
import { getCollection, render } from 'astro:content';

export async function getStaticPaths() {
  const notes = await getCollection('notes');
  return notes.map((entry) => ({ params: { slug: entry.id }, props: { entry } }));
}

const { entry } = Astro.props;
const { Content, headings } = await render(entry);
---
<h1>{entry.data.title}</h1>
<nav>
  <ul>
    {headings.map((h) => <li><a href={`#${h.slug}`}>{h.text}</a></li>)}
  </ul>
</nav>
<article><Content /></article>
```

The loader outputs the document body only (no `<html>` or header), and the document title is not part of the body. Render `entry.data.title` yourself, as above.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `base` | `string \| URL` | (required) | Directory to search, relative to the project root, or a URL. |
| `pattern` | `string \| string[]` | `['**/*.adoc', '!**/_*', '!**/_*/**']` | Glob patterns relative to `base`. The default skips files and directories whose names start with `_` (see [Includes](#includes-and-safe-mode)). If you set `pattern`, only your patterns are used. `**/node_modules/**` is always excluded. Patterns cannot start with `../` or `/`, or contain `..` segments. |
| `generateId` | `({ entry, base, data }) => string` | `slug` attribute, or the path without extension | See [Ids and slugs](#ids-and-slugs). Must return a non-empty string. |
| `retainBody` | `boolean` | `true` | Keep the AsciiDoc source in `entry.body`. |
| `safe` | `'unsafe' \| 'safe' \| 'server' \| 'secure'` | `'safe'` | Asciidoctor safe mode. See [Security](#security). |
| `attributes` | `Record<string, string \| number \| boolean \| null>` | `{}` | Asciidoctor attributes for every document. `true` sets an attribute, `false` and `null` unset it, numbers become strings. These attributes cannot be overridden by the document unless the name ends with `@` (for example `'icons@': 'font'`). `backend` cannot be set. |
| `syntaxHighlight` | `'shiki' \| false` | `'shiki'` | Highlight source blocks with Shiki. |
| `shikiConfig` | `ShikiOptions` | `{}` | Shiki settings merged over `markdown.shikiConfig`, key by key (`theme`, `themes`, `defaultColor`, `langs`, `langAlias`, `wrap`, `transformers`). Ignored, with a warning, when `syntaxHighlight` is `false`. |
| `mermaid` | `boolean` | `false` | Turn `[mermaid]` blocks into `<pre class="mermaid">`. |
| `images` | `boolean` | `true` | Optimize local images with `astro:assets`. |
| `asciidoctor` | `{ extensions?, converter?, loadOptions? }` | `{}` | Direct access to Asciidoctor.js. See [Extensions](#transformhtml-and-asciidoctor-extensions). |
| `transformHtml` | `(html, context) => string \| Promise<string>` | (none) | Post-process the HTML of each document. |

Unknown options are rejected with an error, so typos are caught early.

The loader also sets these attributes, which documents can override: `idprefix` (empty), `idseparator` (`-`), and `source-highlighter` (`shiki`, when highlighting is enabled).

## Header attributes and `data`

Attributes defined in the document header become `data`:

```asciidoc
= AsciiDoc & Astro
Jane Doe <jane@example.com>
:date: 2026-11-17
:tags: astro, asciidoc
:draft:
```

```js
{
  title: 'AsciiDoc & Astro',
  author: 'Jane Doe',
  firstname: 'Jane',
  lastname: 'Doe',
  authorinitials: 'JD',
  authors: 'Jane Doe',
  email: 'jane@example.com',
  date: '2026-11-17',
  tags: 'astro, asciidoc',
  draft: true,
}
```

- Keys are the attribute names (lowercase).
- Values are strings exactly as written in the source. Character references produced by Asciidoctor are decoded, so `Fish & Chips` stays `Fish & Chips`. A reference you keep on purpose, such as `pass:[&amp;]`, is also decoded to `&` in `data`.
- An attribute without a value (`:draft:`) is `true`. `:draft: false` is the string `'false'`.
- `title` comes from the document title (the `=` line), with formatting removed. It takes precedence over a `:title:` attribute.
- Attributes that every document already has (such as `doctype` or `idprefix`), and attributes Asciidoctor derives from others (such as `doctype-book` or `toc-position`), are not included. This also applies when you override one in the header (`:doctype: book`), so use names that do not clash with built-in attributes for your own data.
- Built-in attributes that are not set by default are included when the header sets them, for example `imagesdir`, `toc`, `icons`, `sectnums`, `lang`, `revnumber`, `revdate`, and `revremark`. With `syntaxHighlight: false`, `source-highlighter` is included too.
- Attributes defined after the header (in the body) are not included.
- Convert types in your schema. Keys your schema does not declare are dropped when Astro validates `data`, so built-in attributes such as `toc` only reach your pages if you declare them.

Schema examples:

```ts
// `:tags: astro, asciidoc` -> ['astro', 'asciidoc']
tags: z.string().default('').transform((s) => s.split(',').map((t) => t.trim()).filter(Boolean)),
// `:draft:` -> true, `:draft: false` -> false, not written -> false
draft: z.union([z.boolean(), z.stringbool()]).default(false),
```

`z.stringbool()` alone does not accept `true`, which is what `:draft:` gives, so combine it with `z.boolean()`.

## Ids and slugs

By default, the entry id is:

1. the `slug` header attribute, if it is set and not empty; otherwise
2. the path relative to `base` without the extension, with a trailing `/index` removed (`guides/setup.adoc` is `guides/setup`, `guides/index.adoc` is `guides`).

Unlike `glob()`, paths are not slugified. Pass `generateId` to change this. It receives `entry` (the path relative to `base`), `base` (a URL), and `data` (before validation).

If two files produce the same id, the file that comes last in path order wins, and a warning is printed for each other file (`Duplicate id "<id>" in collection "<collection>": <a> and <b>.`). With `prerenderConflictBehavior: 'error'` the build stops instead.

## Heading ids

Section ids use `idprefix` (empty) and `idseparator` (`-`), so they look like the ids Astro generates for Markdown:

| Heading | Id |
|---|---|
| `== Hello World` | `hello-world` |
| `== Über uns` | `über-uns` |

Non-ASCII letters are kept as they are, as in Astro's Markdown. CJK headings, such as Japanese, keep their characters, and spaces between words become `-`.

`headings` from `render(entry)` uses the same ids as `slug`. Sections without an id (for example with `:sectids!:`) are left out of `headings`. Set `:idprefix:` or `:idseparator:` in a document to change its ids.

## Cross references (`xref`)

By default, `xref:other.adoc[]` links to `other.html` next to the current page. Astro pages usually have directory-style URLs such as `/notes/<slug>/`, so these links would break. Set `relfileprefix` and `relfilesuffix`:

```ts
asciidocLoader({
  base: './src/content/notes',
  attributes: { relfileprefix: '../', relfilesuffix: '/' },
});
```

`relfileprefix` goes up one level (to `/notes/`) and `relfilesuffix` replaces the extension with `/`. From `/notes/hello/`, `xref:other.adoc[]` now links to `../other/`, which is `/notes/other/`. The URL shape depends on your site, so the loader has no default. Links can still be wrong for documents in subdirectories or documents whose id comes from a `slug` attribute.

## Includes and safe mode

`include::` works as in Asciidoctor:

- Relative paths are resolved from the directory of the file that contains the directive.
- With the default `safe` mode, a document can include files in its own directory and below, but not above it. Use `safe: 'unsafe'` to include files from anywhere.
- `secure` disables includes.

Included files are tracked, including includes inside table cells (`a|`) and source code includes. When an included file changes, every document that includes it is converted again, in `astro dev` and in cached builds. If an include target is missing (also with `opts=optional`), adding it later triggers a reload.

By default, files whose names start with `_` and everything under directories whose names start with `_` are not entries. This follows Astro pages and the usual naming of AsciiDoc partials:

```text
src/content/notes/
├── hello.adoc          entry "hello"
├── _partial.adoc       not an entry; include::_partial.adoc[] works
└── _parts/
    └── aside.adoc      not an entry; include::_parts/aside.adoc[] works
```

If you set `pattern`, this exclusion does not apply. To make `_` files entries too, use `pattern: '**/*.adoc'`.

Remote includes need the `allow-uri-read` attribute in `attributes` (it cannot be set in a document, and does not work with `secure`). Remote content is not tracked, so changes to it do not trigger a reload.

## Images

Local images in the HTML are optimized by `astro:assets`, like images in Markdown. An `<img>` is optimized when its `src`:

- is a relative path (not a URL, not starting with `/`, without `?` or `#`),
- has one of the extensions `jpeg`, `jpg`, `png`, `apng`, `tiff`, `webp`, `gif`, `svg`, `avif`,
- points to an existing file, resolved from the directory of the `.adoc` file (a relative `imagesdir` is applied by Asciidoctor).

`alt`, `width`, `height`, `title`, `loading`, and `decoding` are passed to Astro. Non-numeric `width` or `height` values (such as `50%`) are dropped with a warning. Other attributes (`class`, `id`, ...) are kept.

If an image file does not exist, the loader prints a warning (`<path>: image "<src>" was not found and is left as is.`) and leaves the `<img>` unchanged. The build does not fail, with or without a cache. The warning is printed when the document is converted, so a cached build that skips an unchanged document does not print it again. Adding the image later, or deleting an image a document uses, makes the loader convert that document again.

`<img>` written in passthrough blocks is optimized too if it matches these rules. To keep one as is, use a URL or a path starting with `/`. Images inside HTML comments, `<script>`, and `<style>` are ignored. Inline SVG (`opts=inline`), interactive SVG (`opts=interactive`), and documents with `data-uri` are not optimized.

Set `images: false` to keep Asciidoctor's output as is; then put images in `public/` and point `imagesdir` at them.

## Syntax highlighting (Shiki)

`syntaxHighlight` and `shikiConfig` have the same names and roles as Astro's `markdown.syntaxHighlight` and `markdown.shikiConfig`:

- `syntaxHighlight: 'shiki'` (default) highlights `[source,<lang>]` blocks with Shiki, using `markdown.shikiConfig`.
- `shikiConfig` overrides `markdown.shikiConfig` key by key, for AsciiDoc only:

  ```ts
  asciidocLoader({ base: './src/content/notes', shikiConfig: { theme: 'nord' } });
  ```

- `syntaxHighlight: false` leaves source blocks unhighlighted. `shikiConfig` is then ignored, with a warning.

The output matches Astro's Markdown (`<pre class="astro-code ...">`, `data-language`, `wrap`, multiple themes, `css-variables`). Callouts (`<1>`) and `highlight=` line ranges work. Unknown languages fall back to plain text with one warning per language. Line numbers (`linenums`) are not supported. `markdown.syntaxHighlight` is not read; only the loader options decide.

## Mermaid

With `mermaid: true`, listing or literal blocks with the `mermaid` style become `<pre class="mermaid">` with the diagram source:

```asciidoc
[mermaid]
----
graph TD
  A --> B
----
```

The block id and role are kept; the block title is not output. Loading and running mermaid.js on the page is up to your site; the loader does not include it.

## `transformHtml` and Asciidoctor extensions

`transformHtml(html, context)` runs after conversion and before image optimization. `context` has `id`, `collection`, `filePath` (absolute), `data` (before validation), and `logger`. It must return a string.

```ts
asciidocLoader({
  base: './src/content/notes',
  transformHtml: (html) => html.replaceAll('<table class="tableblock', '<table class="tableblock table'),
});
```

- The HTML it receives still has plain `<img src="...">`; images it adds are optimized too.
- Changing heading ids here does not update `headings`.

`asciidoctor` gives direct access to Asciidoctor.js:

- `extensions(registry, asciidoctor)` registers extensions. It is called with a new registry for every document; the second argument is the `@asciidoctor/core` module the loader uses.
- `converter` replaces the HTML5 converter (passed as the `converter` option).
- `loadOptions` passes other options to `load()`. Keys the loader controls or that change the output format (`safe`, `attributes`, `backend`, `extension_registry`, `logger`, `converter`, `standalone`, `parse`, `to_file`, ...) are rejected.

```ts
asciidocLoader({
  base: './src/content/notes',
  asciidoctor: {
    extensions(registry) {
      registry.inlineMacro('kbd2', function () {
        this.process((parent, target) => this.createInline(parent, 'quoted', `<kbd>${target}</kbd>`));
      });
    },
  },
});
```

## Caching and when you need `--force`

A document is converted again when its source, its path, the loader options, the versions of this package or Asciidoctor.js, or anything it depends on (included files, images) changes. Otherwise the cached entry is reused.

Functions in the options (`transformHtml`, extensions, converters, Shiki transformers, `generateId`) cannot be compared. If you define them in another module imported by `content.config.ts` and change only that module:

- `astro build` with an existing cache keeps the old HTML. Run `astro build --force`.
- `astro dev` does not pick up the change. Restart the dev server, or save `content.config.ts` again.

This is a limitation of Astro content collections, and Markdown plugins behave the same way.

## Errors in `astro dev`

- If a document fails to convert, the error is logged and the previous content is kept until you fix it.
- If `data` does not match the schema when `astro dev` starts, the dev server does not start (the same as `glob()`). If it becomes invalid later, the error is logged, the previous content is kept, and fixing it recovers.
- One failing document does not stop other documents from being updated.

## Security

- `.adoc` files are assumed to be trusted input written by the site author. Do not use this loader for content submitted by others.
- Safe mode only limits what can be included. It is not a sandbox.
- Passthrough content (`++++` blocks, `pass:[]`) is output as is. HTML is not sanitized.
- Include paths and the safe mode check use the path of a symbolic link, not its target. Through a link, a document can include a file outside its directory. A linked document resolves relative includes from the directory of the link.
- `allow-uri-read` enables remote includes; it can only be set through `attributes`.

## Limitations

- Line numbers in source blocks (`linenums`) are not supported.
- AsciiDoc pages in `src/pages` are not supported; this is a content loader only.
- No live loader, no Astro components inside AsciiDoc, and no bundled stylesheet: style the Asciidoctor HTML classes yourself.
- Warnings (missing images, duplicate ids, and so on) do not fail the build, except duplicate ids with `prerenderConflictBehavior: 'error'`.

## Development

All development commands run in containers (Docker Compose). Nothing is installed on the host.

| Command | Description |
|---|---|
| `make install` | Install dependencies (`npm ci`) into a named volume |
| `make check` | Type check, lint, unit and integration tests, and E2E on Node.js 26 and the lower bounds |
| `make matrix` | Tests and E2E on Node.js 22, 24, and 26 |
| `make test` / `make e2e` | Unit and integration tests / E2E (pass `NODE_VERSION=24` to change the version) |
| `make e2e-min` / `make e2e-latest` | Tests with the lowest supported / latest `astro` and `@asciidoctor/core` |
| `make e2e-pack` / `make e2e-pack-pnpm` | Install the packed tarball into an empty Astro project with npm / pnpm and build it |
| `make dev` / `make dev-stop` | Run the test site with `astro dev` |
| `make down` | Stop and remove the project's containers |

### Releasing

1. Bump `version` in `package.json` (and `package-lock.json`), for example with `npm version --no-git-tag-version <version>`.
2. Set the release date of that version in `CHANGELOG.md`.
3. Merge into `main`.
4. Push the tag `v<version>` for the merge commit on `main`. The `Release` workflow checks the tag, runs the tests, and publishes the tested tarball to npm with provenance.

## License

[MIT](./LICENSE)
