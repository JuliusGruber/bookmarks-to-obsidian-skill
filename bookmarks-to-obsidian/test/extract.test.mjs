import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFromHtml } from '../scripts/src/extract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFile(join(here, 'fixtures', name), 'utf8');

describe('extractFromHtml', () => {
  it('extracts a real article to markdown with parity metadata', async () => {
    const html = await fixture('article.html');
    const res = await extractFromHtml(html, 'https://martinfowler.com/articles/harness-engineering.html', {
      minWords: 200,
    });
    expect(res.status).toBe('ok');
    expect(res.wordCount).toBeGreaterThanOrEqual(200);
    expect(res.content).toMatch(/harness/i);
    expect(res.meta.title).toBe('Harness engineering for coding agent users');
    expect(res.meta.author).toContain('Birgitta Böckeler');
    expect(res.meta.published).toContain('2026-04-02');
    expect(res.meta.description).toMatch(/mental model/i);
    // nav/footer chrome should be stripped by Defuddle
    expect(res.content).not.toMatch(/Subscribe to our newsletter/i);
  });

  it('classifies a thin video page as skipped-thin', async () => {
    const html = await fixture('thin.html');
    const res = await extractFromHtml(html, 'https://example.com/watch', { minWords: 200 });
    expect(res.status).toBe('skipped-thin');
    expect(res.wordCount).toBeLessThan(200);
  });
});
