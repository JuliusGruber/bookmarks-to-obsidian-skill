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
