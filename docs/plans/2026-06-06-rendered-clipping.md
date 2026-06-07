# Rendered clipping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `bookmarks-to-obsidian` produce Web-Clipper-quality markdown by rendering each page in the already-running gateway Chrome (CDP), running Defuddle in the live DOM, **harvesting the images the page already loaded from the render's own network responses**, and writing them into the vault — with a raw-fetch path kept as a fallback and a render-vs-fetch "pick the better" step so nothing regresses and consent/JS shells don't slip through.

**Architecture:** Add three modules. `src/render.mjs` connects to Chrome over CDP (connect-only, no bundled browser), dismisses consent walls (EN+DE, precision-targeted), renders the page, **captures every `image/*` network response into a `Map<url, bytes>`**, and runs Defuddle's browser bundle in the live `document` to get cleaned HTML + rendered-DOM metadata. `src/shell.mjs` is a small keyword detector (EN+DE) that flags consent/paywall/JS-shell extractions. `src/images.mjs` takes the captured bytes (falling back to a node fetch, then to leaving the remote URL), filters tracking pixels, dedupes, and rewrites references to Obsidian embeds. `import.mjs` is rewired to a render → extract → **pick-the-better-vs-fetch** → harvest-images → write flow, falling back to today's `fetchPage` path whenever the render is missing, thin, or shell-flagged. The markdown converter is unchanged — `extractFromHtml` re-converts the in-page-cleaned HTML, and a committed equivalence test pins that this double-parse is byte-stable.

**Tech Stack:** Node ESM, **Defuddle 0.18.1** (`defuddle/node` for node-side conversion — parses via **linkedom**, not jsdom; `dist/index.full.js` browser bundle injected in-page, which in 0.18.1 exposes both the `Defuddle` class **and** `createMarkdownContent`), `puppeteer-core` (CDP connect + response capture), `image-size` (tracking-pixel filter), vitest.

---

## Reconciliation 2026-06-07 — aligned to Defuddle 0.18.1

This plan was authored against Defuddle 0.6.6. Since then the spec was revised into a
three-rung staircase and **rung 1 (the 0.6.6 → 0.18.1 upgrade) shipped** (`package.json`
now pins `defuddle ^0.18.1`; the unused `jsdom` dep was removed; 43 tests green). This
plan is updated to match. **Do not re-introduce 0.6.6 or jsdom** — Task 0 below no longer
does.

Verified against the installed 0.18.1 build (so the render path still works as written):

- The browser UMD bundle still exposes `window.Defuddle` as the **class**; `new
  Defuddle(document, { url }).parse()` is unchanged, and `parseAsync()` also exists.
- The bundle **also** exposes `window.Defuddle.createMarkdownContent` (0.6.6 did not), so
  in-page markdown conversion is now possible. We still keep the node re-parse
  (deviation #1) because it reuses the tested `extractFromHtml` and is **proven
  byte-stable on 0.18.1** (re-parsing cleaned HTML == direct conversion, verified on the
  article fixture).

What the engine now does itself (this absorbs / obsoletes parts of the old plan):

- **Shadow DOM** — `parse()` flattens shadow roots internally (`flattenShadowRoots` /
  `replaceShadowHost`), and because we run Defuddle in the page's **main world** open
  shadow roots are directly readable. Deviation #4's hand-rolled flatten is gone *and* no
  `data-defuddle-shadow` stamp is needed — see the revised #4.
- **URL absolutization + `<noscript>` images** — handled in-engine
  (`resolveRelativeUrls` / `resolveContentUrls`, `_resolveNoscriptImages`) on **both** the
  in-page and node paths. That is exactly spec **rung 2**, so no separate preprocessing
  stage is needed; the only URL resolution left in this plan is `images.mjs`'s
  `resolveUrl` (to match captured-byte keys), which stays.
- Also new in 0.18.1: React streaming-SSR recovery (`resolveStreamedContent`), image
  dedup / best-srcset (`_deduplicateImages`, `_pickBestImage`), and cover-image removal
  (`_removeCoverImage`).

---

## Deviations from the approved spec (call out if you disagree)

1. **Markdown path (node re-parse, kept):** node conversion of in-page-cleaned HTML is the **primary** path, not a fallback. The in-page `parse()` returns `content` as cleaned **HTML** (`DefuddleResponse.content`); re-feeding it through `extractFromHtml` reuses the existing, tested converter and is **proven byte-stable on 0.18.1** (see the Reconciliation note). *Updated for 0.18.1:* the `index.full.js` bundle now **also** exposes `window.Defuddle.createMarkdownContent`, so converting in-page is an available alternative that would drop the double-parse entirely — we keep the node re-parse for now because it reuses tested code, but if a future Defuddle bump ever breaks the equivalence test, switch to the in-page converter rather than pinning back. A committed equivalence test (Task 3) guards the double-parse either way.
2. **Image transport — now re-aligned with the spec's "browser-context first".** Images are **harvested from the render's own network responses** (the dedicated Chrome already fetched them, authenticated, defeating hotlink/cookie/CORS). A node fetch (`Referer` + Chrome UA) is the **fallback** for anything not captured (lazy images still in flight, `srcset` mismatches, redirects), and leaving the remote URL in place is the final tier. The prior plan's "node-fetch first" is demoted to tier 2.
3. **Consent dismissal is ON by default** (deviation from the spec's "optional-off"). Flag is `--no-dismiss-consent` to opt out. Targeting is **precision-first** (curated exact EN+DE labels, visible, inside a consent context, click-once, known-CMP fast path) so it almost never misclicks — a missed banner just falls through the pick-the-better ladder.
4. **Shadow-DOM handling is now the engine's job (no manual step).** *Updated for 0.18.1:* Defuddle's `parse()` flattens shadow roots internally (`flattenShadowRoots` / `replaceShadowHost`, walking both trees in parallel for exact positional correspondence and avoiding the custom-element re-init trap). Because we run Defuddle in the page's **main world**, open shadow roots are directly accessible to it. So we add **neither** a hand-rolled flatten **nor** the extension's `data-defuddle-shadow` stamp — both are obsolete. (The old worry about an indiscriminate flatten inflating `wordCount` and poisoning the gates no longer applies: we don't do the flatten, the engine does, well.) Closed shadow roots stay unreachable — accepted, same as the extension.
5. **New: render-vs-fetch "pick the better".** When a render is missing, below `--min-words`, or shell-flagged, the raw fetch is also run and the better extraction wins (shell-flagged candidates disqualified; longest non-shell wins; render breaks ties). Prevents a JS-injected consent/subscribe overlay from being saved as a successful `rendered` note.
6. **New: `--dry-run` renders too** (capped to `--limit`; bare `--dry-run` caps at 10) so the preview reflects the real path and accurate statuses — but writes no notes and downloads no images.

Everything else matches the spec: drive the gateway Chrome on `:9222`, in-page Defuddle parse for layout-based cleanup, shared `<inbox>/_attachments/` folder, `![[wikilink]]` embeds, `rendered` vs `fetched-fallback` ladder, render concurrency 3, no metadata/frontmatter changes (the captured `image`/og:image cover is intentionally not surfaced).

## File structure

| File | Status | Responsibility |
|---|---|---|
| `package.json` | modify | add `puppeteer-core`, `image-size` deps |
| `src/shell.mjs` | create | keyword (EN+DE) consent/paywall/JS-shell detector |
| `test/shell.test.mjs` | create | unit tests for the detector |
| `src/images.mjs` | create | rewrite refs to `![[…]]` from **captured bytes** (→ node-fetch → remote), dedupe + tracking-pixel filter, cross-run-safe naming |
| `test/images.test.mjs` | create | unit tests incl. captured-bytes path + disk-seeded collision |
| `src/render.mjs` | create | CDP connect, consent dismiss, render, **image response capture**, in-page Defuddle parse → cleaned HTML + metadata + bytes `Map` |
| `test/render.smoke.test.mjs` | create | opt-in live smoke test (skipped unless `RENDER_SMOKE=1`) |
| `test/extract.equivalence.test.mjs` | create | pins that node-reparse of cleaned HTML is byte-stable (guards the double-parse) |
| `import.mjs` | modify | render→pick-better→harvest→write flow, fallback ladder, new flags, dry-run render, stderr progress, render/image summary |
| `SKILL.md` | modify | document rendering, images, new flags, perf note |
| `README.md` | modify | same, for the standalone tool |

The existing `src/extract.mjs`, `src/frontmatter.mjs`, `src/note.mjs`, `src/dedup.mjs`, `src/gateway.mjs`, `src/report.mjs` are reused unchanged (`extract.mjs` becomes the fallback converter and the node re-parser for the rendered path).

> **Module coupling note:** `render.mjs` now *acquires* image bytes and `images.mjs` *writes* them — they are coupled through a plain `Map<url, {bytes, contentType}>` passed in. The boundary stays clean (render knows nothing about embeds; images knows nothing about CDP), but they are no longer fully independent.

---

## Task 0: Dependencies

**Files:**
- Modify: `package.json`

- [x] **Step 1: Add the two dependencies**

`defuddle` is already at `^0.18.1` and `jsdom` was already removed (spec rung 1, shipped 2026-06-07) — this step only **adds** `image-size` and `puppeteer-core`. Edit the `dependencies` block in `package.json` so it reads exactly:

```json
  "dependencies": {
    "defuddle": "^0.18.1",
    "image-size": "^2.0.0",
    "puppeteer-core": "^23.0.0"
  },
```

- [x] **Step 2: Install**

Run: `npm install`
Expected: completes without error; `node_modules/puppeteer-core` and `node_modules/image-size` exist. `puppeteer-core` does **not** download a browser (that is `puppeteer`, which we are not installing).

- [x] **Step 3: Verify the image-size v2 named API**

Create `_probe.mjs` at the skill root:

```js
import { imageSize } from 'image-size';
// minimal 120x80 PNG header
const b = Buffer.alloc(33);
b.write('\x89PNG\r\n\x1a\n', 0, 'binary');
b.writeUInt32BE(13, 8); b.write('IHDR', 12);
b.writeUInt32BE(120, 16); b.writeUInt32BE(80, 20);
const d = imageSize(new Uint8Array(b));
console.log('image-size:', d.width, d.height, d.type);   // expect 120 80 png
```

Run (PowerShell): `node _probe.mjs ; Remove-Item _probe.mjs`
Expected: `image-size: 120 80 png`. If the named import fails, the installed major is not 2.x — re-pin and adjust `images.mjs` imports before continuing.

- [x] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add puppeteer-core and image-size deps"
```

---

## Task 1: `src/shell.mjs` — consent/paywall/JS-shell detector

A small, pure, unit-tested predicate used by the pick-the-better step to disqualify extractions that are really a cookie wall, a subscribe interstitial, or a "please enable JavaScript" stub. Kept deliberately simple: a curated EN+DE phrase list plus a length/density rule.

**Files:**
- Create: `src/shell.mjs`
- Test: `test/shell.test.mjs`

- [x] **Step 1: Write the failing tests**

Create `test/shell.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { looksLikeShell } from '../src/shell.mjs';

describe('looksLikeShell', () => {
  it('passes a normal long article with an incidental cookie mention', () => {
    const body = 'This article explains transformers in depth. '.repeat(60) +
      'We briefly note the site uses a cookie for preferences.';
    expect(looksLikeShell(body, { minWords: 200 })).toBe(false);
  });

  it('flags a short English consent wall', () => {
    const md = 'We value your privacy. This site uses cookies. Accept all cookies to continue.';
    expect(looksLikeShell(md, { minWords: 200 })).toBe(true);
  });

  it('flags a short German consent wall', () => {
    const md = 'Wir schätzen Ihre Privatsphäre. Diese Seite verwendet Cookies. Alle akzeptieren, um fortzufahren.';
    expect(looksLikeShell(md, { minWords: 200 })).toBe(true);
  });

  it('flags a JavaScript-required stub', () => {
    expect(looksLikeShell('Please enable JavaScript to continue.', { minWords: 200 })).toBe(true);
  });

  it('flags a wordy-but-marker-dense paywall pitch', () => {
    const md = ('Subscribe to continue reading. Create a free account. Sign in to continue. ' +
      'Subscribe to read the full story. ').repeat(6);
    expect(looksLikeShell(md, { minWords: 200 })).toBe(true);
  });

  it('returns false on empty input', () => {
    expect(looksLikeShell('', { minWords: 200 })).toBe(false);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/shell.test.mjs`
Expected: FAIL — `Cannot find module '../src/shell.mjs'`.

- [x] **Step 3: Implement `src/shell.mjs`**

Create `src/shell.mjs`:

```js
// Detect whether an extracted body is really a consent wall, paywall/subscribe
// interstitial, or a "please enable JavaScript" shell rather than an article.
// Pure and deliberately simple: curated EN+DE phrases + a length/density rule.
// Used by the pick-the-better step to disqualify a bad render or fetch.

const SHELL_PHRASES = [
  // English — consent / cookies
  'we value your privacy', 'this site uses cookies', 'we use cookies',
  'accept all cookies', 'accept cookies', 'cookie policy', 'manage your privacy',
  'manage cookies', 'privacy preferences',
  // English — paywall / auth
  'subscribe to continue', 'subscribe to read', 'create a free account',
  'sign in to continue', 'log in to continue', 'continue reading',
  'to read the full', 'register to continue',
  // English — JS shell
  'enable javascript', 'please enable javascript', 'javascript is required',
  'javascript is disabled',
  // German — consent / cookies
  'wir schätzen ihre privatsphäre', 'diese seite verwendet cookies',
  'wir verwenden cookies', 'alle akzeptieren', 'cookies akzeptieren',
  'datenschutzeinstellungen', 'privatsphäre-einstellungen', 'cookie-einstellungen',
  // German — paywall / auth
  'jetzt abonnieren', 'um weiterzulesen', 'anmelden um weiterzulesen',
  'registrieren um', 'um fortzufahren',
  // German — JS shell
  'bitte aktivieren sie javascript', 'javascript aktivieren',
];

/**
 * True when `text` looks like a consent/paywall/JS shell rather than an article.
 * Rules: short text with ANY marker is a shell; otherwise, only flag when markers
 * are dense relative to length (a long article that mentions "cookie" once passes).
 */
export function looksLikeShell(text, { minWords = 200 } = {}) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return false;
  const words = t.split(/\s+/).filter(Boolean).length;
  let hits = 0;
  for (const p of SHELL_PHRASES) if (t.includes(p)) hits += 1;
  if (hits === 0) return false;
  if (words < minWords) return true;            // short + any marker → shell
  return hits >= 3 && words < minWords * 3;     // marker-dense in not-much-text → shell
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/shell.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/shell.mjs test/shell.test.mjs
git commit -m "feat(shell): EN+DE consent/paywall/JS-shell detector"
```

---

## Task 2: `src/images.mjs` — captured-bytes-first image rewrite

**Files:**
- Create: `src/images.mjs`
- Test: `test/images.test.mjs`

Acquisition is three-tier: **captured render bytes → node fetch → leave remote**. Naming is cross-run-safe (the caller seeds `takenNames` from the existing `_attachments/` listing, and passes the disambiguated note filename as the slug).

- [x] **Step 1: Write the failing tests**

Create `test/images.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractImageRefs,
  resolveUrl,
  pickExtension,
  attachmentBase,
  uniqueAttachmentName,
  downloadImages,
} from '../src/images.mjs';

// Build a minimal valid PNG header that image-size can read (w x h).
function fakePng(w, h) {
  const b = Buffer.alloc(33);
  b.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return new Uint8Array(b);
}

describe('extractImageRefs', () => {
  it('finds markdown images, unwrapping <> and ignoring titles', () => {
    const md = 'a ![x](https://e.com/a.png) b ![](<https://e.com/b.jpg> "t") c';
    const refs = extractImageRefs(md);
    expect(refs.map((r) => r.url)).toEqual(['https://e.com/a.png', 'https://e.com/b.jpg']);
    expect(refs[0].alt).toBe('x');
  });
});

describe('resolveUrl', () => {
  it('absolutizes relative against the base, returns null on garbage', () => {
    expect(resolveUrl('/p/x.png', 'https://e.com/a/')).toBe('https://e.com/p/x.png');
    expect(resolveUrl('::::', 'not a url')).toBeNull();
  });
});

describe('pickExtension', () => {
  it('prefers detected type, then content-type, then URL suffix, else png', () => {
    expect(pickExtension('jpg', 'image/png', 'x')).toBe('jpg');
    expect(pickExtension(null, 'image/webp; charset=x', 'x')).toBe('webp');
    expect(pickExtension(null, '', 'https://e.com/x.GIF?z=1')).toBe('gif');
    expect(pickExtension(null, '', 'https://e.com/noext')).toBe('png');
  });
});

describe('attachment naming', () => {
  it('zero-pads the index and sanitizes the slug', () => {
    expect(attachmentBase('My Note/Title', 3)).toBe('My Note Title-03');
  });
  it('avoids collisions against taken names (incl. disk-seeded)', () => {
    const taken = new Set(['note-01.png']);
    expect(uniqueAttachmentName('note', 1, 'png', taken)).toBe('note-01 (2).png');
  });
});

describe('downloadImages', () => {
  const attachDir = () => mkdtemp(join(tmpdir(), 'b2o-'));

  it('uses captured bytes first, never calls fetchImpl on a hit', async () => {
    const dir = await attachDir();
    const md = '![a](https://e.com/a.png)';
    const capturedBytes = new Map([
      ['https://e.com/a.png', { bytes: fakePng(120, 80), contentType: 'image/png' }],
    ]);
    let fetchCalls = 0;
    const fetchImpl = async () => { fetchCalls += 1; return null; };
    const res = await downloadImages(md, {
      baseUrl: 'https://e.com/post', slug: 'note', attachDir: dir, capturedBytes, fetchImpl,
    });
    expect(fetchCalls).toBe(0);
    expect(res.downloaded).toBe(1);
    expect(res.markdown).toContain('![[note-01.png]]');
  });

  it('falls back to fetchImpl when not captured, rewrites + dedupes by hash', async () => {
    const dir = await attachDir();
    const md = '![a](https://e.com/a.png)\n\n![b](https://e.com/dup.png)';
    const png = fakePng(120, 80);
    const fetchImpl = async () => ({ bytes: png, contentType: 'image/png' });
    const res = await downloadImages(md, { baseUrl: 'https://e.com/post', slug: 'note', attachDir: dir, fetchImpl });
    expect(res.downloaded).toBe(1); // identical bytes => one file, two embeds
    expect((res.markdown.match(/!\[\[note-01\.png\]\]/g) || []).length).toBe(2);
    const files = await readdir(dir);
    expect(files).toEqual(['note-01.png']);
    expect((await readFile(join(dir, 'note-01.png'))).length).toBe(png.length);
  });

  it('respects disk-seeded takenNames so cross-run names never collide', async () => {
    const dir = await attachDir();
    const md = '![a](https://e.com/a.png)';
    const fetchImpl = async () => ({ bytes: fakePng(120, 80), contentType: 'image/png' });
    const takenNames = new Set(['note-01.png']); // pretend a prior run wrote this
    const res = await downloadImages(md, {
      baseUrl: 'https://e.com/post', slug: 'note', attachDir: dir, fetchImpl, takenNames,
    });
    expect(res.markdown).toContain('![[note-01 (2).png]]');
    expect(await readdir(dir)).toEqual(['note-01 (2).png']);
  });

  it('drops tracking pixels (< 33px) and removes their reference', async () => {
    const dir = await attachDir();
    const md = 'before ![pixel](https://e.com/p.png) after';
    const fetchImpl = async () => ({ bytes: fakePng(1, 1), contentType: 'image/png' });
    const res = await downloadImages(md, { baseUrl: 'https://e.com/post', slug: 'note', attachDir: dir, fetchImpl });
    expect(res.dropped).toBe(1);
    expect(res.downloaded).toBe(0);
    expect(res.markdown).toBe('before  after');
  });

  it('leaves the remote URL and counts remote when acquisition fails', async () => {
    const dir = await attachDir();
    const md = '![a](https://e.com/a.png)';
    const fetchImpl = async () => null;
    const res = await downloadImages(md, { baseUrl: 'https://e.com/post', slug: 'note', attachDir: dir, fetchImpl });
    expect(res.remote).toBe(1);
    expect(res.markdown).toBe('![a](https://e.com/a.png)');
  });

  it('skips data: URIs untouched', async () => {
    const dir = await attachDir();
    const md = '![x](data:image/png;base64,AAAA)';
    let called = 0;
    const fetchImpl = async () => { called += 1; return null; };
    const res = await downloadImages(md, { baseUrl: 'https://e.com/post', slug: 'note', attachDir: dir, fetchImpl });
    expect(called).toBe(0);
    expect(res.markdown).toBe(md);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/images.test.mjs`
Expected: FAIL — `Cannot find module '../src/images.mjs'`.

- [x] **Step 3: Implement `src/images.mjs`**

Create `src/images.mjs`:

```js
// Rewrite the image references in extracted markdown to Obsidian embeds
// (![[name]]), sourcing the bytes in three tiers:
//   1. capturedBytes  — bytes the render already pulled from the live page
//   2. fetchImpl       — a node fetch with Referer+UA (hotlink-protection bust)
//   3. leave the remote URL in place (counted as `remote`) so notes never break.
// Embeds (not ![](path)) are used so links survive when the note is later moved
// between folders — Obsidian resolves embeds by basename anywhere in the vault.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { imageSize } from 'image-size';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ![alt](url) or ![alt](<url> "title"); url stops at whitespace or ) unless <wrapped>.
const IMG_RE = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

const ILLEGAL = /[\\/:*?"<>|]/g;
const EXT_BY_TYPE = {
  png: 'png', jpg: 'jpg', jpeg: 'jpg', gif: 'gif', webp: 'webp',
  svg: 'svg', bmp: 'bmp', avif: 'avif', ico: 'ico', tiff: 'tiff',
};

/** Parse markdown image references in document order. */
export function extractImageRefs(markdown) {
  const refs = [];
  for (const m of String(markdown).matchAll(IMG_RE)) {
    let url = m[2].trim();
    if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1);
    refs.push({ raw: m[0], alt: m[1], url });
  }
  return refs;
}

/** Absolutize `url` against `base`; null if it can't be parsed. */
export function resolveUrl(url, base) {
  try { return new URL(url, base).href; } catch { return null; }
}

/** Choose a file extension from (in order) the sniffed type, content-type, URL. */
export function pickExtension(detectedType, contentType, url) {
  if (detectedType && EXT_BY_TYPE[detectedType]) return EXT_BY_TYPE[detectedType];
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  const fromCt = ct.startsWith('image/') ? ct.slice(6) : '';
  if (EXT_BY_TYPE[fromCt]) return EXT_BY_TYPE[fromCt];
  const m = String(url || '').split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  if (m && EXT_BY_TYPE[m[1].toLowerCase()]) return EXT_BY_TYPE[m[1].toLowerCase()];
  return 'png';
}

export function hashBytes(buf) {
  return createHash('sha1').update(buf).digest('hex').slice(0, 12);
}

/** `<slug>-NN` with the slug stripped of filename-illegal characters. */
export function attachmentBase(slug, index) {
  const safe = String(slug || 'image').replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim() || 'image';
  return `${safe}-${String(index).padStart(2, '0')}`;
}

/** First non-colliding `<base>.<ext>`, then `<base> (2).<ext>`, … */
export function uniqueAttachmentName(slug, index, ext, taken) {
  const base = attachmentBase(slug, index);
  let name = `${base}.${ext}`;
  let n = 2;
  while (taken.has(name)) { name = `${base} (${n}).${ext}`; n += 1; }
  return name;
}

function replaceAll(haystack, needle, replacement) {
  return haystack.split(needle).join(replacement);
}

async function defaultImageFetch(url, referer) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': UA,
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      ...(referer ? { referer } : {}),
    },
  });
  if (!res.ok) return null;
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || '',
  };
}

/**
 * Rewrite every image in `markdown` to an Obsidian embed, sourcing bytes from
 * `capturedBytes` first, then `fetchImpl`, else leaving the remote URL. Dedupes
 * identical bytes within the note and drops tracking-pixel-sized images.
 * `takenNames` is seeded by the caller from the existing _attachments/ listing so
 * names never collide across runs. Returns { markdown, downloaded, remote, dropped }.
 */
export async function downloadImages(markdown, {
  baseUrl,
  slug,
  attachDir,
  capturedBytes = new Map(),
  fetchImpl = defaultImageFetch,
  minDim = 33,
  minBytes = 512,
  takenNames = new Set(),
} = {}) {
  // Unique by raw match so an image used twice is processed once.
  const refs = [];
  const seenRaw = new Set();
  for (const r of extractImageRefs(markdown)) {
    if (!seenRaw.has(r.raw)) { seenRaw.add(r.raw); refs.push(r); }
  }

  let out = markdown;
  let downloaded = 0;
  let remote = 0;
  let dropped = 0;
  const byHash = new Map();
  let index = 0;

  for (const ref of refs) {
    const abs = resolveUrl(ref.url, baseUrl);
    if (!abs || abs.startsWith('data:')) continue; // leave untouched
    index += 1;

    // Tier 1: bytes the render already captured. Tier 2: node fetch.
    let dl = capturedBytes.get(abs) || null;
    if (!dl) {
      try { dl = await fetchImpl(abs, baseUrl); } catch { dl = null; }
    }
    // Tier 3: leave the remote URL untouched.
    if (!dl || !dl.bytes || dl.bytes.length === 0) { remote += 1; continue; }

    let dim = null;
    try { dim = imageSize(dl.bytes); } catch { dim = null; }
    const maxDim = dim ? Math.max(dim.width || 0, dim.height || 0) : null;
    const junk = (maxDim !== null && maxDim < minDim) ||
                 (maxDim === null && dl.bytes.length < minBytes);
    if (junk) { out = replaceAll(out, ref.raw, ''); dropped += 1; continue; }

    const h = hashBytes(dl.bytes);
    let name = byHash.get(h);
    if (!name) {
      const ext = pickExtension(dim && dim.type, dl.contentType, abs);
      name = uniqueAttachmentName(slug, index, ext, takenNames);
      takenNames.add(name);
      await mkdir(attachDir, { recursive: true });
      await writeFile(join(attachDir, name), dl.bytes);
      byHash.set(h, name);
      downloaded += 1;
    }
    out = replaceAll(out, ref.raw, `![[${name}]]`);
  }

  return { markdown: out, downloaded, remote, dropped };
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/images.test.mjs`
Expected: PASS — all assertions green.

- [x] **Step 5: Commit**

```bash
git add src/images.mjs test/images.test.mjs
git commit -m "feat(images): captured-bytes-first download, cross-run-safe naming, embeds"
```

---

## Task 3: `src/render.mjs` — CDP render + image capture + in-page Defuddle

**Files:**
- Create: `src/render.mjs`
- Test: `test/render.smoke.test.mjs`
- Test: `test/extract.equivalence.test.mjs`

- [ ] **Step 1: Implement `src/render.mjs`**

Create `src/render.mjs`:

```js
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
```

- [ ] **Step 2: Write the equivalence test (guards the double-parse)**

Create `test/extract.equivalence.test.mjs`. It pins that converting Defuddle's cleaned **HTML** to markdown via `extractFromHtml` equals converting the original document directly — i.e. the rendered path's node re-parse is byte-stable against the converter the fallback uses.

```js
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
```

> Byte-stability was verified on Defuddle 0.18.1 against the article fixture during the 2026-06-07 reconciliation, so this should pass. If a future Defuddle bump ever breaks it, **stop**: capture the diff and switch the rendered path to the in-page converter (`window.Defuddle.createMarkdownContent(content, url)`, now exposed by the 0.18.1 bundle) rather than pinning back to an old version.

- [ ] **Step 3: Write the opt-in smoke test**

Create `test/render.smoke.test.mjs`. Skipped unless `RENDER_SMOKE=1` AND the gateway Chrome is up — proves the full live path end-to-end without hitting the network (a `data:` page).

```js
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
```

- [ ] **Step 4: Verify the suite is green and the smoke test is skipped by default**

Run: `npx vitest run`
Expected: PASS, including `extract.equivalence`; `render.smoke` reported as skipped (no `RENDER_SMOKE`).

- [ ] **Step 5 (optional, requires the gateway up): run the live smoke**

Run (PowerShell): `$env:RENDER_SMOKE=1; npx vitest run test/render.smoke.test.mjs; Remove-Item Env:RENDER_SMOKE`
Expected: PASS. If it errors with a connection failure, start the gateway (`C:\Users\juliu\cbg-up.ps1`) and retry. Recommended before wiring Task 4.

- [ ] **Step 6: Commit**

```bash
git add src/render.mjs test/render.smoke.test.mjs test/extract.equivalence.test.mjs
git commit -m "feat(render): CDP render, image capture, EN+DE consent, in-page Defuddle"
```

---

## Task 4: Wire rendering into `import.mjs`

Rewires the per-bookmark core: render → pick-the-better-vs-fetch → harvest images → write. Adds flags, dry-run rendering (capped to limit), attachment seeding, stderr progress, and a render/image summary. Correctness rests on the existing suite staying green, the unit-tested `shell.mjs`/`images.mjs`, and the Task 6 manual dry-run.

**Files:**
- Modify: `import.mjs`

- [ ] **Step 1: Add the new imports**

Below `import { buildReport } from './src/report.mjs';` (line 25), add:

```js
import { connectBrowser, renderPage } from './src/render.mjs';
import { downloadImages } from './src/images.mjs';
import { looksLikeShell } from './src/shell.mjs';
```

- [ ] **Step 2: Add the new option defaults**

In `parseArgs`, extend the `opts` literal (after `concurrency: 4,`):

```js
    render: true,
    cdpUrl: 'http://localhost:9222',
    renderConcurrency: 3,
    dismissConsent: true,
```

- [ ] **Step 3: Add the new flag cases**

In the `switch (a)` of `parseArgs`, before `case '-h':`:

```js
      case '--no-render': opts.render = false; break;
      case '--cdp-url': opts.cdpUrl = next(); break;
      case '--render-concurrency': opts.renderConcurrency = Math.max(1, Number(next())); break;
      case '--no-dismiss-consent': opts.dismissConsent = false; break;
```

- [ ] **Step 4: Document the flags in the HELP string**

In `HELP`, inside `Options:` (after the `--concurrency` line):

```
  --no-render            Skip Chrome rendering; use the raw-fetch path only.
  --cdp-url <url>        Chrome CDP endpoint for rendering (default: http://localhost:9222).
  --render-concurrency <N>  Parallel render tabs (default: 3).
  --no-dismiss-consent   Do not auto-click cookie/consent accept buttons (default: on).
```

- [ ] **Step 5: Compute attachments dir, apply the dry-run render cap, connect the browser, seed attachment names**

In `main`, just after `const inboxAbs = join(vaultAbs, opts.inbox);` (line 120), add:

```js
  const attachDir = join(inboxAbs, '_attachments');
```

A bare `--dry-run` (no explicit `--limit`) renders, so cap it to 10 to avoid rendering all ~200 just for a preview. Replace the `const within = toProcess.slice(0, opts.limit);` line (and reuse the same value for the over-limit reporting) with:

```js
  // Dry-run renders for an honest preview; without an explicit --limit, cap it.
  const effectiveLimit = (opts.dryRun && !Number.isFinite(opts.limit)) ? 10 : opts.limit;
  const within = toProcess.slice(0, effectiveLimit);
  for (const { bm, slot } of toProcess.slice(effectiveLimit)) {
    outcomes[slot] = { url: bm.url, title: bm.title, status: 'skipped-limit', reason: `beyond --limit ${effectiveLimit}` };
  }
```

(Delete the original `within`/over-limit block at lines 180-183 it replaces.)

After the `await mkdir(inboxAbs, …)` guard — and noting dry-run now DOES render — connect the browser and seed attachment names from disk so cross-run names never collide:

```js
  // Connect to the gateway Chrome for rendering. Failure → whole run uses fetch.
  let browser = null;
  if (opts.render && within.length) {
    try {
      browser = await connectBrowser(opts.cdpUrl);
    } catch (e) {
      process.stderr.write(`render disabled: cannot connect to ${opts.cdpUrl} (${e.message})\n`);
    }
  }

  // Seed attachment names from the existing _attachments/ so a later run never
  // overwrites a prior note's image when two articles share a sanitized title.
  const attachTaken = new Set();
  if (!opts.dryRun) {
    try { for (const n of await readdir(attachDir)) attachTaken.add(n); } catch { /* none yet */ }
  }
```

> Note: the `await mkdir(inboxAbs, …)` guard currently requires `!opts.dryRun`. Leave that as-is (dry-run writes nothing) — rendering does not need the inbox dir.

- [ ] **Step 6: Replace the per-bookmark worker body**

Replace the entire `await mapPool(within, opts.concurrency, async ({ bm, norm, slot }) => { … });` block (lines 188-236) with the version below. It renders, decides whether the render is good, otherwise also fetches and picks the better, harvests captured images, and records the path taken.

```js
  const poolSize = browser ? opts.renderConcurrency : opts.concurrency;
  let done = 0;

  await mapPool(within, poolSize, async ({ bm, norm, slot }) => {
    let host = '';
    try { host = new URL(bm.url).host; } catch { /* keep '' */ }

    // --- 1. Render candidate (markdown + rendered-DOM metadata + captured bytes). ---
    let rendered = null;   // { markdown, wordCount, meta, images, shell }
    if (browser) {
      const r = await renderPage(browser, bm.url, {
        navTimeoutMs: 25000,
        dismissConsent: opts.dismissConsent,
      });
      if (r.status === 'ok') {
        const ex = await extractFromHtml(r.content, bm.url, { minWords: opts.minWords });
        const md = ex.content || '';
        rendered = {
          markdown: md,
          wordCount: ex.wordCount || 0,
          meta: r,                 // rendered-DOM metadata (richer than the fragment re-parse)
          images: r.images,        // Map<url,{bytes,contentType}> from the live page
          shell: looksLikeShell(md, { minWords: opts.minWords }),
        };
      }
      // render-failed → rendered stays null → fetch below.
    }

    const renderGood = rendered && rendered.wordCount >= opts.minWords && !rendered.shell;

    // --- 2. Fetch candidate, only when the render isn't already good. ---
    let fetched = null;       // { markdown, wordCount, meta, shell }
    let fetchOutcome = null;  // terminal fetch status when there is no usable body
    if (!renderGood) {
      const f = await fetchPage(bm.url, { timeoutMs: 20000 });
      if (f.status === 'ok') {
        const ex = await extractFromHtml(f.html, bm.url, { minWords: opts.minWords });
        const md = ex.content || '';
        fetched = {
          markdown: md,
          wordCount: ex.wordCount || 0,
          meta: ex.meta,
          shell: looksLikeShell(md, { minWords: opts.minWords }),
        };
      } else {
        fetchOutcome = f; // { status: 'failed' | 'skipped-binary', reason }
      }
    }

    // --- 3. Pick the better: disqualify shell/thin, longest wins, render breaks ties. ---
    const candidates = [];
    if (rendered) candidates.push({ ...rendered, path: 'rendered' });
    if (fetched) candidates.push({ ...fetched, path: 'fetched-fallback' });
    const qualified = candidates.filter((c) => c.wordCount >= opts.minWords && !c.shell);
    qualified.sort((a, b) => (b.wordCount - a.wordCount) || (a.path === 'rendered' ? -1 : 1));
    const winner = qualified[0] || null;

    if (!winner) {
      // Nothing usable. Prefer a terminal fetch status (failed/binary) when we have
      // one; otherwise report thin against whichever candidate we did get.
      done += 1;
      if (fetchOutcome && fetchOutcome.status === 'failed') {
        outcomes[slot] = { url: bm.url, title: bm.title, status: 'failed', reason: fetchOutcome.reason, path: 'fetched-fallback' };
        manifest[norm] = { bookmarkId: bm.id, status: 'failed', reason: fetchOutcome.reason, at: created };
        process.stderr.write(`[${done}/${within.length}] failed  ${bm.title || host}\n`);
        return;
      }
      if (fetchOutcome && fetchOutcome.status === 'skipped-binary') {
        outcomes[slot] = { url: bm.url, title: bm.title, status: 'skipped-binary', reason: fetchOutcome.reason, path: 'fetched-fallback' };
        manifest[norm] = { bookmarkId: bm.id, status: 'skipped-binary', reason: fetchOutcome.reason, at: created };
        process.stderr.write(`[${done}/${within.length}] binary  ${bm.title || host}\n`);
        return;
      }
      const wc = (rendered && rendered.wordCount) || (fetched && fetched.wordCount) || 0;
      const reason = `wordCount ${wc} < ${opts.minWords}` + ((rendered && rendered.shell) || (fetched && fetched.shell) ? ' (shell)' : '');
      const path = rendered ? 'rendered' : 'fetched-fallback';
      outcomes[slot] = { url: bm.url, title: bm.title, status: 'skipped-thin', reason, path };
      manifest[norm] = { bookmarkId: bm.id, status: 'skipped-thin', reason, at: created };
      process.stderr.write(`[${done}/${within.length}] thin    ${bm.title || host}\n`);
      return;
    }

    let markdown = winner.markdown;
    const wordCount = winner.wordCount;
    const metaSource = winner.meta;
    const pathTaken = winner.path;
    const capturedBytes = winner.path === 'rendered' ? winner.images : new Map();

    // --- 4. Title + filename (disambiguated against existing notes). ---
    const title = (metaSource && metaSource.title) || bm.title || host || 'untitled';
    const base = sanitizeFilename(title);
    const filename = uniqueFilename(base, '.md', (n) => existingNames.has(n));
    existingNames.add(filename);

    // --- 5. Harvest images (real runs only). Slug = disambiguated filename so the
    //        attachment names trace to THIS note and never collide cross-run. ---
    let images = { downloaded: 0, remote: 0, dropped: 0 };
    if (!opts.dryRun) {
      images = await downloadImages(markdown, {
        baseUrl: bm.url,
        slug: filename.replace(/\.md$/i, ''),
        attachDir,
        capturedBytes,
        takenNames: attachTaken,
      });
      markdown = images.markdown;
    }

    // --- 6. Assemble + write the note. ---
    const body = buildFrontmatter({
      title,
      source: bm.url,
      authors: splitAuthors(metaSource && metaSource.author),
      published: normalizeDate(metaSource && metaSource.published),
      description: (metaSource && metaSource.description) || '',
      created,
    }) + `\n${markdown}\n`;

    if (!opts.dryRun) await writeNoteFile(join(inboxAbs, filename), body);

    done += 1;
    outcomes[slot] = {
      url: bm.url,
      title,
      status: 'imported',
      file: filename,
      wordCount,
      path: pathTaken,
      images: { downloaded: images.downloaded, remote: images.remote, dropped: images.dropped },
      dryRun: opts.dryRun || undefined,
    };
    manifest[norm] = { bookmarkId: bm.id, status: 'imported', file: filename, at: created };
    process.stderr.write(`[${done}/${within.length}] ${pathTaken === 'rendered' ? 'render ' : 'fetch  '} ${title}\n`);
  });
```

- [ ] **Step 7: Disconnect the browser after the pool finishes**

Immediately after the `await mapPool(...)` call, add:

```js
  if (browser) { try { await browser.disconnect(); } catch { /* ignore */ } }
```

`disconnect()` (never `close()`) leaves the gateway's Chrome running.

- [ ] **Step 8: Add a render/image summary to the report meta**

In the `report.meta = { … }` object, after `retryFailed: opts.retryFailed,`:

```js
    render: {
      enabled: Boolean(browser),
      rendered: outcomes.filter((o) => o && o.path === 'rendered').length,
      fetchedFallback: outcomes.filter((o) => o && o.path === 'fetched-fallback').length,
      imagesDownloaded: outcomes.reduce((n, o) => n + ((o && o.images && o.images.downloaded) || 0), 0),
      imagesRemote: outcomes.reduce((n, o) => n + ((o && o.images && o.images.remote) || 0), 0),
    },
```

- [ ] **Step 9: Run the full test suite (must stay green)**

Run: `npx vitest run`
Expected: PASS — existing `extract`, `frontmatter`, `gateway`, `note`, `report`, `url` tests plus new `shell`, `images`, `extract.equivalence`; `render.smoke` skipped.

- [ ] **Step 10: Syntax/smoke-check the CLI help**

Run: `node import.mjs --help`
Expected: prints help including the four new flags (`--no-render`, `--cdp-url`, `--render-concurrency`, `--no-dismiss-consent`); exits 0.

- [ ] **Step 11: Commit**

```bash
git add import.mjs
git commit -m "feat(import): render+pick-better+fetch fallback, harvest images, progress, report"
```

---

## Task 5: Documentation

**Files:**
- Modify: `SKILL.md`
- Modify: `README.md`

- [ ] **Step 1: Update `SKILL.md` Overview**

Replace the Overview paragraph (lines 8-14) with:

```markdown
## Overview

On-demand importer. Reads a Chrome bookmark folder via the local
`chrome-bookmarks-gateway`, **renders each new article in the gateway's Chrome
over CDP** and runs Defuddle in the live page (the Obsidian Web Clipper's own
engine + technique), **harvests the images the page already loaded**, and writes
Web-Clipper-quality notes into a vault inbox. For each page it renders *and*, when
the render looks thin or like a cookie/paywall shell, also raw-fetches and keeps
the better of the two — so it never does worse than before. The work is a
deterministic Node CLI; this skill is the thin operator that health-checks, runs
it, and summarizes the JSON report.
```

- [ ] **Step 2: Document rendering + images + flags in `SKILL.md`**

After the `## Defaults (this machine)` list (~line 26), insert:

```markdown
## Rendering & images

- Rendering uses the **same dedicated Chrome the gateway already runs** (CDP on
  `http://localhost:9222`) — no extra browser. Each article is opened in a fresh
  tab, consent banners are dismissed (EN+DE, precision-targeted), the page is
  rendered and extracted with in-page Defuddle, and the tab is closed. The
  gateway's Chrome is left running (connect/disconnect only).
- **Pick-the-better:** if the render is missing, below `--min-words`, or looks
  like a consent/paywall/JS shell, the importer also raw-fetches and keeps the
  better extraction. Each `imported` item reports `path`: `rendered` or
  `fetched-fallback`.
- **Images** are harvested from the render's own network responses (authenticated,
  defeats hotlink/cookie/CORS); anything not captured is node-fetched, and
  anything still unreachable keeps its remote URL (counted as `imagesRemote`).
  They are saved to `Clippings/_attachments/` and referenced as Obsidian embeds
  (`![[name]]`) so links survive when you move notes into `Articles/…`. Tracking
  pixels (< 33px) are dropped.
- A full backfill renders ~3 pages at a time; budget roughly **15–30 minutes for
  ~200 links** (slower than the old fetch-only path). Per-item progress is printed
  to **stderr**. `--dry-run` **does** render (capped to `--limit`, or 10 if no
  limit) for an honest preview, but writes no notes and downloads no images — so
  dry-run notes still show remote image URLs; do a small throwaway-inbox import to
  verify the downloaded-image experience.
```

- [ ] **Step 3: Update the `## Flags` list in `SKILL.md`**

Replace the Flags paragraph (lines 56-59) with:

```markdown
`--vault`, `--folder`, `--inbox`, `--dry-run`, `--limit N`, `--retry-failed`,
`--min-words N`, `--concurrency N`, `--rpc-url`, `--gateway`, `--no-render`,
`--cdp-url`, `--render-concurrency N`, `--no-dismiss-consent`. Run the CLI with
`--help` for the full list.
```

- [ ] **Step 4: Add a report-status note in `SKILL.md`**

In `## Report statuses`, after the table, add:

```markdown
Each `imported` item also reports `path` (`rendered` or `fetched-fallback`) and an
`images` count (`downloaded` / `remote` / `dropped`). The report `meta.render`
block summarizes how many were rendered vs. fell back, and total images
downloaded vs. left remote — surface this in your summary (e.g. "42 imported
(40 rendered, 2 fetch-fallback), 130 images saved, 4 left remote").
```

- [ ] **Step 5: Mirror the changes into `README.md`**

Replace the description (lines 3-4):

```markdown
Self-contained Claude Code skill that imports Chrome bookmarks into an Obsidian
vault as Web-Clipper-quality markdown notes. It renders each page in the gateway's
Chrome (CDP), runs Defuddle in the live DOM, and harvests the images the page
loaded into the vault — also raw-fetching and keeping the better extraction when a
render looks thin or like a consent/paywall shell.
```

Replace the Setup requirements paragraph (lines 16-19):

```markdown
Requires Node 20+ and the local `chrome-bookmarks-gateway` running on
`http://localhost:3000` (its dedicated Chrome, with CDP on `http://localhost:9222`,
doubles as the rendering engine). Dependencies: `defuddle` (extraction; bundles
`linkedom` for node-side parsing), `puppeteer-core` (CDP render + image capture,
connect-only — no bundled browser), and `image-size` (tracking-pixel filtering).
If `node_modules/` is missing (e.g.
after copying the skill to a new machine), re-run `npm install` from this directory.
```

- [ ] **Step 6: Commit**

```bash
git add SKILL.md README.md
git commit -m "docs: document CDP rendering, image capture, pick-the-better, new flags"
```

---

## Task 6: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Confirm the gateway is up**

Run: `curl -sS http://localhost:3000/syncz`
Expected: `{"ok":true}`. If not, run `C:\Users\juliu\cbg-up.ps1` and re-check.

- [ ] **Step 2: Render-path smoke (live)**

Run (PowerShell): `$env:RENDER_SMOKE=1; npx vitest run test/render.smoke.test.mjs; Remove-Item Env:RENDER_SMOKE`
Expected: PASS — confirms CDP connect + image-capture + in-page Defuddle work against this machine's Chrome.

- [ ] **Step 3: Small real import into a throwaway inbox**

Run:
```
node import.mjs --vault "C:\Users\juliu\Documents\AIEngineeringArticles" --folder "Mobile Lesezeichen/AI" --inbox "Clippings/_rendertest" --limit 3
```
Expected: per-item progress on stderr; JSON report on stdout with `meta.render.enabled: true`, most items `path: "rendered"`, non-zero `imagesDownloaded`, and a small/zero `imagesRemote`.

- [ ] **Step 4: Eyeball the output quality**

Open the 3 notes under `Clippings/_rendertest/` and the `_attachments/` folder. Verify against the original complaints:
- body is complete (not a consent-wall/JS shell),
- images are local `![[…]]` embeds that resolve in Obsidian (no broken/placeholder images, no leftover tracking pixels),
- formatting (code, lists, quotes) reads cleanly; compare one note to the same URL clipped by the real Web Clipper if you have it.

- [ ] **Step 5: Verify the fallback ladder (rendering off)**

Run the same import with `--no-render` into a second throwaway inbox and confirm `meta.render.enabled: false` and every item `path: "fetched-fallback"` — behaviour-identical to the old tool plus image harvest via node fetch.

- [ ] **Step 6: Clean up the throwaway inboxes**

Run (PowerShell):
```
Remove-Item -Recurse -Force "C:\Users\juliu\Documents\AIEngineeringArticles\Clippings\_rendertest"
```
(and the `--no-render` test inbox).

- [ ] **Step 7: Final full suite**

Run: `npx vitest run`
Expected: PASS, all suites (`render.smoke` skipped). No commit needed — verification only.

---

## Self-review notes (for the implementer)

- **Fallback guarantee:** if Chrome/CDP is down, `connectBrowser` fails, `browser` stays `null`, every bookmark takes the fetch path (image bytes via node fetch), and behaviour matches today plus image harvest. Verified by Task 6 Step 5.
- **Pick-the-better guarantee:** a JS-injected consent/subscribe overlay that the render captures is disqualified by `looksLikeShell` and loses to the raw fetch (or is reported `skipped-thin (shell)` if both are shells) — it is never silently saved as a successful `rendered` note.
- **Never kill the gateway Chrome:** only `browser.disconnect()` is used, never `browser.close()`, and only fresh tabs are opened/closed. Grep the diff for `.close()` and confirm it appears only on `page`, never on `browser`.
- **Cross-run image safety:** `attachTaken` is seeded from the existing `_attachments/` listing and the slug is the disambiguated note filename, so a second run importing a different article with the same title writes `Title-01 (2).png` instead of overwriting `Title-01.png`.
- **Image capture correctness:** `setCacheEnabled(false)` ensures real response bodies; the post-autoscroll settle waits for lazy-image responses before the tab closes, so below-the-fold images are captured rather than missed.
- **Idempotency:** the manifest + vault scan still skip already-imported URLs before any render, so re-runs don't re-render or re-download. `--retry-failed` re-renders failed/thin entries.
- **Known limitation (deferred):** the manifest is written once at the end of the run, so an interruption mid-backfill loses `failed`/`skipped-thin` provenance (imported notes survive via the vault scan and are not re-done). Manifest checkpointing is out of scope for v1.
- **Handled by the engine now (was a v1 deviation):** shadow-DOM flattening and `<noscript>`/URL resolution happen inside Defuddle 0.18.1's `parse()` — no manual step. The captured `image`/og:image cover is still intentionally not surfaced to frontmatter (and 0.18.1's `_removeCoverImage` strips the duplicate hero from the body for us).
- **Double-parse guard:** `test/extract.equivalence.test.mjs` pins that re-parsing cleaned HTML equals direct conversion; if it ever fails on a Defuddle bump, the rendered path's markdown has diverged from the tested converter — fix before shipping.
```
