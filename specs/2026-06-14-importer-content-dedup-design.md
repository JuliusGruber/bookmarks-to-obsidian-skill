# Importer content dedup (hardening) — design

**Date:** 2026-06-14
**Skill:** `bookmarks-to-obsidian`
**Status:** approved (brainstorm), pending implementation plan

## Problem

The importer dedupes purely on **normalized-URL identity** (`dedup.mjs`
`normalizeUrl` → vault scan + manifest + within-run set). That correctly collapses
the *same URL* reached via different tracking params or fragments, but it is blind to
the *same article published at genuinely different URLs*. Two real cases observed in a
single backfill:

- **Permalink twins** — `substack.com/home/post/p-201079702` and
  `addyo.substack.com/p/loop-engineering` resolve to byte-identical extracted content
  but are different URL strings.
- **Cross-domain reposts** — `addyo.substack.com/p/loop-engineering` and
  `addyosmani.com/blog/loop-engineering` are the same essay with different boilerplate.

Both slip past URL dedup and become separate notes. Obsidian then disambiguates the
identical titles with ` (2)` / ` (3)` suffixes. One essay produced three notes plus a
fourth repost in one run.

The duplicates all shared an **identical extracted title** — that is exactly why
`uniqueFilename` appended the ` (2)`/` (3)` suffix. "Same title" is therefore already
detectable at the point notes collide; the hardening adds a *corroboration* check
there to tell a true duplicate apart from a coincidental title clash.

## Goals

- Stop the importer creating a note whose content duplicates one already known —
  in the vault (incl. notes moved/renamed by hand), earlier in the same run, or
  remembered from a prior run.
- Catch both observed flavours: byte-identical bodies (permalink twins) **and**
  same-article-different-boilerplate (cross-domain reposts).
- Be **balanced**: auto-skip only on title match **plus** a corroborating content
  signal; when titles match but content diverges, **flag** the note for review rather
  than silently merging two distinct articles.
- Keep the run **deterministic** — the earlier bookmark wins as the canonical note.
- Don't regress URL dedup, ordinary imports, dry-run, or `--retry-failed`.

## Non-goals

- **No cleanup of duplicates already in the vault.** This is forward-prevention only.
  No audit report, no deletion, no merging of existing notes. (Existing dups are a
  separate manual task.)
- No fuzzy *title* matching (titles must canonicalize equal); the fuzziness lives in
  the body signal, not the title.
- No external dependencies — the fingerprint is built on `node:crypto`.
- No cross-language / translation dedup, no semantic-embedding similarity.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Detection strength | **Balanced**: title match **and** corroborating content signal → skip; title-only → flag, still import. |
| Corroboration signal | **Approach A** — exact body hash (exact tier) + 64-bit **SimHash** Hamming distance (near tier). |
| Scope | **Prevention only.** No vault audit, no auto-cleanup. |
| URL dedup | Unchanged — still the first, short-circuiting layer. |
| On auto-skip | New report status `skipped-duplicate` with a `duplicateOf` pointer; no note written; remembered in the manifest. |
| On flag | Status stays `imported`, plus a `possibleDuplicateOf: [files]` field; still gets a ` (2)` filename. |
| Determinism | Serial, slot-ordered **reconcile** stage; lowest-slot bookmark is canonical. |
| Escape hatches | `--dup-distance N` (default 6) tunes the near threshold; `--no-content-dedup` disables the layer. |

## Architecture

Content is unknown until *after* render/fetch, but today's single pass
(`import.mjs` step 6) extracts **and** writes a note in one go. Content dedup needs all
candidates' content known before any note is committed. The fix splits step 6 into
**three stages** and extends the vault scan (step 3) to also build a content index.

```
step 3  SCAN vault  ──►  { urls:Set, contentIndex }   (reads each .md's title + body)
                                  │
step 6  ┌─ Phase A: EXTRACT (parallel, existing pool) ─────────────┐
        │   render/fetch → pick winner → fingerprint the winner    │
        │   terminal failures (failed / binary / thin) settle here │
        └──────────────────────────────────────────────────────────┘
                                  │  candidates[]  (in slot order)
        ┌─ RECONCILE (serial, slot order — pure & deterministic) ──┐
        │   for each candidate: contentIndex.classify(fingerprint) │
        │     exact / near   → skipped-duplicate (don't accept)    │
        │     title-only far → import + possibleDuplicateOf flag    │
        │     unique         → import                              │
        │   accepted → assign uniqueFilename, add to contentIndex  │
        └──────────────────────────────────────────────────────────┘
                                  │  accepted[]
        ┌─ Phase B: WRITE (parallel) ──────────────────────────────┐
        │   download images → write note → manifest entry          │
        └──────────────────────────────────────────────────────────┘
```

Properties:

- **Reconcile is serial and slot-ordered**, so the earlier bookmark always wins as the
  canonical note. The dup decision is a pure function of `(fingerprint, index)` —
  trivially unit-testable and independent of render concurrency / timing.
- **Image download + note write move to Phase B**, so a detected duplicate costs zero
  downloads and zero writes (today's loop would download images for every copy).
- **One `contentIndex` type** is seeded from the vault scan and *grown* with each
  accepted note, so within-run and cross-run dedup share identical logic.
- **Memory**: Phase A holds all extracted markdown until Phase B drains it — a few MB
  for a ~200-link backfill. Accepted constraint.

The URL classification (step 4) and `--limit` (step 5) stages are unchanged: URL dedup
still runs first and short-circuits known URLs before anything is rendered.

## New module: `src/fingerprint.mjs`

Self-contained, no new dependencies (`node:crypto` only):

- **`titleKey(title)`** — lowercase + collapse-whitespace + trim of the *sanitized*
  title (the same canonicalization `note.mjs` `sanitizeFilename` applies). By
  construction `titleKey(a) === titleKey(b)` exactly when the two notes' filenames
  would collide — the title key *is* the ` (2)` signal, reused as a lookup key.
- **`normalizeBody(markdown)`** — reduce the body to comparable plain text: **drop
  image markup entirely** (both remote `![](url)` and local `![[slug]]` embeds — the
  same article fingerprints identically before vs after Phase B rewrites images),
  reduce links to their anchor text, drop heading/emphasis markers, lowercase, collapse
  whitespace. Makes the fingerprint stable across boilerplate and image-path noise.
- **`bodyHash(normalizedBody)`** — SHA-1 hex of the normalized body → exact-dup key.
- **`simhash(normalizedBody)`** — 64-bit SimHash over word 3-gram shingles, returned
  as a 16-char hex string (JSON-serialisable; BigInt is not).
- **`hamming(a, b)`** — bit distance between two hex SimHashes.

A `fingerprint(title, markdown)` helper returns `{ titleKey, bodyHash, simhash,
wordCount }` for both the scan and the extract stage to share.

## The content index

A small structure seeded from the vault scan and extended during reconcile. Holds, per
known note: `{ file, titleKey, bodyHash, simhash }`, indexed two ways:

- `byHash: Map<bodyHash, file>` — exact tier.
- `byTitle: Map<titleKey, Array<{ file, simhash }>>` — near / flag tiers.

```js
contentIndex.add({ file, titleKey, bodyHash, simhash })
contentIndex.classify({ titleKey, bodyHash, simhash }, { distance }) → verdict
```

`classify` returns one verdict:

| verdict | condition | action |
|---|---|---|
| `exact` | `bodyHash` matches a known note | skip → `skipped-duplicate`, `reason: "exact content"`, `duplicateOf` = that file |
| `near`  | same `titleKey` **and** min `hamming ≤ distance` | skip → `skipped-duplicate`, `reason: "near-duplicate (dist N)"`, `duplicateOf` = closest file |
| `flag`  | same `titleKey` but every candidate `hamming > distance` | **import**, attach `possibleDuplicateOf: [files]` |
| `unique`| no `titleKey` match | import |

`distance` defaults to **6** (on a 64-bit SimHash, near-identical prose with differing
boilerplate lands ≤ 6; genuinely different same-titled posts land well above). Exposed
as `--dup-distance N`. The exact tier is checked before the near tier, so a byte-match
short-circuits regardless of title.

The thin gate (`--min-words`, default 200) runs *before* fingerprinting, so SimHash
always has enough tokens to be reliable; sub-threshold pages never reach the index.

## Vault scan extension (`dedup.mjs`)

`scanVaultSources(vaultPath)` becomes `scanVault(vaultPath)` returning
`{ urls:Set, content:contentIndex }`. The existing whole-vault walk (it already
recurses past `Clippings/` so notes moved into `Articles/…` are seen) is extended to,
per `.md`:

1. Parse frontmatter for `source:` (existing) **and** `title:`.
2. Read the body after the frontmatter.
3. Compute `fingerprint(title || filenameBase, body)` and `content.add(...)`.

The **live vault scan is the source of truth** — it indexes hand-added and moved notes
that the manifest never recorded. Manifest fingerprints (below) are provenance and a
future speed-up, not the authority.

Cost: the scan now reads every note body once per run (sub-second at a few-hundred-note
scale). Caching fingerprints in the manifest keyed by note mtime is noted under
*Out of scope / future*.

## Report & data-model changes

### Report (`report.mjs`)

Add `skipped-duplicate` to `STATUSES` so the summary always carries the bucket.

```jsonc
// auto-skipped duplicate
{ "url": "...", "title": "Loop Engineering", "status": "skipped-duplicate",
  "reason": "near-duplicate (dist 4)", "duplicateOf": "Loop Engineering.md" }

// imported, but title clashes with a distinct note → flagged, still written
{ "url": "...", "title": "Year in Review 2025", "status": "imported",
  "file": "Year in Review 2025 (2).md", "wordCount": 1210, "path": "rendered",
  "images": { /* … */ }, "possibleDuplicateOf": ["Year in Review 2025.md"] }
```

`report.meta` gains a `dedup` block:

```jsonc
"dedup": { "enabled": true, "distance": 6,
           "skippedExact": 2, "skippedNear": 1, "flagged": 1 }
```

### Manifest (`<inbox>/.import-state.json`)

Imported entries carry fingerprint fields, so a re-run can short-circuit without
re-rendering and a moved note still dedupes:

```jsonc
{ "<normUrl>": { "bookmarkId": "…", "status": "imported", "file": "…",
                 "titleKey": "…", "bodyHash": "…", "simhash": "…",
                 "wordCount": 1322, "at": "2026-06-14" } }
```

A detected duplicate is remembered too:

```jsonc
{ "<normUrl>": { "bookmarkId": "…", "status": "skipped-duplicate",
                 "duplicateOf": "Loop Engineering.md", "at": "2026-06-14" } }
```

Step 4's existing "remembered" path already replays non-imported statuses, so a re-run
reports `skipped-duplicate` instantly without re-extracting. It is **not** in the
`--retry-failed` set (only `failed` / `skipped-thin` retry), so it stays stable.

**Backward compatibility:** old manifests lack fingerprint fields — harmless. Those
URLs are still remembered by URL, and the vault scan supplies their content
fingerprint regardless. No migration step.

## CLI surface

New flags on `import.mjs`, composing with all existing flags:

- `--dup-distance <N>` — SimHash Hamming threshold for the near tier (default `6`).
- `--no-content-dedup` — disable the content layer entirely. Phases collapse back to
  today's behaviour (URL dedup only), with zero fingerprinting cost.

## Skill workflow (SKILL.md)

Part of the deliverable:

- Add a `skipped-duplicate` row to the **Report statuses** table
  ("a new note whose content matches one already in the vault/run; not written").
- Document `--dup-distance` and `--no-content-dedup` in **Flags**.
- In Workflow step 4 (summarize), instruct the operator to surface the `meta.dedup`
  counts (e.g. "3 collapsed as duplicates — 2 exact, 1 near — 1 flagged for review")
  and to list any `possibleDuplicateOf` flagged notes for the user to eyeball.

## Edge cases & error handling

- **Dry-run** runs the full detect path (honest preview shows `skipped-duplicate` and
  flags) but writes no note, downloads no image, and persists no manifest — same
  contract as today.
- **Two new exact-dups in one run, neither in the vault** → lowest slot imported, the
  rest `skipped-duplicate` of the first. Deterministic via slot order.
- **No-frontmatter / hand-made notes** → `titleKey` falls back to the filename base;
  body still fingerprinted; exact tier still applies.
- **Missing / empty extracted title** → no `titleKey` match possible; the exact-hash
  tier still catches byte-identical bodies.
- **Flagged item (title clash, distinct content)** → imported with a ` (2)` filename,
  exactly as today, plus `possibleDuplicateOf`. So legitimate same-titled articles
  (e.g. two "Year in Review 2025" posts) still coexist.
- **`--no-content-dedup`** → no scan-body reads, no fingerprinting, legacy single-pass
  behaviour.
- **Gateway / folder error contract** unchanged — still fails fast before any scan.

## Testing (TDD, root `test/`)

Importing from `../bookmarks-to-obsidian/scripts/src/`, vitest; fixtures are small
local markdown samples (no network):

- **`fingerprint.mjs` units** — `titleKey` normalization; `normalizeBody` stability
  across boilerplate; `bodyHash` (identical → equal, changed → differ); `simhash` +
  `hamming` against fixtures: two boilerplate-varied copies of one article ⇒ distance
  ≤ 6; two distinct same-title articles ⇒ distance ≫ 6.
- **`contentIndex.classify` matrix** — `exact`, `near`, `flag`, `unique`, plus
  slot-order canonical selection (lowest slot wins).
- **Reconcile scenario** modeling the real cluster — feed the "Loop Engineering" group
  ⇒ assert exactly one `imported`, the rest `skipped-duplicate` with correct
  `duplicateOf`; feed a same-title / different-content pair ⇒ both `imported`, one
  carrying `possibleDuplicateOf`.
- **Regression** — URL-dedup outcomes and ordinary non-dup imports unchanged;
  `--no-content-dedup` reproduces legacy behaviour; existing suite stays green.

## Out of scope / future

- Vault audit report / clustering of *existing* duplicates (prevention-only here).
- Auto-cleanup / merge of existing duplicate notes.
- Manifest-cached fingerprints keyed by note mtime to skip re-reading unchanged bodies
  on large vaults (the scan reads every body for now).
- Canonical-URL (`<link rel=canonical>` / `og:url`) extraction as an additional dedup
  signal (would strengthen the permalink-twin case; deferred — the exact-hash tier
  already covers the observed twins).
