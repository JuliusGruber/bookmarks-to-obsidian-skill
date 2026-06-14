// Bookmark classification + id-scoped selection helpers. Pure: no IO. The
// definition of a "new" bookmark (not in the vault, not remembered, not declined)
// lives here, so --list and the import engine agree by construction.
import { normalizeUrl } from './dedup.mjs';

/** Best-effort URL host; '' when the URL won't parse. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * Split a folder's bookmarks into genuinely-new vs already-decided.
 *
 *   bookmarks:   [{ id, title, url }]  (from collectBookmarks)
 *   vaultSet:    Set of normalized URLs already present in the vault
 *   manifest:    { normUrl: { status, file?, duplicateOf?, ... } }
 *   retryFailed: re-include manifest `failed`/`skipped-thin` as new (never `declined`)
 *
 * Returns:
 *   newItems:      [{ id, title, url, domain, norm, slot }]  — to render/select
 *   decided:       [{ id, slot, url, title, status, reason, file?, duplicateOf? }]
 *   existingCount: decided.length (already handled: in vault, dup-in-run, or remembered)
 *   declinedCount: bookmarks whose manifest entry is `declined`
 *
 * Every bookmark lands in exactly one of newItems / decided / declined, so
 * newItems.length + decided.length + declinedCount === bookmarks.length.
 */
export function classifyBookmarks(bookmarks, { vaultSet, manifest, retryFailed = false } = {}) {
  const newItems = [];
  const decided = [];
  let declinedCount = 0;
  const seen = new Set();

  bookmarks.forEach((bm, slot) => {
    const norm = normalizeUrl(bm.url);

    if (seen.has(norm)) {
      decided.push({ id: bm.id, slot, url: bm.url, title: bm.title, status: 'skipped-existing', reason: 'duplicate in run' });
      return;
    }
    seen.add(norm);

    if (vaultSet.has(norm)) {
      decided.push({ id: bm.id, slot, url: bm.url, title: bm.title, status: 'skipped-existing', reason: 'already in vault' });
      return;
    }

    const m = manifest[norm];
    if (m && m.status === 'declined') {
      declinedCount += 1;
      return; // hidden: neither new nor existing
    }
    const retryable = m && (m.status === 'failed' || m.status === 'skipped-thin');
    if (m && !(retryFailed && retryable)) {
      const status = m.status === 'imported' ? 'skipped-existing' : m.status;
      decided.push({ id: bm.id, slot, url: bm.url, title: bm.title, status, reason: 'remembered', file: m.file, duplicateOf: m.duplicateOf });
      return;
    }

    newItems.push({ id: bm.id, title: bm.title, url: bm.url, domain: hostOf(bm.url), norm, slot });
  });

  return { newItems, decided, existingCount: decided.length, declinedCount };
}

/**
 * Shape the read-only --list output: { mode, meta, new }. `new` is bookmark-order
 * and carries only the fields the chat walk needs (id, title, url, domain).
 */
export function buildListPayload(classification, { folder, folderSpec, vault, inbox, generatedAt }) {
  const { newItems, existingCount, declinedCount } = classification;
  return {
    mode: 'list',
    meta: {
      folder,
      folderSpec,
      vault,
      inbox,
      counts: { new: newItems.length, existing: existingCount, declined: declinedCount },
      generatedAt,
    },
    new: newItems.map(({ id, title, url, domain }) => ({ id, title, url, domain })),
  };
}

/**
 * Resolve the import/decline id sets for an id-scoped run. Import wins over
 * decline: an id in both is imported, never declined.
 */
export function partitionIds(importIds, declineIds) {
  const importSet = new Set(importIds || []);
  const declineSet = new Set();
  for (const id of declineIds || []) {
    if (!importSet.has(id)) declineSet.add(id);
  }
  return { importSet, declineSet };
}

/**
 * Build manifest entries for declined ids. Resolves each id to its bookmark,
 * normalizes the URL, and stamps a `declined` record. Unknown ids (deleted since
 * --list) are collected, not fatal.
 *
 * Returns { entries: { normUrl: { bookmarkId, status:'declined', at } }, declined, unknownIds }.
 */
export function buildDeclineEntries(ids, bookmarks, at) {
  const byId = new Map(bookmarks.map((b) => [b.id, b]));
  const entries = {};
  const unknownIds = [];
  let declined = 0;
  for (const id of ids) {
    const bm = byId.get(id);
    if (!bm) {
      unknownIds.push(id);
      continue;
    }
    entries[normalizeUrl(bm.url)] = { bookmarkId: bm.id, status: 'declined', at };
    declined += 1;
  }
  return { entries, declined, unknownIds };
}

/**
 * Remove every `declined` entry from a manifest. Mutates it in place and returns
 * { manifest, cleared } where cleared is the number removed.
 */
export function clearDeclined(manifest) {
  let cleared = 0;
  for (const [k, v] of Object.entries(manifest)) {
    if (v && v.status === 'declined') {
      delete manifest[k];
      cleared += 1;
    }
  }
  return { manifest, cleared };
}
