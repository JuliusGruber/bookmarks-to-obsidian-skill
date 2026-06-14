# Selectable Bookmark Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After invoking the skill, show the user the genuinely-new bookmarks and let them keep/skip each one in chat before anything is rendered or written; remember skipped ("declined") bookmarks durably so they never reappear until reset.

**Architecture:** Keep the "thin operator + deterministic CLI" shape. Extract the importer's classification logic into a **pure** `classifyBookmarks()` (plus four small pure helpers) in a new `src/classify.mjs`, so "new" is defined in exactly one place. Add three read-/write-scoped CLI modes to `import.mjs` — `--list` (classify → JSON, read-only), `--import-ids`/`--decline-ids` (id-scoped render + manifest decline), and `--reset-declined` (clear declines) — leaving the existing no-flag "import everything" path behavior-identical. Claude runs the one-by-one keep/skip walk in chat between the `--list` call and the `--import-ids … --decline-ids …` call.

**Tech Stack:** Node ESM (`.mjs`), `node:fs/promises`, `node:path`, `node:url`. Tests: vitest at the repo root, importing from `../bookmarks-to-obsidian/scripts/src/`. No new runtime dependencies.

---

## Design decision: a pure classifier, IO stays in `import.mjs`

The spec sketches `classifyBookmarks()` as also doing folder resolution + `scanVault`. This plan instead makes `classifyBookmarks()` (and its helpers) **pure** — they take already-collected `bookmarks`, a `vaultSet`, and a `manifest` and return data only. Folder resolution, `scanVault`, and manifest read/write stay in `import.mjs`, the one file that touches the network and filesystem. This matches how the rest of the codebase is structured (`fingerprint`/`content-index`/`reconcile` are pure, IO lives in `import.mjs`) and makes the entire spec "Testing (TDD)" list satisfiable with fast unit tests and no gateway. The single definition of "new" still lives in exactly one place: `classifyBookmarks()`.

## Interaction with the shipped content-dedup importer

This builds on the three-phase `extract → reconcile → write` importer (`specs/2026-06-14-importer-content-dedup-design.md`, already shipped). Two consequences honored throughout:

1. **Selection is URL-scoped; dedup is content-scoped.** `classifyBookmarks()` dedups on URL + manifest only. A kept id can still settle as `skipped-duplicate` after render. The walk copy and summary must never promise "N kept = N imported."
2. **`--list` skips the content index.** `--list` calls `scanVault(vault, { content: false })` (URLs only). The import path keeps `{ content: true }` and hands `contentIndex` to the reconcile phase, unchanged.

---

## File Structure

**New runtime module** (under `bookmarks-to-obsidian/scripts/src/`):

- `classify.mjs` — pure classification + id-scoped selection helpers, no IO:
  - `classifyBookmarks(bookmarks, { vaultSet, manifest, retryFailed })` → `{ newItems, decided, existingCount, declinedCount }`
  - `buildListPayload(classification, meta)` → the `--list` JSON object
  - `partitionIds(importIds, declineIds)` → `{ importSet, declineSet }` (import wins on overlap)
  - `buildDeclineEntries(ids, bookmarks, at)` → `{ entries, declined, unknownIds }`
  - `clearDeclined(manifest)` → `{ manifest, cleared }`

**New tests** (under root `test/`):

- `test/classify.test.mjs` — `classifyBookmarks`
- `test/classify.helpers.test.mjs` — `buildListPayload`, `partitionIds`, `buildDeclineEntries`, `clearDeclined`

**Modified files:**

- `bookmarks-to-obsidian/scripts/import.mjs` — new flags; `--reset-declined`, `--list`, and id-scoped modes; core classification refactored onto `classifyBookmarks`; `report.meta.declined` / `report.meta.notes`.
- `bookmarks-to-obsidian/SKILL.md` — the list → walk → import workflow, new flags, kept-≠-imported summary.

**Boundaries:** the classification *decision* (`classify.mjs`) is pure and fully unit-tested. `import.mjs` is the only file that touches the gateway/filesystem and is verified by `node --check`, the suite, `--help`, and manual gateway runs (deferred to the user if the stack is down). `report.mjs`'s `STATUSES` is **not** changed — a decline is a user decision recorded in the manifest, surfaced via `report.meta.declined`, not a content-processing outcome.

---

### Task 1: `classify.mjs` — the pure `classifyBookmarks()`

**Files:**
- Create: `bookmarks-to-obsidian/scripts/src/classify.mjs`
- Test: `test/classify.test.mjs`

- [x] **Step 1: Write the failing test**

Create `test/classify.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { classifyBookmarks } from '../bookmarks-to-obsidian/scripts/src/classify.mjs';

const BM = (id, url, title) => ({ id, url, title });

describe('classifyBookmarks', () => {
  it('marks a bookmark new when it is in neither the vault nor the manifest', () => {
    const bookmarks = [BM('1', 'https://arxiv.org/abs/1706.03762', 'Attention Is All You Need')];
    const { newItems, existingCount, declinedCount } = classifyBookmarks(bookmarks, {
      vaultSet: new Set(),
      manifest: {},
    });
    expect(newItems).toEqual([
      {
        id: '1',
        title: 'Attention Is All You Need',
        url: 'https://arxiv.org/abs/1706.03762',
        domain: 'arxiv.org',
        norm: 'https://arxiv.org/abs/1706.03762',
        slot: 0,
      },
    ]);
    expect(existingCount).toBe(0);
    expect(declinedCount).toBe(0);
  });

  it('records an empty domain for an unparseable URL', () => {
    const { newItems } = classifyBookmarks([BM('1', 'not a url', 'X')], { vaultSet: new Set(), manifest: {} });
    expect(newItems[0].domain).toBe('');
  });

  it('excludes a URL already in the vault and counts it as existing', () => {
    const { newItems, existingCount } = classifyBookmarks([BM('1', 'https://example.com/a', 'A')], {
      vaultSet: new Set(['https://example.com/a']),
      manifest: {},
    });
    expect(newItems).toEqual([]);
    expect(existingCount).toBe(1);
  });

  it('excludes a declined manifest entry, counts it as declined, and never shows it', () => {
    const manifest = { 'https://example.com/declined': { bookmarkId: '9', status: 'declined', at: '2026-06-13' } };
    const out = classifyBookmarks([BM('9', 'https://example.com/declined', 'Declined One')], {
      vaultSet: new Set(),
      manifest,
    });
    expect(out.newItems).toEqual([]);
    expect(out.declinedCount).toBe(1);
    expect(out.existingCount).toBe(0);
  });

  it('keeps a declined entry hidden even under --retry-failed', () => {
    const manifest = { 'https://example.com/declined': { bookmarkId: '9', status: 'declined', at: '2026-06-13' } };
    const out = classifyBookmarks([BM('9', 'https://example.com/declined', 'Declined One')], {
      vaultSet: new Set(),
      manifest,
      retryFailed: true,
    });
    expect(out.newItems).toEqual([]);
    expect(out.declinedCount).toBe(1);
  });

  it('treats a remembered imported entry as existing (not new)', () => {
    const manifest = {
      'https://example.com/done': { bookmarkId: '3', status: 'imported', file: 'Done.md', at: '2026-06-13' },
    };
    const out = classifyBookmarks([BM('3', 'https://example.com/done', 'Done')], { vaultSet: new Set(), manifest });
    expect(out.newItems).toEqual([]);
    expect(out.existingCount).toBe(1);
    expect(out.decided[0]).toMatchObject({ id: '3', status: 'skipped-existing', reason: 'remembered', file: 'Done.md' });
  });

  it('rejoins failed/skipped-thin entries as new only under --retry-failed', () => {
    const manifest = {
      'https://example.com/failed': { bookmarkId: '1', status: 'failed', at: '2026-06-13' },
      'https://example.com/thin': { bookmarkId: '2', status: 'skipped-thin', at: '2026-06-13' },
    };
    const bookmarks = [BM('1', 'https://example.com/failed', 'F'), BM('2', 'https://example.com/thin', 'T')];

    const without = classifyBookmarks(bookmarks, { vaultSet: new Set(), manifest, retryFailed: false });
    expect(without.newItems).toEqual([]); // remembered, hidden

    const withRetry = classifyBookmarks(bookmarks, { vaultSet: new Set(), manifest, retryFailed: true });
    expect(withRetry.newItems.map((i) => i.id)).toEqual(['1', '2']);
  });

  it('collapses a within-run duplicate URL (second occurrence is existing)', () => {
    const bookmarks = [
      BM('1', 'https://example.com/x?utm_source=a', 'X'),
      BM('2', 'https://example.com/x', 'X again'),
    ];
    const out = classifyBookmarks(bookmarks, { vaultSet: new Set(), manifest: {} });
    expect(out.newItems.map((i) => i.id)).toEqual(['1']);
    expect(out.existingCount).toBe(1);
    expect(out.decided[0]).toMatchObject({ status: 'skipped-existing', reason: 'duplicate in run' });
  });

  it('preserves bookmark order and slot indices', () => {
    const bookmarks = [
      BM('1', 'https://example.com/in-vault', 'A'),
      BM('2', 'https://example.com/new', 'B'),
    ];
    const out = classifyBookmarks(bookmarks, {
      vaultSet: new Set(['https://example.com/in-vault']),
      manifest: {},
    });
    expect(out.decided[0].slot).toBe(0);
    expect(out.newItems[0].slot).toBe(1);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/classify.test.mjs`
Expected: FAIL — `Failed to resolve import` (module `classify.mjs` does not exist).

- [x] **Step 3: Write the minimal implementation**

Create `bookmarks-to-obsidian/scripts/src/classify.mjs`:

```js
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
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/classify.test.mjs`
Expected: PASS (new/vault/declined/retry/remembered/within-run-dup/order all green).

- [x] **Step 5: Commit**

```sh
git add bookmarks-to-obsidian/scripts/src/classify.mjs test/classify.test.mjs
git commit -m "feat(classify): pure classifyBookmarks (new vs decided vs declined)" -m "Extracts the importer's URL/manifest dedup into one pure function. A declined manifest entry is hidden and counted (sticky even under --retry-failed); failed/skipped-thin rejoin new under --retry-failed; every bookmark partitions into newItems / decided / declined by slot."
```

---

### Task 2: `classify.mjs` — `buildListPayload`, `partitionIds`, `buildDeclineEntries`, `clearDeclined`

**Files:**
- Modify: `bookmarks-to-obsidian/scripts/src/classify.mjs`
- Test: `test/classify.helpers.test.mjs`

- [x] **Step 1: Write the failing test**

Create `test/classify.helpers.test.mjs`:

```js
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
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/classify.helpers.test.mjs`
Expected: FAIL — `buildListPayload is not a function` (only `classifyBookmarks` is exported so far).

- [x] **Step 3: Write the minimal implementation**

Append to `bookmarks-to-obsidian/scripts/src/classify.mjs`:

```js
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
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/classify.helpers.test.mjs`
Expected: PASS (payload shape, import-wins, decline entries + unknown ids, clear-declined all green).

- [x] **Step 5: Commit**

```sh
git add bookmarks-to-obsidian/scripts/src/classify.mjs test/classify.helpers.test.mjs
git commit -m "feat(classify): list payload, id partition, decline + reset helpers" -m "buildListPayload shapes the --list JSON; partitionIds makes import win over decline; buildDeclineEntries keys declined records by normalized URL and reports unknown ids; clearDeclined removes only declined entries."
```

---

### Task 3: `import.mjs` — add the new flags

**Files:**
- Modify: `bookmarks-to-obsidian/scripts/import.mjs:32-56` (HELP), `:58-104` (parseArgs + a new `parseIdList` helper)

- [x] **Step 1: Add the flags to the HELP text**

In the `HELP` template, under `Options:`, add these four lines immediately after the `--retry-failed` line:

```
  --list                 Classify only: print { new[], counts } as JSON, then exit (read-only).
  --import-ids <id,…>    Import only the bookmarks whose ids are in this comma-separated set.
  --decline-ids <id,…>   Record these bookmark ids as declined (hidden from future syncs).
  --reset-declined       Remove every declined manifest entry, report the count, and exit.
```

- [x] **Step 2: Add the defaults to the `opts` object**

In `parseArgs`, add four fields to the `opts` literal, immediately after `retryFailed: false,`:

```js
    list: false,
    importIds: null,
    declineIds: null,
    resetDeclined: false,
```

- [x] **Step 3: Add the parse cases**

In the `switch (a)` block, add four cases immediately after the `case '--retry-failed':` line:

```js
      case '--list': opts.list = true; break;
      case '--import-ids': opts.importIds = parseIdList(next()); break;
      case '--decline-ids': opts.declineIds = parseIdList(next()); break;
      case '--reset-declined': opts.resetDeclined = true; break;
```

- [x] **Step 4: Add the `parseIdList` helper**

Immediately after the `parseArgs` function (before `function todayISO()`), add:

```js
function parseIdList(s) {
  return String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}
```

- [x] **Step 5: Verify the CLI loads and help shows the flags**

Run: `node bookmarks-to-obsidian/scripts/import.mjs --help`
Expected: usage prints, including the four new option lines. No error.

- [x] **Step 6: Commit**

```sh
git add bookmarks-to-obsidian/scripts/import.mjs
git commit -m "feat(import): add --list, --import-ids, --decline-ids, --reset-declined flags" -m "Defaults: list off, importIds/declineIds null, resetDeclined off. parseIdList splits a comma-separated id list. Flags are parsed but not yet wired into the pipeline."
```

---

### Task 4: `import.mjs` — wire the `classify.mjs` import and the `--reset-declined` mode

**Files:**
- Modify: `bookmarks-to-obsidian/scripts/import.mjs:19-30` (imports), `:139-140` (insert the reset short-circuit before the folder requirement)

`--reset-declined` is a pure local manifest op: no gateway, no folder. It short-circuits before the gateway health check.

- [x] **Step 1: Add the `classify.mjs` import**

After the existing `import { reconcile } from './src/reconcile.mjs';` line, add:

```js
import {
  classifyBookmarks,
  buildListPayload,
  partitionIds,
  buildDeclineEntries,
  clearDeclined,
} from './src/classify.mjs';
```

(Only `clearDeclined` is used in this task; the others are wired in Tasks 5–6.)

- [x] **Step 2: Insert the reset short-circuit**

In `main()`, the required-args checks currently read:

```js
  if (!opts.vault) fail('missing-vault', 'Pass --vault <path>.');
  if (!opts.folder) fail('missing-folder', 'Pass --folder "<name or path>".');
```

Replace that pair with:

```js
  if (!opts.vault) fail('missing-vault', 'Pass --vault <path>.');

  // --reset-declined: pure local manifest op — no gateway, no folder required.
  if (opts.resetDeclined) {
    const vaultAbs0 = isAbsolute(opts.vault) ? opts.vault : resolve(opts.vault);
    const manifestPath0 = join(vaultAbs0, opts.inbox, '.import-state.json');
    const manifest0 = await readManifest(manifestPath0);
    const { cleared } = clearDeclined(manifest0);
    if (cleared) await writeManifest(manifestPath0, manifest0);
    process.stdout.write(`${JSON.stringify({
      mode: 'reset-declined',
      cleared,
      meta: { vault: vaultAbs0, inbox: opts.inbox, generatedAt: todayISO() },
    }, null, 2)}\n`);
    return;
  }

  if (!opts.folder) fail('missing-folder', 'Pass --folder "<name or path>".');
```

- [x] **Step 3: Verify the CLI loads**

Run: `node --check bookmarks-to-obsidian/scripts/import.mjs`
Expected: no output (syntax OK).

Run: `node bookmarks-to-obsidian/scripts/import.mjs --help`
Expected: usage prints, no runtime error from the import.

- [x] **Step 4: Verify the reset path end-to-end against a throwaway manifest**

The reset path touches no gateway, so it can be exercised directly. Run:

```sh
node -e "const fs=require('node:fs'); const d=fs.mkdtempSync(require('node:os').tmpdir()+'/b2o-'); fs.mkdirSync(d+'/Clippings'); fs.writeFileSync(d+'/Clippings/.import-state.json', JSON.stringify({'https://a':{status:'declined'},'https://b':{status:'imported'}})); console.log('VAULT='+d);"
```

Copy the printed `VAULT=` path, then:

```sh
node bookmarks-to-obsidian/scripts/import.mjs --reset-declined --vault "<that path>"
```

Expected: prints `{ "mode": "reset-declined", "cleared": 1, ... }`. A second run prints `"cleared": 0` (idempotent no-op). Delete the temp dir afterward.

- [x] **Step 5: Verify the suite is still green**

Run: `npm test`
Expected: PASS (no test imports `import.mjs`; the new `import` line resolves).

- [x] **Step 6: Commit**

```sh
git add bookmarks-to-obsidian/scripts/import.mjs
git commit -m "feat(import): --reset-declined clears declined manifest entries" -m "Pure local manifest op: short-circuits before the gateway health check and folder requirement, requires only --vault, and emits { mode:'reset-declined', cleared }. No-op (cleared 0) when there are none."
```

---

### Task 5: `import.mjs` — the read-only `--list` mode

**Files:**
- Modify: `bookmarks-to-obsidian/scripts/import.mjs` — insert a `--list` short-circuit after the folder resolves (after the step-2 `try/catch`, before `// 3. Dedup state:`).

- [x] **Step 1: Insert the list short-circuit**

The step-2 folder resolution ends with its `catch` block, immediately followed by the step-3 comment:

```js
  } catch (e) {
    fail('folder-resolution-failed', e.message);
    return;
  }

  // 3. Dedup state: vault scan (truth) + manifest (provenance/fast path).
```

Insert the list mode between them, so it reads:

```js
  } catch (e) {
    fail('folder-resolution-failed', e.message);
    return;
  }

  // --list: read-only classification. URL-only scan (skip the unused content index).
  if (opts.list) {
    const { urls: vaultSet } = await scanVault(vaultAbs, { content: false });
    const manifest = await readManifest(manifestPath);
    const classification = classifyBookmarks(bookmarks, { vaultSet, manifest, retryFailed: opts.retryFailed });
    process.stdout.write(`${JSON.stringify(buildListPayload(classification, {
      folder: folderName,
      folderSpec: opts.folder,
      vault: vaultAbs,
      inbox: opts.inbox,
      generatedAt: created,
    }), null, 2)}\n`);
    return;
  }

  // 3. Dedup state: vault scan (truth) + manifest (provenance/fast path).
```

(`vaultAbs`, `manifestPath`, and `created` are computed earlier in `main()`; `scanVault`, `readManifest`, `classifyBookmarks`, and `buildListPayload` are all imported.)

- [x] **Step 2: Verify the CLI loads**

Run: `node --check bookmarks-to-obsidian/scripts/import.mjs`
Expected: no output.

Run: `node bookmarks-to-obsidian/scripts/import.mjs --help`
Expected: usage prints, no runtime error.

- [x] **Step 3: Verify the suite is still green**

Run: `npm test`
Expected: PASS.

- [x] **Step 4: Manual acceptance — live `--list` (requires the gateway up)**

`--list` needs the bookmark tree, so it can only run end-to-end with the stack up. If `curl -sS http://localhost:3000/syncz` returns `{"ok":true}`, run:

```sh
node bookmarks-to-obsidian/scripts/import.mjs --list --vault "<config.vault>" --folder "Mobile Lesezeichen/AI"
```

Expected: JSON with `"mode": "list"`, `meta.counts` `{ new, existing, declined }`, and a `new[]` array of `{ id, title, url, domain }` in bookmark order. **No** notes written and **no** manifest mutation (re-run and confirm `meta.counts` is unchanged). If the gateway is down, record this step as **deferred to the user** rather than claiming it passed.

> Verified 2026-06-14 with the gateway up (`/syncz` → `{"ok":true}`). `--list` over
> the live vault returned `mode: "list"`, `meta.counts: { new: 0, existing: 232,
> declined: 0 }`, an empty `new[]`, and the manifest SHA-256 was identical before/after
> (read-only confirmed). `new[]` was empty (nothing new in the vault), so a populated
> element's `{id,title,url,domain}` shape was not observed live — that shape is covered
> by the `buildListPayload` unit test.

- [x] **Step 5: Commit**

```sh
git add bookmarks-to-obsidian/scripts/import.mjs
git commit -m "feat(import): --list emits new[] + counts as JSON (read-only)" -m "Runs health-check + folder resolve + classifyBookmarks over a content:false vault scan, prints the list payload, and exits. No render, no writes, no manifest mutation."
```

---

### Task 6: `import.mjs` — refactor the core onto `classifyBookmarks` and add the id-scoped mode

**Files:**
- Modify: `bookmarks-to-obsidian/scripts/import.mjs` — replace the step-4 classify loop + step-5 limit block (`:176-209`); change `buildReport(outcomes)` to `buildReport(outcomes.filter(Boolean))`; add `report.meta.declined` / `report.meta.notes`.

This is one atomic refactor: the default path is rebuilt on `classifyBookmarks` (behavior-identical to today) and the id-scoped `--import-ids`/`--decline-ids` path is added in the same region. It must land together or `import.mjs` will not run. The render/reconcile/write region (Phase A/6b/Phase B) is unchanged — it still consumes `within` and writes into `outcomes[slot]`.

- [x] **Step 1: Replace the classify + limit region**

Replace this entire block (the step-4 loop through the end of the step-5 limit block):

```js
  // 4. Classify each bookmark into already-decided vs. to-process.
  const outcomes = []; // final report items, in bookmark order
  const toProcess = []; // { bm, norm, slot } slot = index into outcomes
  const seen = new Set();
  for (const bm of bookmarks) {
    const norm = normalizeUrl(bm.url);
    const slot = outcomes.length;
    if (seen.has(norm)) {
      outcomes.push({ url: bm.url, title: bm.title, status: 'skipped-existing', reason: 'duplicate in run' });
      continue;
    }
    seen.add(norm);
    if (vaultSet.has(norm)) {
      outcomes.push({ url: bm.url, title: bm.title, status: 'skipped-existing', reason: 'already in vault' });
      continue;
    }
    const m = manifest[norm];
    const retryable = m && (m.status === 'failed' || m.status === 'skipped-thin');
    if (m && !(opts.retryFailed && retryable)) {
      const status = m.status === 'imported' ? 'skipped-existing' : m.status;
      outcomes.push({ url: bm.url, title: bm.title, status, reason: 'remembered', file: m.file, duplicateOf: m.duplicateOf });
      continue;
    }
    outcomes.push({ url: bm.url, title: bm.title, status: 'pending' });
    toProcess.push({ bm, norm, slot });
  }

  // 5. Apply --limit; anything beyond it is reported, never silently dropped.
  // Dry-run renders for an honest preview; without an explicit --limit, cap it.
  const effectiveLimit = (opts.dryRun && !Number.isFinite(opts.limit)) ? 10 : opts.limit;
  const within = toProcess.slice(0, effectiveLimit);
  for (const { bm, slot } of toProcess.slice(effectiveLimit)) {
    outcomes[slot] = { url: bm.url, title: bm.title, status: 'skipped-limit', reason: `beyond --limit ${effectiveLimit}` };
  }
```

with:

```js
  // 4. Classify into new vs already-decided — the single definition of "new".
  const { newItems, decided } = classifyBookmarks(bookmarks, {
    vaultSet,
    manifest,
    retryFailed: opts.retryFailed,
  });

  // 5. Populate the report slots (bookmark order, sparse) and the work list.
  //    Two modes:
  //      - id-scoped (--import-ids/--decline-ids): exactly the kept ids; record declines.
  //      - default: all new, capped by --limit (the "import everything" escape).
  const outcomes = new Array(bookmarks.length); // sparse; filtered before report
  const idScoped = opts.importIds !== null || opts.declineIds !== null;
  let within = []; // [{ bm, norm, slot }] to render this run
  let declinedThisRun = 0;
  const notes = [];

  if (idScoped) {
    const { importSet, declineSet } = partitionIds(opts.importIds, opts.declineIds);

    // Kept ids that turned out to be already-decided (e.g. now in the vault) are
    // echoed at their slot; an item that became existing in the meantime stays skipped.
    for (const d of decided) {
      if (importSet.has(d.id)) {
        outcomes[d.slot] = { url: d.url, title: d.title, status: d.status, reason: d.reason, file: d.file, duplicateOf: d.duplicateOf };
      }
    }
    // Kept ids that are genuinely new → render them.
    for (const it of newItems) {
      if (!importSet.has(it.id)) continue;
      outcomes[it.slot] = { url: it.url, title: it.title, status: 'pending' };
      within.push({ bm: { id: it.id, title: it.title, url: it.url }, norm: it.norm, slot: it.slot });
    }
    // Kept ids that no longer exist (deleted since --list) → a note, no crash.
    const known = new Set(bookmarks.map((b) => b.id));
    for (const id of importSet) if (!known.has(id)) notes.push(`import: unknown id ${id} (skipped)`);

    // Declines: pure manifest writes, no render.
    const { entries, declined, unknownIds } = buildDeclineEntries([...declineSet], bookmarks, created);
    for (const [norm, rec] of Object.entries(entries)) manifest[norm] = rec;
    declinedThisRun = declined;
    for (const id of unknownIds) notes.push(`decline: unknown id ${id} (skipped)`);
  } else {
    for (const d of decided) {
      outcomes[d.slot] = { url: d.url, title: d.title, status: d.status, reason: d.reason, file: d.file, duplicateOf: d.duplicateOf };
    }
    const toProcess = [];
    for (const it of newItems) {
      outcomes[it.slot] = { url: it.url, title: it.title, status: 'pending' };
      toProcess.push({ bm: { id: it.id, title: it.title, url: it.url }, norm: it.norm, slot: it.slot });
    }
    // --limit: dry-run renders for an honest preview; without an explicit --limit, cap it.
    const effectiveLimit = (opts.dryRun && !Number.isFinite(opts.limit)) ? 10 : opts.limit;
    within = toProcess.slice(0, effectiveLimit);
    for (const { bm, slot } of toProcess.slice(effectiveLimit)) {
      outcomes[slot] = { url: bm.url, title: bm.title, status: 'skipped-limit', reason: `beyond --limit ${effectiveLimit}` };
    }
  }
```

- [x] **Step 2: Build the report from the dense (non-empty) slots**

The report assembly currently reads:

```js
  const report = buildReport(outcomes);
```

Change it to drop the sparse holes left by the id-scoped mode (a no-op for a default run, whose slots are all filled):

```js
  const report = buildReport(outcomes.filter(Boolean));
```

- [x] **Step 3: Add `declined` and `notes` to `report.meta`**

Immediately after the `report.meta.dedup = { ... };` block (before `process.stdout.write(...)`), add:

```js
  report.meta.declined = declinedThisRun;
  report.meta.notes = notes;
```

- [x] **Step 4: Verify the CLI loads**

Run: `node --check bookmarks-to-obsidian/scripts/import.mjs`
Expected: no output.

Run: `node bookmarks-to-obsidian/scripts/import.mjs --help`
Expected: usage prints, no runtime error.

- [x] **Step 5: Verify the suite is green**

Run: `npm test`
Expected: PASS — the pure core (`classifyBookmarks` + helpers) is unit-tested; `report.mjs`/`reconcile.mjs`/`dedup.mjs` are unchanged.

- [ ] **Step 6: Manual acceptance — live runs (require the gateway up)**

Only runnable with the stack up (`curl -sS http://localhost:3000/syncz` → `{"ok":true}`). If down, record as **deferred to the user**.

1. **Default path is behavior-preserving** — a dry-run should still render and report exactly as before this refactor:
   ```sh
   node bookmarks-to-obsidian/scripts/import.mjs --vault "<config.vault>" --folder "Mobile Lesezeichen/AI" --dry-run --limit 5
   ```
   Expected: `summary` with the usual buckets; `meta.declined: 0`, `meta.notes: []`.
2. **Id-scoped import + decline** — take two ids from a `--list` run, import one and decline the other:
   ```sh
   node bookmarks-to-obsidian/scripts/import.mjs --import-ids <idA> --decline-ids <idB> --vault "<config.vault>" --folder "Mobile Lesezeichen/AI" --dry-run
   ```
   Expected: the report covers only `idA` (imported/skipped-*), `meta.declined: 1`, and `idB` is now hidden — a follow-up `--list` shows it under `meta.counts.declined`, not `new[]`. (`--dry-run` here previews without persisting; drop it for a real decline.)
3. **Unknown id** — pass a bogus `--import-ids 999999`; expect `meta.notes` to contain `import: unknown id 999999 (skipped)` and no crash.

> **Deferred to the user (2026-06-14).** The gateway process was reachable but the
> Chrome profile was **not synced** (`GET /syncz` → 503 `{"ok":false}`, stable across
> repeated polls), so the live import path refuses to run. All three live checks
> above are deferred until Chrome sync is re-established. Everything verifiable
> offline is green: `node --check`, `--help` (shows all four flags), and the full
> 150-test suite. The id-scoped path is thin orchestration over the fully
> unit-tested pure core (`classifyBookmarks`/`partitionIds`/`buildDeclineEntries`),
> so confidence is high pending the live confirmation.

- [x] **Step 7: Commit**

```sh
git add bookmarks-to-obsidian/scripts/import.mjs
git commit -m "feat(import): id-scoped import/decline mode on a shared classifier" -m "Default path rebuilt on classifyBookmarks (behavior-identical). --import-ids renders only the kept ids; --decline-ids writes declined manifest entries (import wins on overlap); unknown/deleted ids become meta.notes, not crashes. Report is built from the dense slots and carries meta.declined + meta.notes."
```

---

### Task 7: `SKILL.md` — the list → walk → import workflow

**Files:**
- Modify: `bookmarks-to-obsidian/SKILL.md` — Overview (last lines), Workflow (steps 2–5 → 2–7), Flags.

- [x] **Step 1: Update the Overview's closing sentences**

In the **Overview** section, replace the final sentence:

```
The work is a
deterministic Node CLI; this skill is the thin operator that health-checks, runs
it, and summarizes the JSON report.
```

with:

```
The work is a
deterministic Node CLI; this skill is the thin operator that health-checks it,
lists the genuinely-new bookmarks, walks them with you one-by-one (keep/skip),
imports the ones you keep, and summarizes the JSON report. A "just import
everything" bulk escape remains for when you don't want to choose.
```

- [x] **Step 2: Replace Workflow steps 2–5 with the selection flow**

The current Workflow keeps step 1 (health-check/bootstrap) and then has steps 2–5 (dry-run, real import, parse, offer next). Replace everything from step **2** through step **5** (i.e. from `2. **First run / when unsure → dry-run first**` down to the end of step 5, just before `## Report statuses`) with:

````
2. **List the new bookmarks.** Read `vault`/`folder` from config (`--get`) and classify:
   ```
   node scripts/import.mjs --list --vault "<config.vault>" --folder "<config.folder, default Mobile Lesezeichen/AI>"
   ```
   Parse the JSON: `meta.counts` (`new` / `existing` / `declined`) and `new[]`
   (each `{ id, title, url, domain }`, in bookmark order). `--list` is read-only —
   no notes, no manifest writes.
3. **Nothing new?** If `new` is empty, tell the user "No new bookmarks" (and
   mention `meta.counts.declined` if it is > 0), then stop.
4. **Announce the count and offer a cap.** Say "N new bookmarks." Then one
   `AskUserQuestion`:
   - **Walk all N** → step 5 over every id.
   - **Walk the first 20** (or another cap) → step 5 over the first cap ids; the
     rest stay new for next time.
   - **Just import all N** → skip the walk; every id goes into the keep set; go to
     step 6.
5. **Walk one bookmark at a time.** For each new bookmark up to the cap, one
   `AskUserQuestion` showing `Title — domain — full URL` with three options:
   - **Import** → add the id to the keep set.
   - **Skip** → add the id to the decline set.
   - **Stop & finish now** → end the walk immediately; import the keep set so far.
     Undecided bookmarks are left untouched — they reappear next sync and are
     **not** declined.
6. **Execute the selection** in one call (either list may be empty):
   ```
   node scripts/import.mjs --import-ids <keep,csv> --decline-ids <skip,csv> --vault "<config.vault>" --folder "<config.folder>"
   ```
   Add `--dry-run` first if the user wants a quality preview of the kept ones.
7. **Summarize the report** in prose (never paste raw JSON):
   - Imported N → inbox, with `meta.render` (rendered vs. fetch-fallback, images
     saved vs. left remote).
   - **Kept ≠ imported:** a kept bookmark can still settle as `skipped-duplicate`
     because content dedup runs *after* render. Surface `meta.dedup` (exact/near,
     each with `duplicateOf`) and any imported note carrying `possibleDuplicateOf`.
   - `failed` / `skipped-thin` items to triage.
   - **`meta.declined`** — "M declined (hidden next time)." Any `meta.notes`
     (e.g. an id deleted between list and import) are surfaced here too.
   - Offer next: `--retry-failed`, open the inbox, or `--reset-declined` to
     un-hide every declined bookmark.
````

- [x] **Step 3: Document the new flags**

In the **Flags** section, replace the flag inventory line so it includes the new flags. Change:

```
`--vault`, `--folder`, `--inbox`, `--dry-run`, `--limit N`, `--retry-failed`,
`--min-words N`, `--concurrency N`, `--rpc-url`, `--gateway`, `--no-render`,
`--cdp-url`, `--render-concurrency N`, `--no-dismiss-consent`, `--dup-distance N`,
`--no-content-dedup`. Run the CLI with `--help` for the full list.
```

to:

```
`--vault`, `--folder`, `--inbox`, `--dry-run`, `--limit N`, `--retry-failed`,
`--min-words N`, `--concurrency N`, `--rpc-url`, `--gateway`, `--no-render`,
`--cdp-url`, `--render-concurrency N`, `--no-dismiss-consent`, `--dup-distance N`,
`--no-content-dedup`, `--list`, `--import-ids <ids>`, `--decline-ids <ids>`,
`--reset-declined`. Run the CLI with `--help` for the full list.
`--list` classifies and prints `{ new[], counts }` without writing anything;
`--import-ids`/`--decline-ids` act on a comma-separated id set from a prior
`--list` (import wins if an id appears in both); `--reset-declined` clears every
declined entry so those bookmarks reappear as new.
```

- [x] **Step 4: Verify the skill still reads correctly and ships clean**

Run: `npx vitest run` (sanity — a docs change must not affect tests)
Expected: PASS.

Visually confirm `bookmarks-to-obsidian/SKILL.md`: the Workflow renumbers 1–7 with no orphaned references to the old dry-run-then-import-all steps, the Flags paragraph lists the four new flags, and the Overview mentions the walk.

- [x] **Step 5: Commit**

```sh
git add bookmarks-to-obsidian/SKILL.md
git commit -m "docs(skill): list -> walk -> import selection workflow" -m "Replaces dry-run-then-import-all with --list, an up-front count + cap, a one-by-one keep/skip walk (Import / Skip / Stop & finish now), and a single --import-ids/--decline-ids call. Documents kept != imported (content dedup), meta.declined, and --reset-declined; adds the four new flags."
```

> Done 2026-06-14 (commit `319b4ea`). Overview now mentions the list→walk→import
> flow + bulk escape; Workflow renumbers 1–7 with no orphaned step references
> (the Common-mistakes "dry-run first" note was repointed from the old step 2 to
> step 6); Flags lists all four new flags. Suite stayed green (150 passed, 2 skipped).

---

### Task 8: Final verification

**Files:** none (verification only)

- [x] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS — `classify` + `classify.helpers` plus the pre-existing suite (`fingerprint`, `content-index`, `reconcile`, `dedup.scan`, `report`, `url`, `note`, `extract`, `images`, `frontmatter`, `gateway`, `shell`, bootstrap, render) all green.

- [x] **Step 2: Syntax-check the CLI entry point**

Run: `node --check bookmarks-to-obsidian/scripts/import.mjs`
Expected: no output.

Run: `node bookmarks-to-obsidian/scripts/import.mjs --help`
Expected: usage prints with `--list`, `--import-ids`, `--decline-ids`, `--reset-declined`.

- [x] **Step 3: Confirm no dev artifacts leaked into the skill folder**

Run: `git status`
Expected: under `bookmarks-to-obsidian/` only `scripts/src/classify.mjs`, `scripts/import.mjs`, and `SKILL.md` changed; both new tests live under root `test/`; the skill's `package.json` is untouched (no devDependencies, no new runtime dependency — `classify.mjs` imports only `./dedup.mjs` and `node:url`).

- [x] **Step 4: Spec coverage spot-check**

Confirm against `specs/2026-06-13-selectable-bookmark-import-design.md`:
- `classifyBookmarks()` single definition of "new"; `declined` excluded + counted, sticky under `--retry-failed`; `failed`/`skipped-thin` rejoin under `--retry-failed` — Tasks 1, 6.
- `--list` JSON shape (`new[]` with `domain`, `counts`, read-only) — Tasks 2, 5.
- `--import-ids` processes only the subset, ignores unknown ids, honors dedup incl. content dedup (kept can settle `skipped-duplicate`), works with `--dry-run`, emits the default report — Task 6.
- `--decline-ids` writes `declined` entries keyed by normalized URL, combinable with `--import-ids`, import wins on overlap, no render when decline-only — Tasks 2, 6.
- `--reset-declined` clears all declined and nothing else, no-op reports 0 — Tasks 2, 4.
- Manifest `declined` status keyed by normalized URL, orthogonal to dedup fields — Tasks 1, 2, 6.
- Content-dedup interaction: `--list` uses `scanVault({ content: false })`; import path keeps `{ content: true }` → reconcile — Tasks 5, 6.
- Edge cases: deleted id → note (Task 6); overlapping keep/decline → import wins (Tasks 2, 6); decline-only → no browser/mkdir (Task 6, `within` empty); reset no-op (Task 4); `--list` + `--dry-run` harmless (Task 5, read-only).
- SKILL.md workflow, flags, kept-≠-imported summary, `--reset-declined` offer — Task 7.

- [x] **Step 5: Commit (only if Step 4 surfaced a fix; otherwise nothing to commit)**

```sh
git status   # if clean, this task is verification-only and needs no commit
```

> Verified 2026-06-14. Suite 150 passed / 2 skipped; `node --check` clean; `--help`
> shows all four flags. Whole-feature diff under `bookmarks-to-obsidian/` is exactly
> `SKILL.md` + `scripts/import.mjs` + `scripts/src/classify.mjs`; tests are the two
> new files under root `test/`; the skill `package.json` is untouched and
> `classify.mjs` adds no runtime dependency (imports only `./dedup.mjs`). Spec
> spot-check: every Decisions row, CLI-surface flag, data-model `declined` entry,
> content-dedup interaction (§1/§2), and edge case maps to shipped code. No fix
> surfaced → verification-only, no code commit. (Task 6 Step 6 live gateway
> acceptance remains deferred — Chrome sync was down.)

---

## Self-Review Notes (for the plan author — already applied)

- **Spec coverage:** every row of the Decisions table and every `## CLI surface` flag maps to a task — selection UX/walk (SKILL.md Task 7), declined remembered + resettable (Tasks 1/2/4/6), Approach-1 plumbing `--list` then `--import-ids …/--decline-ids …` (Tasks 5/6), item display `Title — domain — URL` (`domain` from Task 1, rendered in Task 7), default flow list→walk→import + bulk escape (Task 6 keeps the no-flag path; Task 7 documents both). Data-model `declined` entry (Tasks 1/2/6). Content-dedup interaction §1/§2 (Tasks 5/6). Every "Edge cases & error handling" bullet is checked in Task 8 Step 4 and implemented in Tasks 4–6. Every "Testing (TDD)" bullet maps to a concrete test in Tasks 1–2 (the rest is exercised by the unchanged suite + manual gateway steps).
- **Deliberate design choice:** `classifyBookmarks()` is pure (folder resolve + `scanVault` stay in `import.mjs`), diverging from the spec's "roughly" signature to keep the spec's whole Testing list unit-testable without a gateway and to match the codebase's pure-core / IO-in-`import.mjs` structure. The "single definition of new" guarantee is preserved. Noted at the top of the plan.
- **`STATUSES` left unchanged:** a decline is a recorded user decision, not a content outcome, so it is surfaced via `report.meta.declined` (alongside `meta.dedup`) rather than a report bucket — this avoids changing the `buildReport` summary contract and keeps `report.test.mjs` green.
- **Type consistency:** `classifyBookmarks` returns `{ newItems, decided, existingCount, declinedCount }`; `newItems` entries are `{ id, title, url, domain, norm, slot }` and `decided` entries `{ id, slot, url, title, status, reason, file?, duplicateOf? }` — the same field names consumed in `import.mjs` Task 6 and stripped to `{ id, title, url, domain }` by `buildListPayload`. `partitionIds` → `{ importSet, declineSet }`; `buildDeclineEntries` → `{ entries, declined, unknownIds }`; `clearDeclined` → `{ manifest, cleared }` — all used exactly as returned. `within` items are `{ bm:{id,title,url}, norm, slot }`, matching what Phase A's `mapPool` destructures today.
- **Placeholder scan:** every code step shows complete code; no TBD / "handle errors" / "similar to Task N" references.
- **Behavior preservation:** Task 6's default branch reproduces today's classify+limit logic exactly (within-run dup, vault hit, remembered, pending, `skipped-limit`, dry-run cap of 10), and `buildReport(outcomes.filter(Boolean))` is a no-op for the dense default run — so the no-flag "import everything" path is unchanged.
