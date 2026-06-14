import { describe, it, expect } from 'vitest';
import {
  buildListPayload,
  partitionIds,
  buildDeclineEntries,
  clearDeclined,
} from '../bookmarks-to-obsidian/scripts/src/classify.mjs';

describe('buildListPayload', () => {
  it('shapes { mode, meta.counts, new[] } from a classification', () => {
    const classification = {
      newItems: [{ id: '5', title: 'T', url: 'https://x.com/a', domain: 'x.com', norm: 'https://x.com/a', slot: 2 }],
      existingCount: 7,
      declinedCount: 3,
    };
    const payload = buildListPayload(classification, {
      folder: 'AI',
      folderSpec: 'Mobile Lesezeichen/AI',
      vault: 'C:/V',
      inbox: 'Clippings',
      generatedAt: '2026-06-13',
    });
    expect(payload.mode).toBe('list');
    expect(payload.meta).toEqual({
      folder: 'AI',
      folderSpec: 'Mobile Lesezeichen/AI',
      vault: 'C:/V',
      inbox: 'Clippings',
      counts: { new: 1, existing: 7, declined: 3 },
      generatedAt: '2026-06-13',
    });
    // new[] carries only id/title/url/domain — internal norm/slot are stripped.
    expect(payload.new).toEqual([{ id: '5', title: 'T', url: 'https://x.com/a', domain: 'x.com' }]);
  });
});

describe('partitionIds', () => {
  it('returns the two sets unchanged when disjoint', () => {
    const { importSet, declineSet } = partitionIds(['1', '2'], ['3', '4']);
    expect([...importSet]).toEqual(['1', '2']);
    expect([...declineSet]).toEqual(['3', '4']);
  });

  it('lets import win over decline for an overlapping id', () => {
    const { importSet, declineSet } = partitionIds(['1', '2'], ['2', '3']);
    expect(importSet.has('2')).toBe(true);
    expect(declineSet.has('2')).toBe(false);
    expect([...declineSet]).toEqual(['3']);
  });

  it('tolerates null/empty inputs', () => {
    const { importSet, declineSet } = partitionIds(null, null);
    expect(importSet.size).toBe(0);
    expect(declineSet.size).toBe(0);
  });
});

describe('buildDeclineEntries', () => {
  const bookmarks = [
    { id: '1', url: 'https://example.com/a?utm_source=z', title: 'A' },
    { id: '2', url: 'https://example.com/b', title: 'B' },
  ];

  it('writes a declined record keyed by the normalized URL', () => {
    const { entries, declined, unknownIds } = buildDeclineEntries(['1'], bookmarks, '2026-06-13');
    expect(entries).toEqual({
      'https://example.com/a': { bookmarkId: '1', status: 'declined', at: '2026-06-13' },
    });
    expect(declined).toBe(1);
    expect(unknownIds).toEqual([]);
  });

  it('collects unknown ids (deleted since --list) without throwing', () => {
    const { entries, declined, unknownIds } = buildDeclineEntries(['99'], bookmarks, '2026-06-13');
    expect(entries).toEqual({});
    expect(declined).toBe(0);
    expect(unknownIds).toEqual(['99']);
  });
});

describe('clearDeclined', () => {
  it('removes only declined entries and reports the count', () => {
    const manifest = {
      'https://a': { status: 'declined', at: '2026-06-13' },
      'https://b': { status: 'imported', file: 'B.md' },
      'https://c': { status: 'declined', at: '2026-06-13' },
    };
    const { cleared } = clearDeclined(manifest);
    expect(cleared).toBe(2);
    expect(Object.keys(manifest)).toEqual(['https://b']);
  });

  it('reports 0 when there is nothing to clear', () => {
    const manifest = { 'https://b': { status: 'imported' } };
    expect(clearDeclined(manifest).cleared).toBe(0);
  });
});
