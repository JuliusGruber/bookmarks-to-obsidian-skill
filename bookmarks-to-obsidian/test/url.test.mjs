import { describe, it, expect } from 'vitest';
import { normalizeUrl } from '../scripts/src/dedup.mjs';

describe('normalizeUrl', () => {
  it('lowercases the host but preserves path case', () => {
    expect(normalizeUrl('https://Example.COM/My/Path')).toBe('https://example.com/My/Path');
  });

  it('drops the fragment', () => {
    expect(normalizeUrl('https://example.com/a#section-2')).toBe('https://example.com/a');
  });

  it('strips a trailing slash', () => {
    expect(normalizeUrl('https://example.com/a/')).toBe('https://example.com/a');
  });

  it('normalizes a bare host and a root slash to the same value', () => {
    expect(normalizeUrl('https://example.com/')).toBe(normalizeUrl('https://example.com'));
  });

  it('drops utm_* and other tracking params but keeps meaningful ones', () => {
    expect(
      normalizeUrl('https://example.com/post?utm_source=x&utm_medium=y&id=5&fbclid=abc&gclid=def'),
    ).toBe('https://example.com/post?id=5');
  });

  it('is order-independent for the remaining query params', () => {
    expect(normalizeUrl('https://example.com/p?b=2&a=1')).toBe(
      normalizeUrl('https://example.com/p?a=1&b=2'),
    );
  });

  it('dedupes the same article reached with different tracking junk', () => {
    const a = normalizeUrl('https://Example.com/Article/?utm_source=twitter');
    const b = normalizeUrl('https://example.com/Article#comments');
    expect(a).toBe(b);
  });

  it('returns a stable fallback for an unparseable url instead of throwing', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
  });
});
