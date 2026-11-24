# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is 0.x, minor versions may contain breaking changes.

## [0.1.0] - Unreleased

### Added

- `asciidocLoader()`, an Astro 7 content loader for AsciiDoc files, powered by Asciidoctor.js 4.
- Document header attributes as entry `data` (values without a value become `true`, character references are decoded, the document title becomes `title`, attributes every document already has and attributes Asciidoctor derives are left out).
- Rendered HTML and `headings` for `render(entry)`, with Markdown-like heading ids (`idprefix` empty, `idseparator` `-`).
- Default ids from the `slug` attribute or the file path; custom ids with `generateId`. Duplicate ids are resolved deterministically (the last file in path order wins).
- Files and directories starting with `_` are excluded by default, and can still be included.
- Syntax highlighting with Shiki using `markdown.shikiConfig`, with `syntaxHighlight` and `shikiConfig` options; callouts and highlighted lines are supported.
- Local image optimization through `astro:assets`; missing images are left as is with a warning.
- Optional Mermaid blocks (`mermaid: true`) rendered as `<pre class="mermaid">`.
- `transformHtml` hook and direct access to Asciidoctor.js extensions, converters, and load options.
- Incremental updates in `astro dev` and cached builds, tracking included files (also inside table cells) and images.
- Asciidoctor warnings and errors forwarded to the Astro logger with file and line.

[0.1.0]: https://github.com/s8a-uk/astro-loader-asciidoc/releases/tag/v0.1.0
