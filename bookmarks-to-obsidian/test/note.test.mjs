import { describe, it, expect } from 'vitest';
import { sanitizeFilename, uniqueFilename } from '../scripts/src/note.mjs';

describe('sanitizeFilename', () => {
  it('replaces Windows-illegal characters and collapses whitespace', () => {
    expect(sanitizeFilename('A/B: C? "D" <E>|F')).toBe('A B C D E F');
  });
  it('trims trailing dots and spaces (illegal on Windows)', () => {
    expect(sanitizeFilename('Hello world. ')).toBe('Hello world');
  });
  it('caps length at the configured maximum', () => {
    const long = 'x'.repeat(300);
    expect(sanitizeFilename(long, { maxLen: 150 }).length).toBe(150);
  });
  it('falls back to "untitled" for empty or all-illegal input', () => {
    expect(sanitizeFilename('')).toBe('untitled');
    expect(sanitizeFilename('   ')).toBe('untitled');
    expect(sanitizeFilename('////')).toBe('untitled');
  });
  it('guards Windows reserved device names', () => {
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('nul')).toBe('_nul');
  });
});

describe('uniqueFilename', () => {
  it('returns the base name when nothing collides', () => {
    expect(uniqueFilename('Title', '.md', () => false)).toBe('Title.md');
  });
  it('appends (2) on the first collision', () => {
    const taken = new Set(['Title.md']);
    expect(uniqueFilename('Title', '.md', (n) => taken.has(n))).toBe('Title (2).md');
  });
  it('keeps counting up past multiple collisions', () => {
    const taken = new Set(['Title.md', 'Title (2).md', 'Title (3).md']);
    expect(uniqueFilename('Title', '.md', (n) => taken.has(n))).toBe('Title (4).md');
  });
});
