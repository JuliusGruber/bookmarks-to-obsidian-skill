import { describe, it, expect } from 'vitest';
import { findFolder, collectBookmarks } from '../scripts/src/gateway.mjs';

// Mirrors the real getTree shape: a single root whose children are the
// top-level folders. Two "AI" folders exist (one on the bar, one under
// Mobile bookmarks) to exercise ambiguity handling.
const roots = [
  {
    id: '0',
    children: [
      {
        id: '1',
        title: 'Lesezeichenleiste',
        children: [{ id: '11', title: 'AI', children: [{ id: '111', title: 'Bar link', url: 'https://bar.example/x' }] }],
      },
      {
        id: '3',
        title: 'Mobile Lesezeichen',
        children: [
          {
            id: '1268',
            title: 'AI',
            children: [
              { id: 'a', title: 'Article One', url: 'https://one.example/a' },
              { id: 'sub', title: 'Nested', children: [{ id: 'b', title: 'Article Two', url: 'https://two.example/b' }] },
            ],
          },
        ],
      },
    ],
  },
];

describe('findFolder', () => {
  it('resolves an explicit path', () => {
    const node = findFolder(roots, 'Mobile Lesezeichen/AI');
    expect(node.id).toBe('1268');
  });

  it('is case-insensitive on path segments', () => {
    const node = findFolder(roots, 'mobile lesezeichen/ai');
    expect(node.id).toBe('1268');
  });

  it('throws an ambiguity error listing both paths for a bare duplicated name', () => {
    expect(() => findFolder(roots, 'AI')).toThrow(/ambiguous/i);
    try {
      findFolder(roots, 'AI');
    } catch (e) {
      expect(e.message).toContain('Mobile Lesezeichen/AI');
      expect(e.message).toContain('Lesezeichenleiste/AI');
    }
  });

  it('resolves a unique bare name', () => {
    const node = findFolder(roots, 'Mobile Lesezeichen');
    expect(node.id).toBe('3');
  });

  it('throws when the folder does not exist', () => {
    expect(() => findFolder(roots, 'Does Not Exist')).toThrow(/not found/i);
  });
});

describe('collectBookmarks', () => {
  it('flattens every bookmark in the subtree, including nested folders', () => {
    const folder = findFolder(roots, 'Mobile Lesezeichen/AI');
    const marks = collectBookmarks(folder);
    expect(marks).toEqual([
      { id: 'a', title: 'Article One', url: 'https://one.example/a' },
      { id: 'b', title: 'Article Two', url: 'https://two.example/b' },
    ]);
  });
});
