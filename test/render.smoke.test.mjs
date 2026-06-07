import { describe, it, expect } from 'vitest';
import { connectBrowser, renderPage } from '../src/render.mjs';

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
});
