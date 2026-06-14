# Selectable bookmark import — design

**Date:** 2026-06-13
**Skill:** `bookmarks-to-obsidian`
**Status:** approved (brainstorm), pending implementation plan
**Revised:** 2026-06-14 — reconciled against the shipped content-dedup importer (see [Interaction with content dedup](#interaction-with-content-dedup)).

## Problem

Today the skill imports **all** new bookmarks in a folder at once (optionally capped
by `--limit`). There is no way to look at the new bookmarks and choose which ones to
import. The user wants, after invoking the skill, to be shown the list of new
bookmarks and select them — one by one — before anything is rendered or written to
the vault.

## Goals

- After invocation, present the genuinely-**new** bookmarks (not already in the vault,
  manifest, or previously declined) and let the user keep/skip each one.
- Skipping is durable: a declined bookmark is remembered and never shown again, until
  explicitly reset.
- Stay inside the Claude conversation — no separate terminal program / TUI.
- Keep the deterministic CLI deterministic; Claude orchestrates the interaction.
- Don't regress the existing "just import everything" path.

## Non-goals

- No interactive TUI / pager (would require a TTY the tool harness can't drive).
- No content preview fetched before deciding (slow, network-heavy, defeats
  selecting-before-importing). The decision is made from title + domain + URL only.
- No native multi-select checkbox batching — the user chose a literal one-by-one model.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Selection UX | One-by-one keep/skip, in chat (one bookmark per prompt). |
| Declined items | Remembered as `declined` in the manifest; hidden from future syncs; resettable. |
| Walk controls | Per-item keep/skip; **Stop & finish now**; **up-front count + optional cap**. (No "import all remaining" / "decline all remaining" buttons.) |
| Item display | `Title — domain — full URL`. |
| Default flow | New default = list → walk → import selected. "Just import everything" bulk escape remains. |
| Plumbing | **Approach 1**: `--list` emits JSON; one follow-up call `--import-ids … --decline-ids …`. |

## Architecture

The skill keeps its "thin operator + deterministic CLI" shape. The CLI gains a
read-only **list mode** and an **id-scoped import/decline mode**; Claude runs the
keep/skip walk in chat between the two calls.

```
Claude (operator)                         import.mjs (deterministic CLI)
─────────────────                         ─────────────────────────────
1. health-check / bootstrap  ───────────▶ (existing)
2. node import.mjs --list    ───────────▶ classifyBookmarks() → JSON { new[], counts }
3. announce count, up-front cap choice
4. walk new[] one-by-one (AskUserQuestion):
     Import / Skip / Stop & finish now
     → keep[] , decline[]
5. node import.mjs                         render→dedup→write keep[]  (existing engine)
     --import-ids <keep>      ───────────▶ record decline[] as `declined`
     --decline-ids <decline>
6. parse report → prose summary
```

### Refactor: `classifyBookmarks()`

Extract the existing classification logic (currently inline in `import.mjs`, ~lines
153–209: resolve folder → `collectBookmarks` → `scanVault` URL set + manifest dedup →
`--limit`) into one reusable function so the definition of "new" lives in exactly one
place. Both `--list` and the import engine call it.

> Note: this classification dedup is **URL-only**. The separate **content-dedup**
> layer (`scanVault`'s content index → fingerprint → reconcile) runs later, during
> render, and is *not* part of "new" — see
> [Interaction with content dedup](#interaction-with-content-dedup).

Returns, roughly:

```js
{
  folderName,        // resolved folder title
  newItems,          // [{ id, title, url, domain }]  — no manifest/vault/declined hit
  existingCount,     // in vault or manifest-imported
  declinedCount,     // manifest status === 'declined'
  toProcess,         // internal: bookmarks to render (used by import mode)
}
```

`--retry-failed` re-includes previously `failed` / `skipped-thin` items in `newItems`,
matching today's import behavior. It does **not** un-hide `declined` items.

## CLI surface

New flags on `import.mjs` (all compose with existing `--vault`, `--folder`, `--inbox`,
`--rpc-url`, `--gateway`, `--retry-failed`):

### `--list`
Classification only. Runs health-check + folder resolve + `classifyBookmarks()`, prints
JSON, exits. **No rendering, no writes, no manifest mutation.**

```json
{
  "mode": "list",
  "meta": {
    "folder": "AI",
    "folderSpec": "Mobile Lesezeichen/AI",
    "vault": "C:/…/Vault",
    "inbox": "Clippings",
    "counts": { "new": 12, "existing": 140, "declined": 8 },
    "generatedAt": "2026-06-13"
  },
  "new": [
    {
      "id": "532",
      "title": "Attention Is All You Need",
      "url": "https://arxiv.org/abs/1706.03762",
      "domain": "arxiv.org"
    }
  ]
}
```

- `new[]` is in bookmark order.
- `domain` is the URL host (best-effort; empty string if the URL won't parse).

### `--import-ids <id,…>`
Run the existing render/fetch/write engine on **only** the bookmarks whose ids are in
the comma-separated set. Honors existing dedup (an item that became existing in the
meantime is still skipped) — **including content dedup**: a selected id whose URL was
new can still settle as `skipped-duplicate` once its content is rendered (see
[Interaction with content dedup](#interaction-with-content-dedup)). Works with
`--dry-run` for a quality preview of the chosen ones. Emits the **default import
report** — the same stdout JSON shape a no-flag run emits, which now also carries the
`skipped-duplicate` status, the `meta.dedup` block, and `duplicateOf` /
`possibleDuplicateOf` fields.

### `--decline-ids <id,…>`
For each id, resolve the bookmark, normalize its URL, and write
`manifest[normUrl] = { bookmarkId, status: "declined", at }`. **No browser connect / no
render** — pure manifest update. Combinable with `--import-ids` in a single call.

### `--reset-declined`
Remove every `declined` entry from the manifest so those items reappear as `new`.
No-op (reports 0) when there are none.

### Existing default (no `--list` / `--import-ids` / `--reset-declined`)
Unchanged: import all pending. This is the "just import everything" bulk escape.

## Data model

Manifest (`<inbox>/.import-state.json`) gains one status:

```json
{ "https://example.com/x": { "bookmarkId": "532", "status": "declined", "at": "2026-06-13" } }
```

- Keyed by normalized URL like every other entry → a declined article stays declined
  even if re-bookmarked under a new id.
- Classification skips `declined` (it is neither `new` nor `existing`; counted as
  `declined`). `--retry-failed` does not un-hide it. Sticky until `--reset-declined`.
- `declined` sits alongside the statuses content-dedup already added — the manifest
  also carries `skipped-duplicate` entries (with `duplicateOf`) and fingerprint fields
  (`titleKey`/`bodyHash`/`simhash`) on `imported` entries. `declined` is orthogonal to
  all of these.

## Interaction with content dedup

The **content-dedup** feature (separate spec/plan, already shipped) changed the
importer this design builds on. Two consequences the implementation plan must honor:

1. **Selection is URL-scoped; dedup is content-scoped.** `--list` classifies on
   title + domain + URL only (an explicit non-goal: no content fetched before
   deciding). Content dedup runs *after* render, in the three-phase
   extract → reconcile → write pipeline. So a bookmark the user **keeps** can still
   land as `skipped-duplicate` (exact body twin or near-duplicate repost) and never be
   written. A kept id is a request to *try*, not a guarantee of import — the walk copy
   and the summary must not promise "N imported = N kept."

2. **Where the content index lives.** `scanVault(vault, { content })` returns
   `{ urls, content }`. `classifyBookmarks()` only needs `urls`, so `--list` should
   call `scanVault(vault, { content: false })` and skip building the (unused) content
   index. The import path keeps `{ content: true }` and hands the `contentIndex` to the
   reconcile phase — i.e. `classifyBookmarks()` owns URL/manifest dedup, while the
   content index stays a concern of the render engine, not the classifier.

## Skill workflow (SKILL.md)

Replaces today's dry-run-then-import-all steps with:

1. **Health-check / bootstrap** — unchanged.
2. **List** — `node import.mjs --list --vault "<vault>" --folder "<folder>"`; parse JSON.
3. **Nothing new** — if `new` is empty, say "No new bookmarks" (mention `declined` count
   if > 0) and stop.
4. **Up-front count + cap** — announce "N new bookmarks", then one choice:
   - Walk them all (one by one) → step 5.
   - Walk only the first N (e.g. 20) this session → cap; the rest stay new for next time.
   - Just import all N → skip the walk; go to step 6 with every id.
5. **The walk** — for each new bookmark up to the cap, one `AskUserQuestion` rendering
   `Title — domain — full URL` with three options:
   - **Import** → id into the keep set.
   - **Skip** → id into the decline set.
   - **Stop & finish now** → end the walk; import the keep set so far; undecided items
     are left untouched (shown again next sync, **not** declined).
6. **Execute** — one call:
   `node import.mjs --import-ids <keep> --decline-ids <skipped> --vault … --folder …`
   (either list may be empty).
7. **Summarize** — parse the report and summarize in prose as today (imported N,
   rendered vs. fallback, images, any `failed`/`skipped-thin` to triage) plus
   "M declined (hidden next time)." Also surface `meta.dedup`: kept items that
   collapsed as `skipped-duplicate` (exact/near, with `duplicateOf`) and any imported
   note flagged with `possibleDuplicateOf` (a title clash with distinct content). Offer
   `--retry-failed`, open the inbox, or `--reset-declined`.

## Edge cases & error handling

- `--list` uses the same gateway error contract (`gateway-unreachable` /
  `gateway-not-synced`) → Claude bootstraps, never fabricates.
- Bookmark deleted between list and import → `--import-ids` silently skips the missing
  id (reported as a note, no crash).
- Overlapping keep/decline ids → import wins; the id is dropped from the decline set.
- `--decline-ids` with no `--import-ids` → short-circuit the render engine entirely (no
  browser connect, no inbox mkdir).
- `--reset-declined` with nothing to reset → no-op, reports 0.
- `--list` and `--dry-run` together → `--list` is already read-only; `--dry-run` is
  redundant but harmless.

## Testing (TDD)

- `classifyBookmarks()`: a `declined` manifest entry is excluded from `new` and counted;
  `--retry-failed` does not un-hide it; `failed`/`skipped-thin` rejoin `new` under
  `--retry-failed`.
- `--list` JSON shape: `new[]` contents (including `domain`) and `counts`.
- `--decline-ids` writes correct manifest entries keyed by normalized URL.
- `--reset-declined` clears all `declined` entries and nothing else.
- `--import-ids` processes only the subset; ignores unknown ids.
- Existing test suite stays green.

## Out of scope / future

- Targeted `--reset-declined-ids <id,…>` (only a global reset for now).
- Reviewing/listing declined items in detail (only a count is surfaced).
- Selection-file or stateful-manifest plumbing (Approaches 2/3 — not chosen).
