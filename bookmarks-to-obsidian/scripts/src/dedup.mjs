// Dedup layer: URL normalization, vault source scan, and the import manifest.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

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

/** Walk every .md in the vault and collect the normalized `source:` URLs. */
export async function scanVaultSources(vaultPath) {
  const set = new Set();
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
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        const src = await readSourceField(full);
        if (src) set.add(normalizeUrl(src));
      }
    }
  }
  await walk(vaultPath);
  return set;
}

async function readSourceField(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const fm = text.slice(3, end);
  const m = fm.match(/^source:\s*["']?([^"'\n]+)["']?\s*$/m);
  return m ? m[1].trim() : null;
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
