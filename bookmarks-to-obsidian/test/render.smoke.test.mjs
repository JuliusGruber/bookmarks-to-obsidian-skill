import { describe, it, expect } from 'vitest';
import { connectBrowser, renderPage } from '../scripts/src/render.mjs';

const RUN = process.env.RENDER_SMOKE === '1';
const d = RUN ? describe : describe.skip;

d('renderPage (live CDP smoke)', () => {
  it('renders a data: page and extracts the body via in-page Defuddle', async () => {
    const browser = await connectBrowser(process.env.CDP_URL || 'http://localhost:9222');
    try {
      const html =
        '<h1>Smoke Title</h1><article><p>' +
        'This is a sufficiently long article body so Defuddle keeps it as content. '.repeat(8) +
        '</p></article>';
      const res = await renderPage(browser, 'data:text/html,' + encodeURIComponent(html));
      expect(res.status).toBe('ok');
      expect(res.content).toMatch(/sufficiently long article body/);
      expect(res.images instanceof Map).toBe(true);
    } finally {
      await browser.disconnect(); // never .close() — that would kill the gateway Chrome
    }
  }, 60000);

  // Regression guard for the x.com image loss: the render path must convert to
  // markdown IN-PAGE. The old double-parse (re-running node Defuddle on r.content)
  // dropped div-wrapped inline images (12 -> 1 on x.com). renderPage must return
  // markdown that preserves every inline image.
  it('returns markdown preserving every div-wrapped inline image', async () => {
    const browser = await connectBrowser(process.env.CDP_URL || 'http://localhost:9222');
    try {
      const prose = 'Paragraph of sufficiently long article prose so Defuddle keeps the body. '.repeat(4);
      const svg = (c) => 'data:image/svg+xml,' + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="140"><rect width="240" height="140" fill="${c}"/></svg>`);
      const colors = ['crimson', 'seagreen', 'steelblue', 'goldenrod'];
      const html = '<h1>Image Test</h1><article>' +
        colors.map((c, i) => `<p>${prose}</p><div><img src="${svg(c)}" alt="figure ${i}"></div>`).join('') +
        '</article>';
      const res = await renderPage(browser, 'data:text/html,' + encodeURIComponent(html));
      expect(res.status).toBe('ok');
      // r.content must be MARKDOWN (![alt](url)), with all inline images preserved.
      const mdImageCount = (res.content.match(/!\[[^\]]*\]\(/g) || []).length;
      expect(mdImageCount).toBe(colors.length);
    } finally {
      await browser.disconnect();
    }
  }, 60000);
});
