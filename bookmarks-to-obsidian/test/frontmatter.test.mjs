import { describe, it, expect } from 'vitest';
import { splitAuthors, normalizeDate, buildFrontmatter } from '../scripts/src/frontmatter.mjs';

describe('splitAuthors', () => {
  it('returns a single author unchanged', () => {
    expect(splitAuthors('Jane Doe')).toEqual(['Jane Doe']);
  });
  it('splits on commas', () => {
    expect(splitAuthors('Jane Doe, John Smith')).toEqual(['Jane Doe', 'John Smith']);
  });
  it('splits on " and "', () => {
    expect(splitAuthors('Jane Doe and John Smith')).toEqual(['Jane Doe', 'John Smith']);
  });
  it('splits on ampersands', () => {
    expect(splitAuthors('Jane & John')).toEqual(['Jane', 'John']);
  });
  it('handles a mix of separators', () => {
    expect(splitAuthors('A, B and C')).toEqual(['A', 'B', 'C']);
  });
  it('does not split names that merely contain "and"', () => {
    expect(splitAuthors('Sandra Anderson')).toEqual(['Sandra Anderson']);
  });
  it('returns an empty array for missing/empty input', () => {
    expect(splitAuthors('')).toEqual([]);
    expect(splitAuthors(undefined)).toEqual([]);
  });
});

describe('normalizeDate', () => {
  it('passes through an ISO date', () => {
    expect(normalizeDate('2026-04-02')).toBe('2026-04-02');
  });
  it('trims the time component off an ISO datetime', () => {
    expect(normalizeDate('2026-04-02T10:00:00Z')).toBe('2026-04-02');
  });
  it('normalizes slash-separated dates', () => {
    expect(normalizeDate('2026/04/02')).toBe('2026-04-02');
  });
  it('parses a human-readable date', () => {
    expect(normalizeDate('April 2, 2026')).toBe('2026-04-02');
  });
  it('returns null for unparseable input', () => {
    expect(normalizeDate('not a date')).toBeNull();
    expect(normalizeDate('')).toBeNull();
    expect(normalizeDate(undefined)).toBeNull();
  });
});

describe('buildFrontmatter', () => {
  it('produces a full Web-Clipper-parity block', () => {
    const fm = buildFrontmatter({
      title: 'Harness engineering for coding agent users',
      source: 'https://martinfowler.com/articles/harness-engineering.html',
      authors: ['Birgitta Böckeler'],
      published: '2026-04-02',
      created: '2026-05-17',
      description: 'A mental model for building trust in coding agents.',
    });
    expect(fm).toBe(
      [
        '---',
        'title: "Harness engineering for coding agent users"',
        'source: "https://martinfowler.com/articles/harness-engineering.html"',
        'author:',
        '  - "[[Birgitta Böckeler]]"',
        'published: 2026-04-02',
        'created: 2026-05-17',
        'tags:',
        '  - "clippings"',
        '  - "bookmark-import"',
        'description: "A mental model for building trust in coding agents."',
        '---',
        '',
      ].join('\n'),
    );
  });

  it('omits author, published, and description when absent', () => {
    const fm = buildFrontmatter({
      title: 'Untitled thing',
      source: 'https://example.com/x',
      authors: [],
      published: null,
      created: '2026-06-05',
      description: '',
    });
    expect(fm).not.toContain('author:');
    expect(fm).not.toContain('published:');
    expect(fm).not.toContain('description:');
    expect(fm).toContain('title: "Untitled thing"');
    expect(fm).toContain('created: 2026-06-05');
    expect(fm).toContain('  - "clippings"');
  });

  it('emits one list item per author', () => {
    const fm = buildFrontmatter({
      title: 'Two authors',
      source: 'https://example.com/y',
      authors: ['Jane Doe', 'John Smith'],
      created: '2026-06-05',
    });
    expect(fm).toContain('author:\n  - "[[Jane Doe]]"\n  - "[[John Smith]]"');
  });

  it('escapes embedded double quotes in the title', () => {
    const fm = buildFrontmatter({
      title: 'Say "hi" to agents',
      source: 'https://example.com/z',
      created: '2026-06-05',
    });
    expect(fm).toContain('title: "Say \\"hi\\" to agents"');
  });
});
