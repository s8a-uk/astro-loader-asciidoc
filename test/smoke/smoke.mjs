// Smoke test run on each supported Node version.
// Converts the same document with @asciidoctor/core and writes the result to stdout.
// The Makefile's smoke target checks that the output is identical on Node 22, 24 and 26, and that
// stderr is empty.
import { fileURLToPath } from 'node:url';
import { getVersion, loadFile } from '@asciidoctor/core';

const docPath = fileURLToPath(new URL('./doc/main.adoc', import.meta.url));
const version = getVersion();

const doc = await loadFile(docPath, { safe: 'safe', standalone: false });
const html = await doc.convert();
// biome-ignore lint/suspicious/noTemplateCurlyInString: matches the included JS source verbatim
if (!html.includes('from an included file') || !html.includes('Hello, ${name}')) {
  throw new Error('smoke: included content is missing from the output');
}

// Exclude environment-dependent attributes (time, paths, Node version) from the comparison
const volatile = /^(local|doc)(date|time|datetime|year)$|^docdir$|^docfile$|^outdir$|^user-home$/;
const attributes = Object.fromEntries(
  Object.entries(doc.getAttributes())
    .filter(([key]) => !volatile.test(key))
    .sort(([a], [b]) => a.localeCompare(b)),
);

console.log(`@asciidoctor/core ${version}`);
console.log(`html length ${html.length}`);
console.log(JSON.stringify({ attributes }, null, 2));
console.log(html);
