import { describe, it, expect } from 'vitest';
import { Defuddle } from 'defuddle/node';
import { extractFromHtml } from '../scripts/src/extract.mjs';

const URL = 'https://example.com/post';
const DOC = `<!doctype html><html><head><title>Eq Title</title></head><body>
  <article>
    <h1>Eq Title</h1>
    ${'<p>This is a sufficiently long paragraph of article prose so Defuddle keeps it. </p>'.repeat(12)}
    <ul><li>one</li><li>two</li></ul>
    <pre><code>const x = 1;</code></pre>
  </article></body></html>`;

// NOTE: the rendered path no longer re-parses cleaned HTML in node — it converts to
// markdown in-page (render.mjs, parse({markdown:true})), because a node re-parse of a
// context-free fragment drops div-wrapped inline images (x.com: 12 -> 1). This test
// stays as a sanity check that node extractFromHtml is internally stable on a normal
// <article> document (the fetch path's converter): re-parsing its own cleaned output
// is byte-identical. It happens to hold here only because this fixture has an <article>
// root and no div-wrapped images — exactly the case the double-parse handled fine.
describe('node extractFromHtml conversion is stable on a normal article', () => {
  it('re-parse of cleaned HTML equals direct conversion (text byte-stable)', async () => {
    const direct = await extractFromHtml(DOC, URL, { minWords: 1 });
    expect(direct.status).toBe('ok');
    const cleaned = await Defuddle(DOC, URL, { markdown: false });
    const reparsed = await extractFromHtml(cleaned.content, URL, { minWords: 1 });
    expect(reparsed.status).toBe('ok');
    expect(reparsed.content).toBe(direct.content);
  });
});
