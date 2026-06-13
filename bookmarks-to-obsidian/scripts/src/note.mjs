// Filename sanitization, collision-safe naming, and note writing.
import { writeFile } from 'node:fs/promises';

const ILLEGAL = /[\\/:*?"<>|]/g;
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Turn an article title into a safe Windows/Obsidian filename base (no
 * extension): strip illegal chars, collapse whitespace, trim trailing dots and
 * spaces, cap length, and guard reserved device names. Falls back to "untitled".
 */
export function sanitizeFilename(title, { maxLen = 150 } = {}) {
  let name = String(title ?? '')
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[ .]+$/, '');
  if (name.length > maxLen) {
    name = name.slice(0, maxLen).trim().replace(/[ .]+$/, '');
  }
  if (!name) return 'untitled';
  if (RESERVED.has(name.toLowerCase())) name = `_${name}`;
  return name;
}

/**
 * Return the first non-colliding filename: base.ext, then "base (2).ext", etc.
 * `exists(name)` reports whether a candidate is already taken.
 */
export function uniqueFilename(base, ext, exists) {
  if (!exists(`${base}${ext}`)) return `${base}${ext}`;
  let n = 2;
  while (exists(`${base} (${n})${ext}`)) n += 1;
  return `${base} (${n})${ext}`;
}

export async function writeNoteFile(fullPath, body) {
  await writeFile(fullPath, body, 'utf8');
}
