# Importer Content Dedup (Hardening) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the importer creating a note whose *content* duplicates one already known (in the vault, earlier in the same run, or remembered from a prior run), catching both byte-identical permalink twins and same-article-different-boilerplate reposts, while still importing genuinely distinct same-titled articles (flagged for review).

**Architecture:** Add a pure, dependency-free fingerprint layer (`node:crypto` only) — title key + normalized-body SHA-1 + 64-bit SimHash. Seed a content index from the live vault scan, then split the importer's single render-and-write pass into three stages: **Phase A** extracts and fingerprints in parallel, a **serial slot-ordered reconcile** classifies each candidate against the index (the earliest bookmark wins), and **Phase B** writes only the accepted notes. URL dedup is unchanged and still short-circuits first.

**Tech Stack:** Node ESM (`.mjs`), `node:crypto`, `node:fs/promises`. Tests: vitest at the repo root, importing from `../bookmarks-to-obsidian/scripts/src/`. No new runtime dependencies.

---

## File Structure

**New runtime modules** (under `bookmarks-to-obsidian/scripts/src/`):

- `fingerprint.mjs` — pure fingerprint primitives: `titleKey`, `normalizeBody`, `bodyHash`, `simhash`, `hamming`, and the `fingerprint(title, markdown)` composite. No IO, `node:crypto` only.
- `content-index.mjs` — `createContentIndex()` → `{ add, classify }`. Indexes known notes by body hash (exact tier) and by title key (near/flag tiers).
- `reconcile.mjs` — `reconcile(candidates, contentIndex, opts)`: pure, serial, slot-ordered duplicate decision. Assigns collision-free filenames and grows the index. No IO.

**New tests** (under root `test/`):

- `test/fingerprint.test.mjs`
- `test/content-index.test.mjs`
- `test/reconcile.test.mjs`
- `test/dedup.scan.test.mjs`

**Modified files:**

- `bookmarks-to-obsidian/scripts/src/dedup.mjs` — rename `scanVaultSources` → `scanVault`, extend it to build the content index from each note's title+body.
- `bookmarks-to-obsidian/scripts/src/report.mjs` — add `skipped-duplicate` to `STATUSES`.
- `bookmarks-to-obsidian/scripts/import.mjs` — new flags, `scanVault` wiring, three-phase refactor, `meta.dedup`, manifest fingerprint fields.
- `bookmarks-to-obsidian/SKILL.md` — status row, flags, workflow step 4.
- `test/report.test.mjs` — update expected summaries for the new bucket.

**Boundaries:** the dup *decision* (`fingerprint` → `content-index` → `reconcile`) is pure and fully unit-tested. `import.mjs` is the only file that touches the network/filesystem and is verified by `node --check`, the suite, `--help`, and a manual dry-run.

---

### Task 1: `fingerprint.mjs` — title key, body normalization, body hash

**Files:**
- Create: `bookmarks-to-obsidian/scripts/src/fingerprint.mjs`
- Test: `test/fingerprint.test.mjs`

- [x] **Step 1: Write the failing test**

Create `test/fingerprint.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import {
  titleKey,
  normalizeBody,
  bodyHash,
} from '../bookmarks-to-obsidian/scripts/src/fingerprint.mjs';

describe('titleKey', () => {
  it('canonicalizes case and whitespace so colliding titles share a key', () => {
    expect(titleKey('Loop Engineering')).toBe(titleKey('  loop   engineering '));
  });

  it('strips filename-illegal characters (matches sanitizeFilename)', () => {
    expect(titleKey('A/B:C')).toBe(titleKey('A B C'));
  });

  it('returns empty string for a missing/empty title so it never matches', () => {
    expect(titleKey('')).toBe('');
    expect(titleKey(null)).toBe('');
    expect(titleKey(undefined)).toBe('');
  });

  it('distinguishes genuinely different titles', () => {
    expect(titleKey('Loop Engineering')).not.toBe(titleKey('Year in Review 2025'));
  });
});

describe('normalizeBody', () => {
  it('drops remote image markup entirely', () => {
    expect(normalizeBody('hello ![alt](https://x.com/y.png) world'))
      .toBe(normalizeBody('hello world'));
  });

  it('drops local Obsidian image embeds entirely', () => {
    expect(normalizeBody('hello ![[my-note-01.png]] world'))
      .toBe(normalizeBody('hello world'));
  });

  it('reduces a markdown link to its anchor text', () => {
    expect(normalizeBody('see [the docs](https://x.com/docs) now'))
      .toBe(normalizeBody('see the docs now'));
  });

  it('is stable across image-path noise (pre- vs post-image-rewrite)', () => {
    const remote = 'Intro paragraph.\n\n![diagram](https://cdn.example.com/a.png)\n\nOutro.';
    const local = 'Intro paragraph.\n\n![[Loop Engineering-01.png]]\n\nOutro.';
    expect(normalizeBody(remote)).toBe(normalizeBody(local));
  });

  it('lowercases and collapses whitespace, dropping heading/emphasis markers', () => {
    expect(normalizeBody('# **Hello**   World\n\n_again_')).toBe('hello world again');
  });
});

describe('bodyHash', () => {
  it('is equal for identical normalized bodies and differs when content changes', () => {
    expect(bodyHash('the same text')).toBe(bodyHash('the same text'));
    expect(bodyHash('the same text')).not.toBe(bodyHash('different text'));
  });

  it('returns SHA-1 hex (40 chars)', () => {
    expect(bodyHash('x')).toMatch(/^[0-9a-f]{40}$/);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/fingerprint.test.mjs`
Expected: FAIL — `Failed to resolve import` / `titleKey is not a function` (module does not exist yet).

- [x] **Step 3: Write the minimal implementation**

Create `bookmarks-to-obsidian/scripts/src/fingerprint.mjs`:

```js
// Content fingerprinting for dedup: title key + normalized-body hash + SimHash.
// Self-contained — node:crypto only, no new dependencies.
import { createHash } from 'node:crypto';
import { sanitizeFilename } from './note.mjs';

/**
 * Canonical lookup key for a title: the lowercased, sanitized title. By
 * construction titleKey(a) === titleKey(b) exactly when the two notes' filenames
 * would collide — the title key IS the " (2)" signal, reused as a lookup key.
 * Empty/missing titles return '' so they never match in the by-title index.
 */
export function titleKey(title) {
  const t = String(title ?? '').trim();
  if (!t) return '';
  return sanitizeFilename(t).toLowerCase();
}

/**
 * Reduce markdown to comparable plain text so the fingerprint is stable across
 * boilerplate and image-path noise: drop image markup (remote ![](url) AND local
 * ![[slug]] embeds), reduce links to their anchor text, strip heading/emphasis/
 * code markers, lowercase, collapse whitespace.
 */
export function normalizeBody(markdown) {
  let s = String(markdown ?? '');
  s = s.replace(/!\[\[[^\]]*\]\]/g, ' ');        // local image embeds ![[slug]]
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');    // remote images ![alt](url)
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');  // links [text](url) -> text
  s = s.replace(/\[\[([^\]]*)\]\]/g, '$1');       // wikilinks [[target]] -> target
  s = s.replace(/[#*_`>~]/g, ' ');                // heading/emphasis/code/quote markers
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** SHA-1 hex of the normalized body — the exact-duplicate key. */
export function bodyHash(normalizedBody) {
  return createHash('sha1').update(String(normalizedBody)).digest('hex');
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/fingerprint.test.mjs`
Expected: PASS (all `titleKey`, `normalizeBody`, `bodyHash` cases green).

- [x] **Step 5: Commit**

```sh
git add bookmarks-to-obsidian/scripts/src/fingerprint.mjs test/fingerprint.test.mjs
git commit -m "feat(fingerprint): title key, body normalization, body hash" -m "Pure node:crypto primitives for content dedup. titleKey reuses sanitizeFilename canonicalization; normalizeBody drops image markup and link URLs so the hash is stable across boilerplate and image-path rewrites."
```

---

### Task 2: `fingerprint.mjs` — SimHash + Hamming distance

**Files:**
- Modify: `bookmarks-to-obsidian/scripts/src/fingerprint.mjs`
- Test: `test/fingerprint.test.mjs`

- [x] **Step 1: Write the failing test**

Append to `test/fingerprint.test.mjs` (add the imports to the existing import block and append the new `describe`):

```js
import {
  titleKey,
  normalizeBody,
  bodyHash,
  simhash,
  hamming,
} from '../bookmarks-to-obsidian/scripts/src/fingerprint.mjs';

// A real-prose article, a boilerplate-varied copy (one extra line), and a
// genuinely different post. Kept long so shared 3-grams dominate the SimHash.
const ARTICLE = `
Loop engineering is the practice of designing feedback loops that keep an agent on task.
A good loop has three parts: a goal, an observation step, and a correction step.
When the agent drifts away from the plan, the correction step nudges it back toward the goal.
The art is choosing how tight the loop should be. Too tight and the agent thrashes on noise.
Too loose and it wanders off for many steps before anyone notices the problem.
Most production systems settle somewhere in the middle, trimming the loop over time
as they learn which signals actually predict drift and which are just random noise.
`;

const ARTICLE_REPOST = `
Subscribe to my newsletter for a weekly post like this one.
Loop engineering is the practice of designing feedback loops that keep an agent on task.
A good loop has three parts: a goal, an observation step, and a correction step.
When the agent drifts away from the plan, the correction step nudges it back toward the goal.
The art is choosing how tight the loop should be. Too tight and the agent thrashes on noise.
Too loose and it wanders off for many steps before anyone notices the problem.
Most production systems settle somewhere in the middle, trimming the loop over time
as they learn which signals actually predict drift and which are just random noise.
`;

const DIFFERENT = `
Yesterday I went hiking in the mountains and saw three deer near the rocky ridge.
The weather was cold but clear, and the narrow trail was covered in fresh white snow.
We packed sandwiches and a thermos of coffee and stopped at the summit for a long lunch.
On the way back down a sudden storm rolled in, so we hurried back toward the parked car.
It was a long and tiring day but worth every single step for the view from the very top.
`;

describe('simhash + hamming', () => {
  it('returns a 16-char hex string (64-bit) for any body', () => {
    expect(simhash(normalizeBody(ARTICLE))).toMatch(/^[0-9a-f]{16}$/);
    expect(simhash('')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('has zero distance from itself', () => {
    const s = simhash(normalizeBody(ARTICLE));
    expect(hamming(s, s)).toBe(0);
  });

  it('keeps boilerplate-varied copies of one article within the near threshold (<= 6)', () => {
    const a = simhash(normalizeBody(ARTICLE));
    const b = simhash(normalizeBody(ARTICLE_REPOST));
    expect(hamming(a, b)).toBeLessThanOrEqual(6);
  });

  it('puts two distinct same-titled articles well above the threshold (> 6)', () => {
    const a = simhash(normalizeBody(ARTICLE));
    const c = simhash(normalizeBody(DIFFERENT));
    expect(hamming(a, c)).toBeGreaterThan(6);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/fingerprint.test.mjs`
Expected: FAIL — `simhash is not a function` / import resolves but symbol missing.

- [x] **Step 3: Write the minimal implementation**

Append to `bookmarks-to-obsidian/scripts/src/fingerprint.mjs`:

```js
// 64-bit hash of a string = the first 8 bytes of its SHA-1 digest (a Buffer).
// Working on the byte buffer avoids BigInt (which is not JSON-serialisable).
function hash64(str) {
  return createHash('sha1').update(str).digest().subarray(0, 8);
}

/**
 * 64-bit SimHash over word 3-gram shingles, returned as a 16-char hex string.
 * Near-identical prose with differing boilerplate lands within a few bits;
 * genuinely different text lands far apart.
 */
export function simhash(normalizedBody, { gram = 3 } = {}) {
  const words = String(normalizedBody).split(' ').filter(Boolean);
  const shingles = [];
  if (words.length < gram) {
    if (words.length) shingles.push(words.join(' '));
  } else {
    for (let i = 0; i + gram <= words.length; i += 1) {
      shingles.push(words.slice(i, i + gram).join(' '));
    }
  }
  const bits = new Array(64).fill(0);
  for (const sh of shingles) {
    const h = hash64(sh); // 8-byte Buffer
    for (let b = 0; b < 64; b += 1) {
      const bit = (h[b >> 3] >> (7 - (b & 7))) & 1;
      bits[b] += bit ? 1 : -1;
    }
  }
  const out = Buffer.alloc(8);
  for (let b = 0; b < 64; b += 1) {
    if (bits[b] > 0) out[b >> 3] |= 1 << (7 - (b & 7));
  }
  return out.toString('hex');
}

/** Bit (Hamming) distance between two hex SimHashes. */
export function hamming(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  const len = Math.min(ba.length, bb.length);
  let dist = 0;
  for (let i = 0; i < len; i += 1) {
    let x = ba[i] ^ bb[i];
    while (x) { dist += x & 1; x >>= 1; }
  }
  return dist;
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/fingerprint.test.mjs`
Expected: PASS. If the near case (`ARTICLE` vs `ARTICLE_REPOST`) reports a distance of 7–8, lengthen the shared body text in both fixtures (more identical sentences) so shared 3-grams dominate, then re-run — do **not** loosen the `<= 6` assertion.

- [x] **Step 5: Commit**

```sh
git add bookmarks-to-obsidian/scripts/src/fingerprint.mjs test/fingerprint.test.mjs
git commit -m "feat(fingerprint): 64-bit SimHash and Hamming distance" -m "SimHash over word 3-gram shingles, serialised as 16-char hex (no BigInt). Boilerplate-varied copies land within ~6 bits; distinct same-titled posts land far above."
```

---

### Task 3: `fingerprint.mjs` — the `fingerprint()` composite

**Files:**
- Modify: `bookmarks-to-obsidian/scripts/src/fingerprint.mjs`
- Test: `test/fingerprint.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/fingerprint.test.mjs` (add `fingerprint` to the import block, then append):

```js
import {
  titleKey,
  normalizeBody,
  bodyHash,
  simhash,
  hamming,
  fingerprint,
} from '../bookmarks-to-obsidian/scripts/src/fingerprint.mjs';

describe('fingerprint', () => {
  it('returns the title key, body hash, simhash and normalized word count', () => {
    const fp = fingerprint('Loop Engineering', 'Hello brave new world.');
    expect(fp.titleKey).toBe(titleKey('Loop Engineering'));
    expect(fp.bodyHash).toBe(bodyHash(normalizeBody('Hello brave new world.')));
    expect(fp.simhash).toBe(simhash(normalizeBody('Hello brave new world.')));
    expect(fp.wordCount).toBe(4);
  });

  it('fingerprints the same article identically before and after image rewrite', () => {
    const remote = fingerprint('A', 'Intro.\n\n![x](https://cdn/x.png)\n\nOutro body text here.');
    const local = fingerprint('A', 'Intro.\n\n![[A-01.png]]\n\nOutro body text here.');
    expect(remote.bodyHash).toBe(local.bodyHash);
    expect(remote.simhash).toBe(local.simhash);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/fingerprint.test.mjs`
Expected: FAIL — `fingerprint is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `bookmarks-to-obsidian/scripts/src/fingerprint.mjs`:

```js
/**
 * Shared by the vault scan and the extract stage: fingerprint a note's title +
 * markdown into { titleKey, bodyHash, simhash, wordCount }. wordCount is over the
 * normalized body (so it is comparable across renders).
 */
export function fingerprint(title, markdown) {
  const body = normalizeBody(markdown);
  return {
    titleKey: titleKey(title),
    bodyHash: bodyHash(body),
    simhash: simhash(body),
    wordCount: body ? body.split(' ').length : 0,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/fingerprint.test.mjs`
Expected: PASS (whole file green).

- [ ] **Step 5: Commit**

```sh
git add bookmarks-to-obsidian/scripts/src/fingerprint.mjs test/fingerprint.test.mjs
git commit -m "feat(fingerprint): fingerprint() composite helper" -m "One call returns titleKey/bodyHash/simhash/wordCount, shared by the vault scan and the extract stage."
```

---

### Task 4: `content-index.mjs` — the content index (`add` + `classify`)

**Files:**
- Create: `bookmarks-to-obsidian/scripts/src/content-index.mjs`
- Test: `test/content-index.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/content-index.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { createContentIndex } from '../bookmarks-to-obsidian/scripts/src/content-index.mjs';
import { fingerprint, simhash, normalizeBody } from '../bookmarks-to-obsidian/scripts/src/fingerprint.mjs';

const ARTICLE = `
Loop engineering is the practice of designing feedback loops that keep an agent on task.
A good loop has three parts: a goal, an observation step, and a correction step.
When the agent drifts away from the plan, the correction step nudges it back toward the goal.
The art is choosing how tight the loop should be. Too tight and the agent thrashes on noise.
Too loose and it wanders off for many steps before anyone notices the problem.
Most production systems settle somewhere in the middle, trimming the loop over time
as they learn which signals actually predict drift and which are just random noise.
`;
const ARTICLE_REPOST = `Subscribe to my newsletter for a weekly post like this one.\n${ARTICLE}`;
const DIFFERENT = `
Yesterday I went hiking in the mountains and saw three deer near the rocky ridge.
The weather was cold but clear, and the narrow trail was covered in fresh white snow.
We packed sandwiches and a thermos of coffee and stopped at the summit for a long lunch.
On the way back down a sudden storm rolled in, so we hurried back toward the parked car.
`;

describe('contentIndex.classify', () => {
  it('returns unique when no title key matches', () => {
    const idx = createContentIndex();
    idx.add(fingerprintFile('Loop Engineering.md', 'Loop Engineering', ARTICLE));
    const v = idx.classify(fingerprint('Totally Other', DIFFERENT));
    expect(v.verdict).toBe('unique');
  });

  it('returns exact when the body hash matches, regardless of title', () => {
    const idx = createContentIndex();
    idx.add(fingerprintFile('Loop Engineering.md', 'Loop Engineering', ARTICLE));
    const v = idx.classify(fingerprint('A Different Title', ARTICLE));
    expect(v).toMatchObject({ verdict: 'exact', duplicateOf: 'Loop Engineering.md' });
  });

  it('returns near when the title matches and the body is within the distance', () => {
    const idx = createContentIndex();
    idx.add(fingerprintFile('Loop Engineering.md', 'Loop Engineering', ARTICLE));
    const v = idx.classify(fingerprint('Loop Engineering', ARTICLE_REPOST));
    expect(v.verdict).toBe('near');
    expect(v.duplicateOf).toBe('Loop Engineering.md');
    expect(v.distance).toBeLessThanOrEqual(6);
  });

  it('returns flag when the title matches but every candidate is beyond the distance', () => {
    const idx = createContentIndex();
    idx.add(fingerprintFile('Loop Engineering.md', 'Loop Engineering', ARTICLE));
    const v = idx.classify(fingerprint('Loop Engineering', DIFFERENT));
    expect(v.verdict).toBe('flag');
    expect(v.possibleDuplicateOf).toEqual(['Loop Engineering.md']);
  });

  it('treats an empty title key as no title match (only the exact tier applies)', () => {
    const idx = createContentIndex();
    idx.add(fingerprintFile('Loop Engineering.md', 'Loop Engineering', ARTICLE));
    expect(idx.classify(fingerprint('', DIFFERENT)).verdict).toBe('unique');
    expect(idx.classify(fingerprint('', ARTICLE)).verdict).toBe('exact');
  });

  it('honors a custom distance threshold', () => {
    const idx = createContentIndex();
    idx.add(fingerprintFile('Loop Engineering.md', 'Loop Engineering', ARTICLE));
    // distance 0 forces the near tier to miss → flag.
    expect(idx.classify(fingerprint('Loop Engineering', ARTICLE_REPOST), { distance: 0 }).verdict).toBe('flag');
  });
});

// Helper: build the { file, titleKey, bodyHash, simhash } record add() expects.
function fingerprintFile(file, title, markdown) {
  const fp = fingerprint(title, markdown);
  return { file, titleKey: fp.titleKey, bodyHash: fp.bodyHash, simhash: fp.simhash };
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/content-index.test.mjs`
Expected: FAIL — module `content-index.mjs` does not exist.

- [ ] **Step 3: Write the minimal implementation**

Create `bookmarks-to-obsidian/scripts/src/content-index.mjs`:

```js
// In-memory index of known notes' fingerprints. Seeded from the vault scan and
// grown during reconcile, so within-run and cross-run dedup share one code path.
import { hamming } from './fingerprint.mjs';

/**
 * createContentIndex() → { add, classify }.
 *   add({ file, titleKey, bodyHash, simhash })  — register a known note.
 *   classify({ titleKey, bodyHash, simhash }, { distance = 6 }) → verdict object:
 *     { verdict: 'exact', duplicateOf }
 *     { verdict: 'near',  duplicateOf, distance }
 *     { verdict: 'flag',  possibleDuplicateOf: [files] }
 *     { verdict: 'unique' }
 */
export function createContentIndex() {
  const byHash = new Map();  // bodyHash -> file (first writer wins)
  const byTitle = new Map(); // titleKey -> Array<{ file, simhash }>

  function add({ file, titleKey, bodyHash, simhash }) {
    if (bodyHash && !byHash.has(bodyHash)) byHash.set(bodyHash, file);
    if (titleKey) {
      const arr = byTitle.get(titleKey) || [];
      arr.push({ file, simhash });
      byTitle.set(titleKey, arr);
    }
  }

  function classify({ titleKey, bodyHash, simhash }, { distance = 6 } = {}) {
    // Exact tier first: a byte-identical body short-circuits regardless of title.
    if (bodyHash && byHash.has(bodyHash)) {
      return { verdict: 'exact', duplicateOf: byHash.get(bodyHash) };
    }
    const peers = titleKey ? byTitle.get(titleKey) : null;
    if (!peers || !peers.length) return { verdict: 'unique' };

    // Near tier: same title and a close enough body.
    let best = null;
    for (const p of peers) {
      const d = hamming(simhash, p.simhash);
      if (best === null || d < best.distance) best = { distance: d, file: p.file };
    }
    if (best && best.distance <= distance) {
      return { verdict: 'near', duplicateOf: best.file, distance: best.distance };
    }
    // Flag tier: same title, but content diverged from every known peer.
    return { verdict: 'flag', possibleDuplicateOf: peers.map((p) => p.file) };
  }

  return { add, classify };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/content-index.test.mjs`
Expected: PASS (exact / near / flag / unique / empty-title / custom-distance all green).

- [ ] **Step 5: Commit**

```sh
git add bookmarks-to-obsidian/scripts/src/content-index.mjs test/content-index.test.mjs
git commit -m "feat(content-index): exact/near/flag/unique classifier" -m "byHash exact tier short-circuits regardless of title; byTitle near tier uses SimHash Hamming distance (default 6); same-title-far-body returns flag."
```

---

### Task 5: `reconcile.mjs` — serial, slot-ordered duplicate decision

**Files:**
- Create: `bookmarks-to-obsidian/scripts/src/reconcile.mjs`
- Test: `test/reconcile.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/reconcile.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { reconcile } from '../bookmarks-to-obsidian/scripts/src/reconcile.mjs';
import { createContentIndex } from '../bookmarks-to-obsidian/scripts/src/content-index.mjs';
import { fingerprint } from '../bookmarks-to-obsidian/scripts/src/fingerprint.mjs';

const ARTICLE = `
Loop engineering is the practice of designing feedback loops that keep an agent on task.
A good loop has three parts: a goal, an observation step, and a correction step.
When the agent drifts away from the plan, the correction step nudges it back toward the goal.
The art is choosing how tight the loop should be. Too tight and the agent thrashes on noise.
Too loose and it wanders off for many steps before anyone notices the problem.
Most production systems settle somewhere in the middle, trimming the loop over time
as they learn which signals actually predict drift and which are just random noise.
`;
const ARTICLE_REPOST = `Subscribe to my newsletter for a weekly post like this one.\n${ARTICLE}`;
const DIFFERENT = `
Yesterday I went hiking in the mountains and saw three deer near the rocky ridge.
The weather was cold but clear, and the narrow trail was covered in fresh white snow.
We packed sandwiches and a thermos of coffee and stopped at the summit for a long lunch.
`;

function cand(slot, title, markdown) {
  return { slot, title, bm: { id: `b${slot}`, url: `https://x/${slot}` }, norm: `n${slot}`, fingerprint: fingerprint(title, markdown) };
}

describe('reconcile', () => {
  it('keeps the lowest-slot note and skips the rest of a real duplicate cluster', () => {
    const idx = createContentIndex();
    const existingNames = new Set();
    // Permalink twin (exact body) + cross-domain repost (near), all same title.
    const cands = [
      cand(0, 'Loop Engineering', ARTICLE),
      cand(1, 'Loop Engineering', ARTICLE),         // permalink twin → exact
      cand(2, 'Loop Engineering', ARTICLE_REPOST),  // repost → near
    ];
    const decisions = reconcile(cands, idx, { distance: 6, existingNames, dedup: true });

    expect(decisions[0]).toMatchObject({ action: 'accept', filename: 'Loop Engineering.md' });
    expect(decisions[1]).toMatchObject({ action: 'skip' });
    expect(decisions[1].verdict).toMatchObject({ verdict: 'exact', duplicateOf: 'Loop Engineering.md' });
    expect(decisions[2]).toMatchObject({ action: 'skip' });
    expect(decisions[2].verdict).toMatchObject({ verdict: 'near', duplicateOf: 'Loop Engineering.md' });
  });

  it('is slot-ordered regardless of input order (lowest slot is canonical)', () => {
    const idx = createContentIndex();
    const existingNames = new Set();
    const cands = [cand(2, 'Loop Engineering', ARTICLE), cand(0, 'Loop Engineering', ARTICLE)];
    const decisions = reconcile(cands, idx, { distance: 6, existingNames, dedup: true });
    const bySlot = Object.fromEntries(decisions.map((d) => [d.candidate.slot, d]));
    expect(bySlot[0].action).toBe('accept');
    expect(bySlot[2].action).toBe('skip');
  });

  it('imports a distinct same-titled article and flags it', () => {
    const idx = createContentIndex();
    const existingNames = new Set();
    const cands = [
      cand(0, 'Year in Review 2025', ARTICLE),
      cand(1, 'Year in Review 2025', DIFFERENT),
    ];
    const decisions = reconcile(cands, idx, { distance: 6, existingNames, dedup: true });
    expect(decisions[0]).toMatchObject({ action: 'accept', filename: 'Year in Review 2025.md' });
    expect(decisions[1]).toMatchObject({ action: 'accept', filename: 'Year in Review 2025 (2).md' });
    expect(decisions[1].verdict).toMatchObject({ verdict: 'flag', possibleDuplicateOf: ['Year in Review 2025.md'] });
  });

  it('accepts everything when dedup is disabled', () => {
    const idx = createContentIndex();
    const existingNames = new Set();
    const cands = [cand(0, 'Loop Engineering', ARTICLE), cand(1, 'Loop Engineering', ARTICLE)];
    const decisions = reconcile(cands, idx, { distance: 6, existingNames, dedup: false });
    expect(decisions.map((d) => d.action)).toEqual(['accept', 'accept']);
    expect(decisions.map((d) => d.filename)).toEqual(['Loop Engineering.md', 'Loop Engineering (2).md']);
  });

  it('respects already-taken filenames from the inbox', () => {
    const idx = createContentIndex();
    const existingNames = new Set(['Loop Engineering.md']);
    const decisions = reconcile([cand(0, 'Loop Engineering', DIFFERENT)], idx, { distance: 6, existingNames, dedup: true });
    expect(decisions[0]).toMatchObject({ action: 'accept', filename: 'Loop Engineering (2).md' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/reconcile.test.mjs`
Expected: FAIL — module `reconcile.mjs` does not exist.

- [ ] **Step 3: Write the minimal implementation**

Create `bookmarks-to-obsidian/scripts/src/reconcile.mjs`:

```js
// Serial, slot-ordered duplicate reconciliation. Pure: no IO. The dup decision
// is a function of (fingerprint, slot order), independent of render timing — so
// the earliest bookmark always wins as the canonical note.
import { sanitizeFilename, uniqueFilename } from './note.mjs';

/**
 * reconcile(candidates, contentIndex, opts) → decisions[], one per candidate.
 *
 *   candidate: { slot, title, fingerprint, bm, norm, ... } (passed through).
 *   opts.distance     — SimHash near threshold (default 6).
 *   opts.existingNames — Set of taken inbox filenames; mutated as names are assigned.
 *   opts.dedup        — false disables classification (everything accepted).
 *
 * Mutates contentIndex (grows it with each accepted note) and existingNames.
 *
 *   decision (skip):   { candidate, action: 'skip', verdict }
 *   decision (accept): { candidate, action: 'accept', verdict, filename }
 */
export function reconcile(candidates, contentIndex, { distance = 6, existingNames, dedup = true } = {}) {
  const ordered = [...candidates].sort((a, b) => a.slot - b.slot);
  const decisions = [];
  for (const candidate of ordered) {
    let verdict = { verdict: 'unique' };
    if (dedup && candidate.fingerprint) {
      verdict = contentIndex.classify(candidate.fingerprint, { distance });
    }
    if (verdict.verdict === 'exact' || verdict.verdict === 'near') {
      decisions.push({ candidate, action: 'skip', verdict });
      continue;
    }
    // Accepted (unique or flag): assign a collision-free name, grow the index.
    const base = sanitizeFilename(candidate.title);
    const filename = uniqueFilename(base, '.md', (n) => existingNames.has(n));
    existingNames.add(filename);
    if (dedup && candidate.fingerprint) {
      contentIndex.add({
        file: filename,
        titleKey: candidate.fingerprint.titleKey,
        bodyHash: candidate.fingerprint.bodyHash,
        simhash: candidate.fingerprint.simhash,
      });
    }
    decisions.push({ candidate, action: 'accept', verdict, filename });
  }
  return decisions;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/reconcile.test.mjs`
Expected: PASS (cluster, slot-order, flag pair, dedup-off, taken-names all green).

- [ ] **Step 5: Commit**

```sh
git add bookmarks-to-obsidian/scripts/src/reconcile.mjs test/reconcile.test.mjs
git commit -m "feat(reconcile): serial slot-ordered dup decision" -m "Pure function of (fingerprint, slot). Lowest slot wins as canonical; exact/near skip, unique/flag accept with a collision-free filename; dedup:false passes everything through."
```

---

### Task 6: `report.mjs` — add the `skipped-duplicate` status bucket

**Files:**
- Modify: `bookmarks-to-obsidian/scripts/src/report.mjs:3-9`
- Test: `test/report.test.mjs` (update existing expectations)

- [ ] **Step 1: Update the failing test**

In `test/report.test.mjs`, the two exhaustive `toEqual` summaries must include the new bucket. Replace the first test's body so it exercises the bucket:

```js
  it('aggregates per-status counts and echoes the items', () => {
    const items = [
      { url: 'https://a', status: 'imported', file: 'A.md' },
      { url: 'https://b', status: 'imported', file: 'B.md' },
      { url: 'https://c', status: 'skipped-existing' },
      { url: 'https://d', status: 'skipped-thin', reason: 'wordCount 12 < 200' },
      { url: 'https://e', status: 'skipped-binary', reason: 'application/pdf' },
      { url: 'https://f', status: 'failed', reason: 'HTTP 404' },
      { url: 'https://g', status: 'skipped-duplicate', reason: 'exact content', duplicateOf: 'A.md' },
    ];
    const report = buildReport(items);
    expect(report.summary).toEqual({
      total: 7,
      imported: 2,
      'skipped-existing': 1,
      'skipped-thin': 1,
      'skipped-binary': 1,
      'skipped-duplicate': 1,
      failed: 1,
    });
    expect(report.items).toHaveLength(7);
  });
```

Then add `'skipped-duplicate': 0` to the second test's expected summary:

```js
    expect(report.summary).toEqual({
      total: 1,
      imported: 1,
      'skipped-existing': 0,
      'skipped-thin': 0,
      'skipped-binary': 0,
      'skipped-duplicate': 0,
      failed: 0,
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/report.test.mjs`
Expected: FAIL — summaries differ; `skipped-duplicate` missing from `buildReport` output.

- [ ] **Step 3: Write the minimal implementation**

In `bookmarks-to-obsidian/scripts/src/report.mjs`, add the status to `STATUSES`:

```js
export const STATUSES = [
  'imported',
  'skipped-existing',
  'skipped-thin',
  'skipped-binary',
  'skipped-duplicate',
  'failed',
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/report.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add bookmarks-to-obsidian/scripts/src/report.mjs test/report.test.mjs
git commit -m "feat(report): add skipped-duplicate status bucket" -m "The summary now always carries the skipped-duplicate count (zero when unused)."
```

---

### Task 7: `dedup.mjs` — `scanVault` builds the content index

**Files:**
- Modify: `bookmarks-to-obsidian/scripts/src/dedup.mjs:1-2,53-90`
- Test: `test/dedup.scan.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/dedup.scan.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/dedup.scan.test.mjs`
Expected: FAIL — `scanVault` is not exported (only `scanVaultSources` exists).

- [ ] **Step 3: Write the minimal implementation**

In `bookmarks-to-obsidian/scripts/src/dedup.mjs`, add imports under the existing import line:

```js
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createContentIndex } from './content-index.mjs';
import { fingerprint } from './fingerprint.mjs';
```

Then replace the whole `scanVaultSources` function and its `readSourceField` helper (the block from `/** Walk every .md ... */` through the end of `readSourceField`) with:

```js
/**
 * Walk every .md in the vault. Always collect normalized `source:` URLs. When
 * `content` is true (default) also fingerprint each note's title+body into a
 * content index — the live scan is the source of truth: it sees hand-added and
 * moved notes the manifest never recorded. Returns { urls:Set, content:contentIndex }.
 */
export async function scanVault(vaultPath, { content: buildContent = true } = {}) {
  const urls = new Set();
  const content = createContentIndex();
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
        continue;
      }
      if (!(e.isFile() && e.name.toLowerCase().endsWith('.md'))) continue;

      if (!buildContent) {
        const src = await readSourceField(full);
        if (src) urls.add(normalizeUrl(src));
        continue;
      }
      const fields = await readNoteFields(full);
      if (!fields) continue;
      if (fields.source) urls.add(normalizeUrl(fields.source));
      const base = e.name.replace(/\.md$/i, '');
      const fp = fingerprint(fields.title || base, fields.body);
      content.add({ file: e.name, titleKey: fp.titleKey, bodyHash: fp.bodyHash, simhash: fp.simhash });
    }
  }
  await walk(vaultPath);
  return { urls, content };
}

/** Read just the frontmatter `source:` (used on the no-content-dedup fast path). */
async function readSourceField(file) {
  const fields = await readNoteFields(file);
  return fields ? fields.source : null;
}

/** Parse a note's frontmatter `source:`/`title:` and the body after it. */
async function readNoteFields(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  if (!text.startsWith('---')) return { source: null, title: null, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { source: null, title: null, body: text };
  const fm = text.slice(3, end);
  const sm = fm.match(/^source:\s*["']?([^"'\n]+)["']?\s*$/m);
  const tm = fm.match(/^title:\s*["']?(.*?)["']?\s*$/m);
  const nl = text.indexOf('\n', end + 1); // newline ending the closing '---' line
  return {
    source: sm ? sm[1].trim() : null,
    title: tm ? tm[1].trim() : null,
    body: nl === -1 ? '' : text.slice(nl + 1),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/dedup.scan.test.mjs`
Expected: PASS (URL collection, recursion, and `{ content: false }` all green).

- [ ] **Step 5: Verify the whole suite still passes**

Run: `npm test`
Expected: PASS. (`url.test.mjs` imports only `normalizeUrl`, which is unchanged.)

- [ ] **Step 6: Commit**

```sh
git add bookmarks-to-obsidian/scripts/src/dedup.mjs test/dedup.scan.test.mjs
git commit -m "feat(dedup): scanVault builds a content index from titles+bodies" -m "Renames scanVaultSources -> scanVault returning { urls, content }. The live whole-vault walk now fingerprints each note (title+body), so moved/hand-added notes dedupe by content. { content:false } keeps the cheap URL-only path for --no-content-dedup."
```

---

### Task 8: `import.mjs` — add `--dup-distance` and `--no-content-dedup` flags

**Files:**
- Modify: `bookmarks-to-obsidian/scripts/import.mjs:30-96` (HELP + parseArgs)

- [ ] **Step 1: Add the flags to the HELP text**

In the `HELP` template, under `Options:`, add these two lines after the `--min-words` line:

```
  --dup-distance <N>     SimHash Hamming threshold for near-duplicate detection (default: 6).
  --no-content-dedup     Disable content dedup (URL dedup only; no fingerprinting).
```

- [ ] **Step 2: Add the defaults to the `opts` object**

In `parseArgs`, add two fields to the `opts` literal (e.g. after `minWords: 200,`):

```js
    dupDistance: 6,
    contentDedup: true,
```

- [ ] **Step 3: Add the parse cases**

In the `switch (a)` block, add two cases (e.g. after the `--min-words` case):

```js
      case '--dup-distance': opts.dupDistance = Math.max(0, Number(next())); break;
      case '--no-content-dedup': opts.contentDedup = false; break;
```

- [ ] **Step 4: Verify the CLI loads and help shows the flags**

Run: `node bookmarks-to-obsidian/scripts/import.mjs --help`
Expected: usage prints, including the two new option lines. No error.

- [ ] **Step 5: Commit**

```sh
git add bookmarks-to-obsidian/scripts/import.mjs
git commit -m "feat(import): add --dup-distance and --no-content-dedup flags" -m "Defaults: distance 6, content dedup on. Flags are parsed but not yet wired into the pipeline."
```

---

### Task 9: `import.mjs` — wire `scanVault` + seed the content index

**Files:**
- Modify: `bookmarks-to-obsidian/scripts/import.mjs:19-24` (imports), `:159` (scan call), `:186-189` (remembered path)

- [ ] **Step 1: Swap the dedup import**

Replace the `dedup.mjs` import block:

```js
import {
  normalizeUrl,
  scanVault,
  readManifest,
  writeManifest,
} from './src/dedup.mjs';
```

- [ ] **Step 2: Use `scanVault` and keep the content index**

Replace the step-3 scan line:

```js
  const { urls: vaultSet, content: contentIndex } = await scanVault(vaultAbs, { content: opts.contentDedup });
```

(`vaultSet.has(norm)` in step 4 keeps working unchanged; `contentIndex` is unused until Task 10.)

- [ ] **Step 3: Carry `duplicateOf` through the remembered path**

In step 4, the remembered branch currently pushes `{ url, title, status, reason: 'remembered', file: m.file }`. Replace that push with one that preserves a remembered duplicate pointer:

```js
      outcomes.push({ url: bm.url, title: bm.title, status, reason: 'remembered', file: m.file, duplicateOf: m.duplicateOf });
    }
```

(`m.duplicateOf` is `undefined` for non-duplicate entries — harmless.)

- [ ] **Step 4: Verify the CLI still parses/loads**

Run: `node --check bookmarks-to-obsidian/scripts/import.mjs`
Expected: no output (syntax OK).

Run: `node bookmarks-to-obsidian/scripts/import.mjs --help`
Expected: usage prints, no runtime error from the import swap.

- [ ] **Step 5: Verify the suite is still green**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add bookmarks-to-obsidian/scripts/import.mjs
git commit -m "refactor(import): wire scanVault and seed the content index" -m "Replaces scanVaultSources with scanVault({ content: opts.contentDedup }); remembered skipped-duplicate entries replay their duplicateOf pointer."
```

---

### Task 10: `import.mjs` — three-phase pipeline (extract → reconcile → write)

**Files:**
- Modify: `bookmarks-to-obsidian/scripts/import.mjs` — imports (add fingerprint + reconcile), step-6 region (replace the single `mapPool`), and the `report.meta` block.

This is one atomic refactor: it must land together or `import.mjs` will not run. Show all the code below.

- [ ] **Step 1: Add the fingerprint + reconcile imports**

After the `import { downloadImages } ...` / `import { looksLikeShell } ...` lines, add:

```js
import { fingerprint } from './src/fingerprint.mjs';
import { reconcile } from './src/reconcile.mjs';
```

- [ ] **Step 2: Replace the step-6 region**

Replace the entire block that starts at the comment `// 6. Render → pick-the-better-vs-fetch → harvest images → write.` and ends at the closing `});` of that `await mapPool(within, poolSize, async ({ bm, norm, slot }) => { ... });` call with the following three stages:

```js
  // 6. Phase A: EXTRACT (parallel) → pick winner → fingerprint. Terminal
  //    failures (failed / binary / thin) settle straight into the report here.
  const poolSize = browser ? opts.renderConcurrency : opts.concurrency;
  const candidates = [];
  let settled = 0;

  await mapPool(within, poolSize, async ({ bm, norm, slot }) => {
    let host = '';
    try { host = new URL(bm.url).host; } catch { /* keep '' */ }

    // --- 1. Render candidate. ---
    let rendered = null;
    if (browser) {
      const r = await renderPage(browser, bm.url, {
        navTimeoutMs: 25000,
        dismissConsent: opts.dismissConsent,
      });
      if (r.status === 'ok') {
        const md = r.content || '';
        rendered = {
          markdown: md,
          wordCount: r.wordCount || 0,
          meta: r,
          images: r.images,
          shell: looksLikeShell(md, { minWords: opts.minWords }),
        };
      }
    }
    const renderGood = rendered && rendered.wordCount >= opts.minWords && !rendered.shell;

    // --- 2. Fetch candidate, only when the render isn't already good. ---
    let fetched = null;
    let fetchOutcome = null;
    if (!renderGood) {
      const f = await fetchPage(bm.url, { timeoutMs: 20000 });
      if (f.status === 'ok') {
        const ex = await extractFromHtml(f.html, bm.url, { minWords: opts.minWords });
        const md = ex.content || '';
        fetched = {
          markdown: md,
          wordCount: ex.wordCount || 0,
          meta: ex.meta,
          shell: looksLikeShell(md, { minWords: opts.minWords }),
        };
      } else {
        fetchOutcome = f;
      }
    }

    // --- 3. Pick the better: disqualify shell/thin, longest wins, render breaks ties. ---
    const cands = [];
    if (rendered) cands.push({ ...rendered, path: 'rendered' });
    if (fetched) cands.push({ ...fetched, path: 'fetched-fallback' });
    const qualified = cands.filter((c) => c.wordCount >= opts.minWords && !c.shell);
    qualified.sort((a, b) => (b.wordCount - a.wordCount) || (a.path === 'rendered' ? -1 : 1));
    const winner = qualified[0] || null;

    if (!winner) {
      settled += 1;
      if (fetchOutcome && fetchOutcome.status === 'failed') {
        outcomes[slot] = { url: bm.url, title: bm.title, status: 'failed', reason: fetchOutcome.reason, path: 'fetched-fallback' };
        manifest[norm] = { bookmarkId: bm.id, status: 'failed', reason: fetchOutcome.reason, at: created };
        process.stderr.write(`[A ${settled}/${within.length}] failed  ${bm.title || host}\n`);
        return;
      }
      if (fetchOutcome && fetchOutcome.status === 'skipped-binary') {
        outcomes[slot] = { url: bm.url, title: bm.title, status: 'skipped-binary', reason: fetchOutcome.reason, path: 'fetched-fallback' };
        manifest[norm] = { bookmarkId: bm.id, status: 'skipped-binary', reason: fetchOutcome.reason, at: created };
        process.stderr.write(`[A ${settled}/${within.length}] binary  ${bm.title || host}\n`);
        return;
      }
      const wc = (rendered && rendered.wordCount) || (fetched && fetched.wordCount) || 0;
      const reason = `wordCount ${wc} < ${opts.minWords}` + ((rendered && rendered.shell) || (fetched && fetched.shell) ? ' (shell)' : '');
      const path = rendered ? 'rendered' : 'fetched-fallback';
      outcomes[slot] = { url: bm.url, title: bm.title, status: 'skipped-thin', reason, path };
      manifest[norm] = { bookmarkId: bm.id, status: 'skipped-thin', reason, at: created };
      process.stderr.write(`[A ${settled}/${within.length}] thin    ${bm.title || host}\n`);
      return;
    }

    // Winner: fingerprint it (skipped when content dedup is off) and queue it.
    const title = (winner.meta && winner.meta.title) || bm.title || host || 'untitled';
    candidates.push({
      bm,
      norm,
      slot,
      title,
      markdown: winner.markdown,
      wordCount: winner.wordCount,
      metaSource: winner.meta,
      pathTaken: winner.path,
      capturedBytes: winner.path === 'rendered' ? winner.images : new Map(),
      fingerprint: opts.contentDedup ? fingerprint(title, winner.markdown) : null,
    });
  });

  // 6b. RECONCILE (serial, slot order): classify each candidate against the index.
  const decisions = reconcile(candidates, contentIndex, {
    distance: opts.dupDistance,
    existingNames,
    dedup: opts.contentDedup,
  });
  const accepted = decisions.filter((d) => d.action === 'accept');

  // Auto-skipped duplicates settle into the report + manifest (no note, no images).
  for (const d of decisions) {
    if (d.action !== 'skip') continue;
    const { candidate: c, verdict } = d;
    const reason = verdict.verdict === 'exact'
      ? 'exact content'
      : `near-duplicate (dist ${verdict.distance})`;
    outcomes[c.slot] = { url: c.bm.url, title: c.title, status: 'skipped-duplicate', reason, duplicateOf: verdict.duplicateOf };
    manifest[c.norm] = { bookmarkId: c.bm.id, status: 'skipped-duplicate', reason, duplicateOf: verdict.duplicateOf, at: created };
    process.stderr.write(`dup ${verdict.verdict.padEnd(5)} ${c.title} -> ${verdict.duplicateOf}\n`);
  }

  // 6c. Phase B: WRITE (parallel) — download images → write note → manifest entry.
  let written = 0;
  await mapPool(accepted, poolSize, async (d) => {
    const { candidate: c, filename, verdict } = d;
    let markdown = c.markdown;

    let images = { downloaded: 0, remote: 0, dropped: 0 };
    if (!opts.dryRun) {
      images = await downloadImages(markdown, {
        baseUrl: c.bm.url,
        slug: filename.replace(/\.md$/i, ''),
        attachDir,
        capturedBytes: c.capturedBytes,
        takenNames: attachTaken,
      });
      markdown = images.markdown;
    }

    const body = buildFrontmatter({
      title: c.title,
      source: c.bm.url,
      authors: splitAuthors(c.metaSource && c.metaSource.author),
      published: normalizeDate(c.metaSource && c.metaSource.published),
      description: (c.metaSource && c.metaSource.description) || '',
      created,
    }) + `\n${markdown}\n`;

    if (!opts.dryRun) await writeNoteFile(join(inboxAbs, filename), body);

    written += 1;
    const possibleDuplicateOf = verdict.verdict === 'flag' ? verdict.possibleDuplicateOf : undefined;
    outcomes[c.slot] = {
      url: c.bm.url,
      title: c.title,
      status: 'imported',
      file: filename,
      wordCount: c.wordCount,
      path: c.pathTaken,
      images: { downloaded: images.downloaded, remote: images.remote, dropped: images.dropped },
      possibleDuplicateOf,
      dryRun: opts.dryRun || undefined,
    };
    manifest[c.norm] = {
      bookmarkId: c.bm.id,
      status: 'imported',
      file: filename,
      ...(c.fingerprint
        ? { titleKey: c.fingerprint.titleKey, bodyHash: c.fingerprint.bodyHash, simhash: c.fingerprint.simhash, wordCount: c.wordCount }
        : {}),
      at: created,
    };
    process.stderr.write(`[B ${written}/${accepted.length}] ${c.pathTaken === 'rendered' ? 'render ' : 'fetch  '} ${c.title}\n`);
  });
```

- [ ] **Step 3: Verify the CLI loads**

Run: `node --check bookmarks-to-obsidian/scripts/import.mjs`
Expected: no output (syntax OK).

Run: `node bookmarks-to-obsidian/scripts/import.mjs --help`
Expected: usage prints, no runtime error.

- [ ] **Step 4: Verify the full suite is green**

Run: `npm test`
Expected: PASS — the pure modules backing this refactor (`fingerprint`, `content-index`, `reconcile`, `dedup`) are all covered.

- [ ] **Step 5: Commit**

```sh
git add bookmarks-to-obsidian/scripts/import.mjs
git commit -m "feat(import): three-phase extract/reconcile/write pipeline" -m "Phase A extracts + fingerprints in parallel and settles terminal failures; a serial slot-ordered reconcile classifies candidates (earliest bookmark wins) and emits skipped-duplicate; Phase B writes only accepted notes, so a detected duplicate costs zero downloads/writes. Imported manifest entries carry titleKey/bodyHash/simhash."
```

---

### Task 11: `import.mjs` — `report.meta.dedup` summary block

**Files:**
- Modify: `bookmarks-to-obsidian/scripts/import.mjs` — the `report.meta = { ... }` assembly.

- [ ] **Step 1: Add the dedup block to `report.meta`**

Immediately after the `report.meta = { ... };` assignment (before `process.stdout.write(...)`), add:

```js
  report.meta.dedup = {
    enabled: opts.contentDedup,
    distance: opts.dupDistance,
    skippedExact: outcomes.filter((o) => o && o.status === 'skipped-duplicate' && o.reason === 'exact content').length,
    skippedNear: outcomes.filter((o) => o && o.status === 'skipped-duplicate' && /^near-duplicate/.test(o.reason || '')).length,
    flagged: outcomes.filter((o) => o && o.status === 'imported' && o.possibleDuplicateOf).length,
  };
```

(Counts are derived from this run's detections; a *remembered* `skipped-duplicate` has `reason: 'remembered'` and is intentionally not counted here.)

- [ ] **Step 2: Verify the CLI loads**

Run: `node --check bookmarks-to-obsidian/scripts/import.mjs`
Expected: no output.

- [ ] **Step 3: Verify the suite is green**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Manual acceptance — live dry-run (requires the gateway up)**

This is the only end-to-end check; the gateway/Chrome cannot be unit-tested. If the stack is up (`curl -sS http://localhost:3000/syncz` → `{"ok":true}`), run a dry-run and read `meta.dedup` in the JSON report:

```
node bookmarks-to-obsidian/scripts/import.mjs --vault "<config.vault>" --folder "Mobile Lesezeichen/AI" --dry-run --limit 10
```

Expected: report `summary` includes a `skipped-duplicate` count; `meta.dedup` is present with `enabled: true`, `distance: 6`. If the gateway is down, note this step as **deferred to the user** rather than claiming it passed.

- [ ] **Step 5: Commit**

```sh
git add bookmarks-to-obsidian/scripts/import.mjs
git commit -m "feat(import): report meta.dedup counts" -m "meta.dedup carries { enabled, distance, skippedExact, skippedNear, flagged } derived from this run's outcomes."
```

---

### Task 12: `SKILL.md` — document statuses, flags, and the summary step

**Files:**
- Modify: `bookmarks-to-obsidian/SKILL.md` — Report statuses table, Flags, Workflow step 4.

- [ ] **Step 1: Add the status row**

In the **Report statuses** table, add a row after the `skipped-binary` row:

```
| `skipped-duplicate` | a new note whose content matches one already in the vault/run; not written (`duplicateOf` points at the canonical note) |
```

- [ ] **Step 2: Document the flags**

In the **Flags** paragraph, add `--dup-distance N` and `--no-content-dedup` to the list, and append a sentence:

```
`--dup-distance N` tunes the near-duplicate SimHash threshold (default 6);
`--no-content-dedup` turns the content layer off, leaving URL dedup only.
```

- [ ] **Step 3: Update Workflow step 4 (summarize)**

Extend Workflow step 4 so the operator surfaces dedup results. Append to that step:

```
Also surface `meta.dedup`: e.g. "3 collapsed as duplicates — 2 exact, 1 near —
and 1 flagged for review". List any items carrying `possibleDuplicateOf` (a
title clash with distinct content, imported with a ` (2)` filename) so the user
can eyeball them.
```

- [ ] **Step 4: Verify the skill still ships clean (no dev artifacts leaked in)**

Run: `npx vitest run` (sanity — docs change shouldn't affect tests)
Expected: PASS.

Visually confirm `bookmarks-to-obsidian/SKILL.md` reads correctly and the table/flags render.

- [ ] **Step 5: Commit**

```sh
git add bookmarks-to-obsidian/SKILL.md
git commit -m "docs(skill): document skipped-duplicate, dedup flags, and summary" -m "Adds the skipped-duplicate status row, --dup-distance/--no-content-dedup flags, and a step-4 instruction to surface meta.dedup counts and possibleDuplicateOf flags."
```

---

### Task 13: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS — all of `fingerprint`, `content-index`, `reconcile`, `dedup.scan`, `report`, plus the pre-existing suite (`url`, `note`, `extract`, `images`, `frontmatter`, `gateway`, `shell`, bootstrap, render) green.

- [ ] **Step 2: Syntax-check the CLI entry point**

Run: `node --check bookmarks-to-obsidian/scripts/import.mjs`
Expected: no output.

- [ ] **Step 3: Confirm no dev artifacts leaked into the skill folder**

Run: `git status`
Expected: only the intended runtime files under `bookmarks-to-obsidian/scripts/src/` and `SKILL.md` changed there; all tests live under root `test/`; the skill's `package.json` is untouched (no devDependencies added). The new modules introduce **no** new runtime dependencies.

- [ ] **Step 4: Spec coverage spot-check**

Confirm against `specs/2026-06-14-importer-content-dedup-design.md`: `fingerprint.mjs` (titleKey/normalizeBody/bodyHash/simhash/hamming/fingerprint) ✓; content index (byHash/byTitle, exact/near/flag/unique) ✓; serial slot-ordered reconcile ✓; `scanVault` content index ✓; `skipped-duplicate` status + `duplicateOf` + `possibleDuplicateOf` ✓; manifest fingerprint fields + remembered replay ✓; `meta.dedup` ✓; `--dup-distance` / `--no-content-dedup` ✓; SKILL.md docs ✓; dry-run writes nothing ✓ (Phase B guards on `opts.dryRun`).

---

## Self-Review Notes (for the plan author — already applied)

- **Spec coverage:** every Decisions-table row maps to a task — detection strength (Task 4/5), Approach A signal (Task 1–3), prevention-only scope (no audit task, by design), URL dedup unchanged (Task 9 keeps `vaultSet.has`), `skipped-duplicate`+`duplicateOf` (Task 6/10), flag+`possibleDuplicateOf` (Task 10), determinism via reconcile (Task 5/10), escape hatches (Task 8). Edge cases — dry-run (Task 10 Phase B guard), two new exact-dups (Task 5 cluster test), no-frontmatter/empty-title fallbacks (Task 1 + Task 7 `title || base`), flagged coexistence (Task 5/10), `--no-content-dedup` (Task 5/7/9/10), gateway error contract unchanged (untouched).
- **Type consistency:** verdict objects use `{ verdict, duplicateOf?, distance?, possibleDuplicateOf? }` consistently across `content-index.mjs`, `reconcile.mjs`, and `import.mjs`. `content.add({ file, titleKey, bodyHash, simhash })` and `fingerprint()` returning `{ titleKey, bodyHash, simhash, wordCount }` line up. `scanVault` returns `{ urls, content }` and `import.mjs` destructures exactly that.
- **Placeholder scan:** every code step shows complete code; no TBD/"handle errors"/"similar to" references.
- **Determinism caveat noted:** filename `(N)` assignment now happens in the serial reconcile (slot order) rather than render-completion order — a deliberate improvement that holds in both dedup-on and `--no-content-dedup` modes.
