import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanVault } from '../bookmarks-to-obsidian/scripts/src/dedup.mjs';
import { fingerprint } from '../bookmarks-to-obsidian/scripts/src/fingerprint.mjs';

let vault;

const NOTE = (source, title, body) =>
  `---\ntitle: ${JSON.stringify(title)}\nsource: ${JSON.stringify(source)}\ncreated: 2026-06-14\n---\n\n${body}\n`;

const BODY = 'Loop engineering keeps an agent on a tight feedback loop toward its goal.';

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'b2o-scan-'));
});
afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

describe('scanVault', () => {
  it('collects normalized source URLs and indexes note content', async () => {
    await writeFile(join(vault, 'Loop Engineering.md'),
      NOTE('https://addyo.substack.com/p/loop-engineering?utm_source=x', 'Loop Engineering', BODY));

    const { urls, content } = await scanVault(vault);
    expect(urls.has('https://addyo.substack.com/p/loop-engineering')).toBe(true);

    // A byte-identical body anywhere else is an exact duplicate of this note.
    const v = content.classify(fingerprint('Anything', BODY));
    expect(v).toMatchObject({ verdict: 'exact', duplicateOf: 'Loop Engineering.md' });
  });

  it('recurses past Clippings into Articles (moved/renamed notes are still seen)', async () => {
    await mkdir(join(vault, 'Articles'), { recursive: true });
    await writeFile(join(vault, 'Articles', 'Moved.md'),
      NOTE('https://example.com/moved', 'Moved Note', BODY));
    const { content } = await scanVault(vault);
    expect(content.classify(fingerprint('x', BODY))).toMatchObject({ verdict: 'exact', duplicateOf: 'Moved.md' });
  });

  it('with { content: false } collects URLs but builds no content index', async () => {
    await writeFile(join(vault, 'Loop Engineering.md'),
      NOTE('https://example.com/a', 'Loop Engineering', BODY));
    const { urls, content } = await scanVault(vault, { content: false });
    expect(urls.has('https://example.com/a')).toBe(true);
    expect(content.classify(fingerprint('Loop Engineering', BODY)).verdict).toBe('unique');
  });
});
