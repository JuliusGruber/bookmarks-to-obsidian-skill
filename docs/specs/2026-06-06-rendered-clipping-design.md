# Rendered clipping — Web-Clipper-parity markdown via in-browser Defuddle

- **Date:** 2026-06-06
- **Skill:** `bookmarks-to-obsidian` (`C:\Users\juliu\.claude\skills\bookmarks-to-obsidian`)
- **Status:** design approved; **revised 2026-06-07** (see revision note) — rung 1
  shipped, rungs 2–3 pending implementation plan

## Revision 2026-06-07 — three-rung staircase

This design was written assuming the CDP render was the *only* lever. A source-level
reverse-engineering of the actual Obsidian Web Clipper (`obsidianmd/obsidian-clipper`)
and its engine (`kepano/defuddle`) found two cheaper rungs that come first, and
corrected two claims in "Root cause" below.

**The staircase (do in order; each is independently shippable):**

1. **Rung 1 — upgrade Defuddle 0.6.6 → 0.18.1. ✅ DONE (2026-06-07).** The project
   pinned `defuddle ^0.6.0` (resolved 0.6.6); the extension ships `^0.18.1`. Twelve
   minor versions of extraction fixes were missing, including:
   - `<noscript>` real-image recovery — 0.6.x deleted `<noscript>` outright, throwing
     away images many sites hide there. A concrete, render-independent cause of the
     "images lost" complaint.
   - shadow-DOM consumption via `data-defuddle-shadow` (lets rung 3 stamp shadow
     roots the way the extension does, instead of hand-rolling a flatten/merge).
   - a 0.6.6 bug where `removeHiddenElements` built its removal list but never removed.
   - the current rule set behind `createMarkdownContent`.

   The bump is **drop-in**: `extract.mjs`'s `Defuddle(html, url, { markdown: true })`
   call is unchanged. 0.18.1 dropped the jsdom peer dep and parses via **linkedom**,
   so the now-unused direct `jsdom` dependency was removed. All 43 unit tests stay
   green; this rung needs no rendered DOM.

2. **Rung 2 — environment-independent preprocessing (not yet built).** Pure
   DOM/string work that helps *every* page with no browser:
   - **Absolutize** `src`/`href`/`srcset` against the page URL. Defuddle rewrites
     attribute strings and does **not** absolutize in any environment, so relative
     image/link URLs survive into the note. A real, cheap bug.
   - Belt-and-suspenders lazy/`<noscript>` promotion for anything that slips past the
     engine. Lands as a small step around `extract.mjs`; also feeds rung 3.

3. **Rung 3 — CDP render (the rest of this document).** Only the residual hard cases
   need a live browser: SPA/hydrated bodies, JS-*swapped* image `src`, visually-hidden
   duplicate pull-quotes, runtime-rendered math/highlighting.

## Problem

The importer produces lower-quality markdown than the Obsidian Web Clipper, even
though it already uses the Clipper's own extraction engine (Defuddle). The user's
three concrete complaints, in priority order:

1. **Missing / thin / mangled body** — pages come through empty, truncated, or
   full of consent-wall / JS-shell junk.
2. **Formatting fidelity** — e.g. a pull-quote duplicated as both a `>` blockquote
   and a body paragraph; runtime-applied code highlighting and math lost.
3. **Images** — broken/relative URLs, lazy-load placeholders, tracking pixels.

Titles and frontmatter are *not* a complaint and are out of scope for changes.

## Root cause (verified)

The current pipeline is `fetch()` raw server HTML → `Defuddle` (node build, linkedom
since rung 1) → markdown. The Obsidian Web Clipper instead runs Defuddle against the **live,
rendered, post-JavaScript `document`** in the user's browser. All three complaints
trace to that single difference:

- **Body** — A raw `fetch()` returns only the initial server HTML: SPA shells,
  JS-injected content, and consent/login-gated articles come back empty or
  stubbed. Defuddle cannot extract content that is not in the DOM.
- **Images** — Two distinct mechanisms, only one of which needs a render.
  *(Corrected 2026-06-07.)* (a) Lazy/`srcset`/`data-src` recovery is pure
  attribute-string work and runs **identically** under linkedom — it is *not* a
  source of loss. What is lost without a render is narrower: image `src`s that JS
  **swaps in** at runtime, and (on 0.6.x only, now fixed by rung 1) real images
  hidden in `<noscript>`. (b) Tracking-pixel / small-image *removal* relies on
  `getBoundingClientRect`, which is all-zeros without a layout engine — so under a
  headless DOM that path drops *fewer* images (junk pixels leak, but real images are
  not mis-dropped). Separately, Defuddle never **absolutizes** URLs in any
  environment (rung 2).
- **Formatting** — The duplicated pull-quote is a *visually hidden* duplicate the
  browser would strip via layout measurement; a headless DOM can't measure, so it survives.
  Same mechanism. Runtime code highlighting and KaTeX/MathJax math exist only in
  the rendered DOM.

Confirmed, so we don't waste effort fixing the wrong thing:

- **The markdown converter shares the extension's code path — but was 12 versions
  stale.** *(Corrected 2026-06-07.)* The skill imports `defuddle/node` with
  `markdown: true`; that build runs the same `createMarkdownContent` (Turndown +
  custom rules: tables, code-fence language, callouts, footnotes, embeds, math) the
  extension uses — but it was running on **defuddle 0.6.6**, while the extension ships
  **0.18.1**. "Parity" was only true of the *invocation path*, not the rule set. Rung
  1 upgraded it. The converter is environment-independent (pure DOM/string work,
  identical in the browser and node builds), so it produces identical markdown given
  the same input HTML — the rules just need a *rendered* DOM as input (rung 3).
- **The node build does not execute scripts.** `defuddle/node` parses the raw HTML
  string with **linkedom** (0.18.1; was jsdom on 0.6.x) — no JS execution and no
  layout engine. This is structural, not a config tweak. (Passing an HTML string is
  now a *deprecated* input that will be removed in a future major; rung 3 should hand
  Defuddle a real rendered `Document` instead.)
- **The Clipper does not download images** — it keeps cleaned remote absolute
  URLs. Local download (below) is a deliberate step *beyond* the Clipper, chosen by
  the user.
- **Feasibility:** a dedicated Chrome is already running with CDP on
  `http://localhost:9222` (proxy on `9223`), signed into the user's Google account
  with bookmark sync — the **same** browser the importer already requires to be up
  (it health-checks the gateway before doing anything). Rendering reuses it with
  **no new browser download and no new runtime requirement.**

## Goals

- Match Web-Clipper body completeness and formatting fidelity by extracting from
  the rendered DOM.
- Resolve, clean, and **download** images into the vault, rewriting links so they
  survive the user's later note-moves.
- Never regress below today's behaviour: keep raw-fetch extraction as a fallback.
- Stay a deterministic Node CLI with unit tests; remain additive to the existing
  module set.

## Non-goals

- No metadata/template/frontmatter changes (titles, author, tags stay as-is).
- No consent-wall *bypass* beyond an optional best-effort flag (off by default).
- No two-stage render cache, no Playwright-launched bundled browser.
- No new vault organisation; the import still lands in `Clippings/` and the user
  continues to file notes into `Articles/<category>/` manually.

## Approach

Rungs 1–2 (see the revision note above) handle the cheap, render-independent wins.
This section specifies **rung 3** — the residual hard cases that genuinely need a
live browser.

**Add a CDP-render stage to the existing CLI** (chosen over a two-stage
render-cache or a Playwright rewrite — both add complexity the task doesn't need).
Keep every proven piece (gateway walk, dedup, manifest, report, frontmatter,
filename safety). Replace only the per-bookmark *fetch → extract* core with
*render → extract → download-images*, and keep raw fetch as the fallback.

### Architecture

New modules (existing ones unchanged except `import.mjs` wiring):

| Module | Responsibility |
|---|---|
| `src/render.mjs` *(new)* | Connect to the running Chrome via CDP (connect-only, **no browser binary**), open a tab, navigate, trigger lazy-load, flatten shadow DOM, run **Defuddle in the live `document`**, return cleaned content + metadata, close the tab. |
| `src/images.mjs` *(new)* | Given cleaned content + base URL: download each image, dedupe by content hash, rewrite references to local Obsidian embeds. |
| `import.mjs` *(edited)* | Per-bookmark core becomes render → extract → download-images; steps 1–7 (gateway, classify, limit, manifest, report) unchanged. New per-item report fields. |
| `src/extract.mjs` *(unchanged)* | Its `fetchPage` / `extractFromHtml` become the **fallback** path. |

### Data flow (per bookmark)

```
bookmark.url
  └─ render.mjs: CDP connect → new tab → navigate(networkidle, timeout)
        → auto-scroll to bottom (trigger lazy-loaders) → flatten shadow DOM
        → run Defuddle on live document → { cleanedHtml|markdown, meta } → close tab
        │  (on connect/nav failure → fallback: extract.mjs fetchPage + Defuddle-node)
  └─ markdown: same createMarkdownContent rules (see "Markdown conversion")
  └─ images.mjs: for each <img> URL → download (browser ctx → node fetch)
        → hash + dedupe → write <inbox>/_attachments/<slug-NN.ext>
        → rewrite reference to ![[slug-NN.ext]]   (failed download → leave remote URL)
  └─ frontmatter.mjs (unchanged) + body → note.mjs write
```

### Markdown conversion (parity preserved)

In-page Defuddle does the parse/clean against the live DOM (this is where the
layout-based cleanup the headless path can't do happens: tracking-pixel removal,
visually-hidden duplicate pull-quotes gone). It returns **clean HTML**, not markdown.
*(Corrected 2026-06-07: the extension itself does not convert in-page either — it
runs Defuddle for HTML, then calls `createMarkdownContent` separately.)* We do the
same:

- **Default:** run `Defuddle(renderedCleanHtml, url, { markdown: true })` in node on
  the HTML Defuddle extracted from the *rendered* DOM. The converter is
  **environment-independent** — pure DOM/string work, shipped identically in the
  browser and node builds — so this is byte-identical to converting in-page, without
  the complexity of injecting a converter bundle into the page.
- **No bundle injection.** The earlier draft's "inject the full browser bundle to
  make markdown in-page" path rested on a wrong assumption about how the extension
  works; it is dropped.

### Image pipeline (decided defaults)

1. **Folder:** one shared `<inbox>/_attachments/` (default `Clippings/_attachments/`),
   created on demand.
2. **Link style:** Obsidian **embed wikilinks** `![[slug-01.png]]`, not markdown
   `![](path)`. *Rationale:* the user later moves notes from `Clippings/` into
   `Articles/<category>/`; relative markdown links break on the move, but
   `![[basename]]` resolves anywhere in the vault. Filenames are made unique
   (note-slug + index) so basename resolution is unambiguous.
3. **Download path:** through the browser context first (reuses the page's cookies
   for session-gated images), falling back to a plain node fetch.
4. **Naming & type:** `<note-slug>-<NN>.<ext>`; extension derived from
   `Content-Type` / magic bytes, not the URL. Dedupe identical bytes within a note
   by content hash.
5. **Skips & failures:** skip `data:` URIs and already-local refs; a failed
   download leaves the original remote URL in place (never breaks the note) and is
   counted in the report.

### Rendering details

- Connect-only to `http://localhost:9222` (or the `9223` proxy). Candidate client
  libs: `playwright-core` (`connectOverCDP`) or `puppeteer-core` (`connect`) — both
  attach without downloading a browser; the plan picks one. No bundled Chromium.
- Viewport ~1280×800, navigate with `waitUntil: networkidle` and a bounded timeout
  (~20s) plus a short settle; **auto-scroll to bottom then top** to trigger lazy
  loaders before extraction.
- Replicate the extension's **shadow-DOM stamp** before parse: inject the MAIN-world
  one-liner that copies each `shadowRoot.innerHTML` into a `data-defuddle-shadow`
  attribute. Defuddle 0.18.1 consumes that attribute natively (rung 1), so no
  hand-rolled flatten/merge is needed — just the stamp. Hand Defuddle the rendered
  `Document` (0.18.1 accepts a `Document` directly; HTML-string input is deprecated).
- **Tab hygiene:** one fresh tab per render, always closed (even on error); never
  touch existing tabs or bookmarks, so the gateway's bookmark sync is undisturbed.
- **Render concurrency** default **3** (one Chrome; keep it gentle). This is
  separate from the existing `--concurrency` (raw-fetch fallback).
- **Consent walls:** rely on the persistent `cbg-chrome-profile` remembering
  dismissals; an optional `--dismiss-consent` flag does best-effort common-button
  clicking. Off by default (the extension does none; default clicking is fragile).

### Fallback ladder (per bookmark)

1. CDP render → in-page Defuddle.
2. On CDP-connect or nav failure/timeout → raw `fetchPage` + `Defuddle-node`
   (today's behaviour).
3. On thin/empty or fetch error → recorded as `skipped-thin` / `failed` exactly as
   today.

### Report / status changes

- Per imported item: `path: 'rendered' | 'fetched-fallback'` and
  `images: { downloaded, failed }`.
- Summary: counts of rendered vs fallback, total images downloaded/failed.
- All existing statuses (`imported`, `skipped-existing`, `skipped-thin`,
  `skipped-binary`, `failed`, `skipped-limit`) unchanged.

### Idempotency

Unchanged: the manifest + vault scan skip already-imported URLs, so images are not
re-downloaded on re-runs. Within a run, images dedupe by hash. `--retry-failed`
re-renders and re-downloads, as today.

## Error handling

- CDP unreachable at start → fall back to raw-fetch for the whole run (the gateway
  health-check already gates this; rendering failure must not abort the import).
- Per-page render error/timeout → fallback ladder above; never aborts the run.
- Tab cleanup guaranteed via `finally`; a crashed tab is logged and the bookmark
  takes the fallback path.
- Image download error → leave remote URL, count as failed, continue.

## Testing

- `test/images.test.mjs` *(new)*: URL resolution/absolutization, extension from
  content-type, hash dedupe, wikilink rewrite, filename sanitisation/collision,
  and "failed download leaves the remote URL".
- Render-result → note assembly tested with fixtures (no live browser): a pure
  function takes `{ cleanedHtml|markdown, meta, imageMap }` and returns the note
  body; assert frontmatter + embeds.
- A **guarded live smoke** test (skipped in the default `vitest run`, enabled by an
  env var) connects to CDP and renders a `data:`/localhost page end-to-end.
- Existing tests stay green; the fallback path keeps `extract.mjs` coverage valid.

## Risks & open questions (resolve in the plan)

- ~~**Browser full bundle exposing `createMarkdownContent`**~~ — *resolved
  2026-06-07:* node conversion on the rendered+cleaned HTML is byte-identical (the
  converter is environment-independent), so no in-page bundle is used. Out of scope.
- **CDP client library choice** (`playwright-core` vs `puppeteer-core`) — decide in
  the plan; requirement is connect-only, no bundled browser.
- **Driving the gateway Chrome during bookmark sync** — mitigated by new-tabs-only,
  low concurrency, guaranteed tab close.
- **Hotlink-protected images** — mitigated by browser-context download.
- **Performance** — ~197 pages × ~2–4s render at concurrency 3 ≈ 10–15 min for a
  full backfill. Acceptable for an occasional backfill; note it in the skill docs.
- **Sites that still block/captcha even when rendered** — accepted; they take the
  fallback path or are skipped, same as today.

## Out of scope

Metadata/template changes, new frontmatter fields, consent-bypass beyond the
optional flag, two-stage render cache, bundled-browser launch.
