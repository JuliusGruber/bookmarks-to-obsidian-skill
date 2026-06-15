#!/usr/bin/env node
// scripts/smoke-extract.mjs -- repo-root dev tool (never ships).
//
// Proves a skill folder's *vendored* dependency tree is complete enough to run a
// real Defuddle extraction OFFLINE. This exercises defuddle/node -> linkedom +
// turndown (the optional-but-required DOM/markdown stack) that a plain
// `import.mjs --help` resolution check would NOT touch.
//
// Pass the skill folder to test; its deps resolve from THAT folder's co-located
// node_modules (Node walks up from the imported module's location):
//
//   node scripts/smoke-extract.mjs bookmarks-to-obsidian
//   node scripts/smoke-extract.mjs "C:\Temp\b2o-freshcopy"
//
// Exit 0 + "SMOKE OK ..." on success; exit 1 + "SMOKE FAIL ..." otherwise.
// Makes no network calls (extractFromHtml never fetches).

import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const skillDir = resolve(process.argv[2] ?? 'bookmarks-to-obsidian');
const extractUrl = pathToFileURL(join(skillDir, 'scripts', 'src', 'extract.mjs'));
const { extractFromHtml } = await import(extractUrl.href);

const body = Array.from({ length: 60 }, (_, i) =>
  `<p>Paragraph ${i}: enough real words here to comfortably clear the two ` +
  `hundred word floor so Defuddle treats this body as a substantial article.</p>`
).join('');
const html =
  `<!doctype html><html><head><title>Smoke</title></head><body><article>` +
  `<h1>Vendored tree smoke test</h1>${body}</article></body></html>`;

const r = await extractFromHtml(html, 'https://example.com/smoke');
if (r.status !== 'ok' || !r.content) {
  console.error('SMOKE FAIL:', JSON.stringify({ status: r.status, wordCount: r.wordCount }));
  process.exit(1);
}
console.log(`SMOKE OK: status=ok wordCount=${r.wordCount} contentChars=${r.content.length}`);
