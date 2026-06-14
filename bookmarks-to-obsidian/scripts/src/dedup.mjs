// Dedup layer: URL normalization, vault source scan, and the import manifest.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createContentIndex } from './content-index.mjs';
import { fingerprint } from './fingerprint.mjs';

// Tracking params we strip so the same article reached via different shares dedupes.
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid',
  'mc_eid', 'mc_cid', 'igshid', 'ref', 'ref_src', 'ref_url',
  '_hsenc', '_hsmi', 'vero_id', 'vero_conv', 'oly_anon_id', 'oly_enc_id',
  'spm', 'scm', 'cmpid', 'campaign_id',
]);

function isTracking(key) {
  const k = key.toLowerCase();
  return k.startsWith('utm_') || TRACKING_PARAMS.has(k);
}

/**
 * Normalize a URL for dedup: lowercase host, drop the fragment and tracking
 * params, sort remaining params, strip a trailing slash. Path case is preserved
 * (paths are case-sensitive). Unparseable input is returned trimmed, unchanged.
 */
export function normalizeUrl(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed;
  }
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';

  const keep = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (!isTracking(k)) keep.push([k, v]);
  }
  keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const sp = new URLSearchParams();
  for (const [k, v] of keep) sp.append(k, v);
  const search = sp.toString();

  let path = u.pathname;
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '/') path = '';

  return `${u.protocol}//${u.host}${path}${search ? `?${search}` : ''}`;
}

const SKIP_DIRS = new Set(['.git', '.obsidian', 'node_modules', '.trash']);

/**
 * Walk every .md in the vault. Always collect normalized `source:` URLs. When
 * `content` is true (default) also fingerprint each note's title+body into a
 * content index — the live scan is the source of truth: it sees hand-added and
 * moved notes the manifest never recorded. Returns { urls:Set, content:contentIndex }.
 */
export async function scanVault(vaultPath, { content: buildContent = true } = {}) {
  const urls = new Set();
  const content = createContentIndex();
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full);
        continue;
      }
      if (!(e.isFile() && e.name.toLowerCase().endsWith('.md'))) continue;

      if (!buildContent) {
        const src = await readSourceField(full);
        if (src) urls.add(normalizeUrl(src));
        continue;
      }
      const fields = await readNoteFields(full);
      if (!fields) continue;
      if (fields.source) urls.add(normalizeUrl(fields.source));
      const base = e.name.replace(/\.md$/i, '');
      const fp = fingerprint(fields.title || base, fields.body);
      content.add({ file: e.name, titleKey: fp.titleKey, bodyHash: fp.bodyHash, simhash: fp.simhash });
    }
  }
  await walk(vaultPath);
  return { urls, content };
}

/** Read just the frontmatter `source:` (used on the no-content-dedup fast path). */
async function readSourceField(file) {
  const fields = await readNoteFields(file);
  return fields ? fields.source : null;
}

/** Parse a note's frontmatter `source:`/`title:` and the body after it. */
async function readNoteFields(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  if (!text.startsWith('---')) return { source: null, title: null, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { source: null, title: null, body: text };
  const fm = text.slice(3, end);
  const sm = fm.match(/^source:\s*["']?([^"'\n]+)["']?\s*$/m);
  const tm = fm.match(/^title:\s*["']?(.*?)["']?\s*$/m);
  const nl = text.indexOf('\n', end + 1); // newline ending the closing '---' line
  return {
    source: sm ? sm[1].trim() : null,
    title: tm ? tm[1].trim() : null,
    body: nl === -1 ? '' : text.slice(nl + 1),
  };
}

/** Read the import manifest ({ normalizedUrl: { ... } }); missing/corrupt -> {}. */
export async function readManifest(path) {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export async function writeManifest(path, data) {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
