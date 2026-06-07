import { describe, it, expect } from 'vitest';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractImageRefs,
  resolveUrl,
  pickExtension,
  attachmentBase,
  uniqueAttachmentName,
  downloadImages,
} from '../src/images.mjs';

// Build a minimal valid PNG header that image-size can read (w x h).
function fakePng(w, h) {
  const b = Buffer.alloc(33);
  b.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return new Uint8Array(b);
}

describe('extractImageRefs', () => {
  it('finds markdown images, unwrapping <> and ignoring titles', () => {
    const md = 'a ![x](https://e.com/a.png) b ![](<https://e.com/b.jpg> "t") c';
    const refs = extractImageRefs(md);
    expect(refs.map((r) => r.url)).toEqual(['https://e.com/a.png', 'https://e.com/b.jpg']);
    expect(refs[0].alt).toBe('x');
  });
});

describe('resolveUrl', () => {
  it('absolutizes relative against the base, returns null on garbage', () => {
    expect(resolveUrl('/p/x.png', 'https://e.com/a/')).toBe('https://e.com/p/x.png');
    expect(resolveUrl('::::', 'not a url')).toBeNull();
  });
});

describe('pickExtension', () => {
  it('prefers detected type, then content-type, then URL suffix, else png', () => {
    expect(pickExtension('jpg', 'image/png', 'x')).toBe('jpg');
    expect(pickExtension(null, 'image/webp; charset=x', 'x')).toBe('webp');
    expect(pickExtension(null, '', 'https://e.com/x.GIF?z=1')).toBe('gif');
    expect(pickExtension(null, '', 'https://e.com/noext')).toBe('png');
  });
});

describe('attachment naming', () => {
  it('zero-pads the index and sanitizes the slug', () => {
    expect(attachmentBase('My Note/Title', 3)).toBe('My Note Title-03');
  });
  it('avoids collisions against taken names (incl. disk-seeded)', () => {
    const taken = new Set(['note-01.png']);
    expect(uniqueAttachmentName('note', 1, 'png', taken)).toBe('note-01 (2).png');
  });
});

describe('downloadImages', () => {
  const attachDir = () => mkdtemp(join(tmpdir(), 'b2o-'));

  it('uses captured bytes first, never calls fetchImpl on a hit', async () => {
    const dir = await attachDir();
    const md = '![a](https://e.com/a.png)';
    const capturedBytes = new Map([
      ['https://e.com/a.png', { bytes: fakePng(120, 80), contentType: 'image/png' }],
    ]);
    let fetchCalls = 0;
    const fetchImpl = async () => { fetchCalls += 1; return null; };
    const res = await downloadImages(md, {
      baseUrl: 'https://e.com/post', slug: 'note', attachDir: dir, capturedBytes, fetchImpl,
    });
    expect(fetchCalls).toBe(0);
    expect(res.downloaded).toBe(1);
    expect(res.markdown).toContain('![[note-01.png]]');
  });

  it('falls back to fetchImpl when not captured, rewrites + dedupes by hash', async () => {
    const dir = await attachDir();
    const md = '![a](https://e.com/a.png)\n\n![b](https://e.com/dup.png)';
    const png = fakePng(120, 80);
    const fetchImpl = async () => ({ bytes: png, contentType: 'image/png' });
    const res = await downloadImages(md, { baseUrl: 'https://e.com/post', slug: 'note', attachDir: dir, fetchImpl });
    expect(res.downloaded).toBe(1); // identical bytes => one file, two embeds
    expect((res.markdown.match(/!\[\[note-01\.png\]\]/g) || []).length).toBe(2);
    const files = await readdir(dir);
    expect(files).toEqual(['note-01.png']);
    expect((await readFile(join(dir, 'note-01.png'))).length).toBe(png.length);
  });

  it('respects disk-seeded takenNames so cross-run names never collide', async () => {
    const dir = await attachDir();
    const md = '![a](https://e.com/a.png)';
    const fetchImpl = async () => ({ bytes: fakePng(120, 80), contentType: 'image/png' });
    const takenNames = new Set(['note-01.png']); // pretend a prior run wrote this
    const res = await downloadImages(md, {
      baseUrl: 'https://e.com/post', slug: 'note', attachDir: dir, fetchImpl, takenNames,
    });
    expect(res.markdown).toContain('![[note-01 (2).png]]');
    expect(await readdir(dir)).toEqual(['note-01 (2).png']);
  });

  it('drops tracking pixels (< 33px) and removes their reference', async () => {
    const dir = await attachDir();
    const md = 'before ![pixel](https://e.com/p.png) after';
    const fetchImpl = async () => ({ bytes: fakePng(1, 1), contentType: 'image/png' });
    const res = await downloadImages(md, { baseUrl: 'https://e.com/post', slug: 'note', attachDir: dir, fetchImpl });
    expect(res.dropped).toBe(1);
    expect(res.downloaded).toBe(0);
    expect(res.markdown).toBe('before  after');
  });

  it('leaves the remote URL and counts remote when acquisition fails', async () => {
    const dir = await attachDir();
    const md = '![a](https://e.com/a.png)';
    const fetchImpl = async () => null;
    const res = await downloadImages(md, { baseUrl: 'https://e.com/post', slug: 'note', attachDir: dir, fetchImpl });
    expect(res.remote).toBe(1);
    expect(res.markdown).toBe('![a](https://e.com/a.png)');
  });

  it('skips data: URIs untouched', async () => {
    const dir = await attachDir();
    const md = '![x](data:image/png;base64,AAAA)';
    let called = 0;
    const fetchImpl = async () => { called += 1; return null; };
    const res = await downloadImages(md, { baseUrl: 'https://e.com/post', slug: 'note', attachDir: dir, fetchImpl });
    expect(called).toBe(0);
    expect(res.markdown).toBe(md);
  });
});
