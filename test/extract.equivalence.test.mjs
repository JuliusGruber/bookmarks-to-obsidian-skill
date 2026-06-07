import { describe, it, expect } from 'vitest';
import { Defuddle } from 'defuddle/node';
import { extractFromHtml } from '../src/extract.mjs';

const URL = 'https://example.com/post';
const DOC = `<!doctype html><html><head><title>Eq Title</title></head><body>
  <article>
    <h1>Eq Title</h1>
    ${'<p>This is a sufficiently long paragraph of article prose so Defuddle keeps it. </p>'.repeat(12)}
    <ul><li>one</li><li>two</li></ul>
    <pre><code>const x = 1;</code></pre>
  </article></body></html>`;

describe('rendered-path double-parse is byte-stable', () => {
  it('node-reparse of cleaned HTML equals direct conversion', async () => {
    // Direct markdown (what the fallback path produces).
    const direct = await extractFromHtml(DOC, URL, { minWords: 1 });
    expect(direct.status).toBe('ok');
    // Cleaned HTML (what the in-page render returns as r.content), then re-parsed
    // to markdown exactly as import.mjs does for the rendered path.
    const cleaned = await Defuddle(DOC, URL, { markdown: false });
    const reparsed = await extractFromHtml(cleaned.content, URL, { minWords: 1 });
    expect(reparsed.status).toBe('ok');
    expect(reparsed.content).toBe(direct.content);
  });
});
