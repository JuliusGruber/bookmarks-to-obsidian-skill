// Render a page in the already-running gateway Chrome (CDP) and run Defuddle in
// the live document — the same thing the Obsidian Web Clipper does. Also harvests
// every image/* network response the page loaded into a Map<url,{bytes,...}> so
// the importer can reuse the authenticated bytes instead of re-fetching. Returns
// the cleaned content HTML, rendered-DOM metadata, and that image map. Markdown
// conversion happens in node afterwards via extractFromHtml. Never launches or
// closes the browser (connect/disconnect only); only fresh tabs are opened/closed.
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// Browser UMD bundle that defines window.Defuddle (the class) and, in 0.18.1, also
// window.Defuddle.createMarkdownContent. We run parse() in-page (it flattens shadow
// DOM, resolves <noscript>/lazy images, and absolutizes URLs internally) and convert
// to markdown in node via extractFromHtml (proven byte-stable — see Task 3 Step 2).
const DEFUDDLE_BUNDLE = join(HERE, '..', 'node_modules', 'defuddle', 'dist', 'index.full.js');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // skip giant images; node-fetch/remote handles them

// Curated, exact accept-button labels (normalized lower-case). Precision over
// recall: a missed banner falls through pick-the-better; a wrong click corrupts.
const CONSENT_LABELS = new Set([
  'accept all', 'accept all cookies', 'accept', 'i accept', 'agree', 'i agree',
  'allow all', 'got it', 'ok',
  'alle akzeptieren', 'alle cookies akzeptieren', 'akzeptieren', 'zustimmen',
  'einwilligen', 'ich stimme zu', 'einverstanden', 'cookies akzeptieren',
]);
// Known CMP accept buttons by id/class (fast path, specific — no broad *accept* match).
const CONSENT_KNOWN = [
  '#onetrust-accept-btn-handler',
  '#truste-consent-button',
  '.fc-cta-consent',
  '.qc-cmp2-summary-buttons button[mode="primary"]',
  'button[data-testid="uc-accept-all-button"]',
  '#didomi-notice-agree-button',
];

// Scroll to the bottom (and back) to trigger lazy-loaders before extraction.
const AUTOSCROLL = `async () => {
  await new Promise((resolve) => {
    let total = 0; const step = 800;
    const timer = setInterval(() => {
      window.scrollBy(0, step); total += step;
      if (total >= document.body.scrollHeight + 2000) { clearInterval(timer); resolve(); }
    }, 60);
    setTimeout(() => { clearInterval(timer); resolve(); }, 6000);
  });
  window.scrollTo(0, 0);
}`;

// Precision-first consent dismissal: known CMP ids first, then exact-label visible
// buttons that live inside a consent context (fixed/sticky/dialog/CMP container).
const DISMISS_CONSENT = `(labels) => {
  const wanted = new Set(labels);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const known = ${JSON.stringify(CONSENT_KNOWN)};
  for (const sel of known) {
    const el = document.querySelector(sel);
    if (el && visible(el)) { el.click(); return true; }
  }
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const inConsentContext = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.position === 'fixed' || s.position === 'sticky') return true;
      if (n.getAttribute && (n.getAttribute('role') === 'dialog' || n.getAttribute('aria-modal') === 'true')) return true;
      const idc = ((n.id || '') + ' ' + (typeof n.className === 'string' ? n.className : '')).toLowerCase();
      if (/onetrust|cookiebot|truste|quantcast|sourcepoint|didomi|usercentrics|cmp|consent|gdpr|cookie/.test(idc)) return true;
    }
    return false;
  };
  for (const b of document.querySelectorAll('button, [role="button"], a[role="button"]')) {
    if (!visible(b)) continue;
    if (!wanted.has(norm(b.textContent))) continue;
    if (!inConsentContext(b)) continue;
    b.click();
    return true;
  }
  return false;
}`;

/** Connect to an existing Chrome over CDP. Does not download or launch a browser. */
export async function connectBrowser(cdpUrl = 'http://localhost:9222') {
  return puppeteer.connect({ browserURL: cdpUrl, protocolTimeout: 60000 });
}

async function tryDismissConsent(page) {
  try {
    await page.evaluate(`(${DISMISS_CONSENT})(${JSON.stringify([...CONSENT_LABELS])})`);
    await new Promise((r) => setTimeout(r, 300)); // let any overlay tear-down settle
  } catch { /* never fatal */ }
}

// Wait for image responses to quiesce (no new image for ~800ms), hard-capped 3s.
async function settleImages(getLastAt, startedAt) {
  for (;;) {
    const idleFor = Date.now() - (getLastAt() || startedAt);
    if (idleFor >= 800) return;
    if (Date.now() - startedAt >= 3000) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Render `url`, capture its images, and extract via in-page Defuddle.
 * Returns { status:'ok', content, images: Map<url,{bytes,contentType}>, title,
 * author, published, description, image, site, domain, wordCount } or
 * { status:'render-failed', reason, images }.
 */
export async function renderPage(browser, url, { navTimeoutMs = 25000, dismissConsent = true } = {}) {
  let page;
  const images = new Map();
  const pending = [];
  let lastImageAt = 0;

  try {
    page = await browser.newPage();
    await page.setBypassCSP(true);      // let addScriptTag run on CSP-strict pages
    await page.setCacheEnabled(false);  // force real response bodies (else cache hits = empty buffer)
    await page.setViewport({ width: 1280, height: 900 });

    page.on('response', (res) => {
      try {
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        if (!ct.startsWith('image/')) return;
        const reqUrl = res.request().url();
        if (!reqUrl || reqUrl.startsWith('data:')) return;
        const clen = Number(res.headers()['content-length'] || 0);
        if (clen && clen > MAX_IMAGE_BYTES) return;
        const p = res.buffer().then((buf) => {
          if (buf && buf.length && buf.length <= MAX_IMAGE_BYTES) {
            images.set(reqUrl, { bytes: new Uint8Array(buf), contentType: ct });
            lastImageAt = Date.now();
          }
        }).catch(() => {});
        pending.push(p);
      } catch { /* ignore */ }
    });

    const startedAt = Date.now();
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: navTimeoutMs });
    } catch { /* slow/chatty page: extract whatever finished loading */ }

    if (dismissConsent) await tryDismissConsent(page);
    await page.evaluate(`(${AUTOSCROLL})()`).catch(() => {});
    if (pending.length) await settleImages(() => lastImageAt, startedAt);
    await Promise.allSettled(pending); // ensure every buffered body resolved before close

    await page.addScriptTag({ path: DEFUDDLE_BUNDLE });
    const result = await page.evaluate((pageUrl) => {
      const D = window.Defuddle;
      if (!D) return null;
      const r = new D(document, { url: pageUrl }).parse();
      return {
        content: r.content, title: r.title, author: r.author,
        published: r.published, description: r.description, image: r.image,
        site: r.site, domain: r.domain, wordCount: r.wordCount,
      };
    }, url);

    if (!result || !result.content) return { status: 'render-failed', reason: 'empty parse result', images };
    return { status: 'ok', images, ...result };
  } catch (e) {
    return { status: 'render-failed', reason: e.message || String(e), images };
  } finally {
    if (page) { try { await page.close(); } catch { /* ignore */ } }
  }
}
