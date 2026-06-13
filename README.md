# bookmarks-to-obsidian (Claude skill)

Self-contained Claude Code skill that imports Chrome bookmarks into an Obsidian
vault as Web-Clipper-quality markdown notes. It renders each page in the gateway's
Chrome (CDP), runs Defuddle in the live DOM, and harvests the images the page
loaded into the vault — also raw-fetching and keeping the better extraction when a
render looks thin or like a consent/paywall shell.

- **Operator guide:** see [`SKILL.md`](./SKILL.md) — this is what Claude reads.
- **Engine:** `import.mjs` + `src/*.mjs` — a deterministic Node CLI (`node import.mjs --help`).
- **Tests:** `npm test` (vitest unit + Defuddle fixture integration).

## Setup

```
npm install
```

Requires Node 20+ and the local `chrome-bookmarks-gateway` running on
`http://localhost:3000` (its dedicated Chrome, with CDP on `http://localhost:9222`,
doubles as the rendering engine). Dependencies: `defuddle` (extraction; bundles
`linkedom` for node-side parsing), `puppeteer-core` (CDP render + image capture,
connect-only — no bundled browser), and `image-size` (tracking-pixel filtering).
If `node_modules/` is missing (e.g.
after copying the skill to a new machine), re-run `npm install` from this directory.

## Design

A run is one deterministic pass: resolve the bookmark folder, decide what's new,
and turn each new bookmark into a single Web-Clipper-parity note. The central idea
is **pick-the-better** — every page gets a rendered candidate and (only when that
render looks thin or like a shell) a raw-fetched candidate; whichever yields the
longer real article wins, with the render breaking ties.

### Pipeline

`import.mjs` is the orchestrator: it parses flags, classifies bookmarks, and runs
the rest over one bounded worker pool, emitting a JSON report on stdout.

1. **Health + resolve** — confirm the gateway is up and Chrome is synced, resolve
   the folder, collect its bookmarks (`gateway.mjs`).
2. **Classify** — normalize each URL and split bookmarks into already-decided
   (in the vault or remembered by the manifest) vs. to-process (`dedup.mjs`).
3. **Render** — open a tab in the gateway's Chrome over CDP, run Defuddle in the
   live DOM to markdown, and harvest the images the page actually loaded
   (`render.mjs`).
4. **Fetch fallback** — when the render is thin or a consent/paywall/JS shell,
   raw-fetch the HTML and extract with node-side Defuddle (`extract.mjs`,
   `shell.mjs`).
5. **Pick the better** — disqualify shell/thin candidates, longest word count
   wins, render breaks ties.
6. **Materialize** — rewrite image refs to Obsidian embeds (`images.mjs`), build
   YAML frontmatter (`frontmatter.mjs`), write a collision-safe note (`note.mjs`).
7. **Record** — update the manifest and emit a structured report (`report.mjs`).

### Building blocks

Each `src/*.mjs` module owns one concern and is unit-tested in isolation:

| Module | Responsibility |
| --- | --- |
| `gateway.mjs` | Health check, fetch the bookmark tree over JSON-RPC, resolve a folder by name/path, collect its bookmarks. |
| `dedup.mjs` | URL normalization (strips `utm_*` and tracking params), vault scan (source of truth), and the `.import-state.json` manifest (fast path + provenance). |
| `render.mjs` | CDP render in the live gateway Chrome; in-page Defuddle → markdown; image-response capture. Connect/disconnect only — never launches a browser. |
| `extract.mjs` | Raw `fetch` + node-side Defuddle — the fallback extraction path. |
| `shell.mjs` | Pure detector for consent walls, paywalls, and JS shells (curated EN/DE phrases + a length rule). |
| `images.mjs` | Rewrite images to `![[embeds]]`, sourcing bytes captured-first, then a hotlink-busting fetch, else leaving them remote so notes never break. |
| `frontmatter.mjs` | Web-Clipper-parity YAML (author splitting, date normalization). |
| `note.mjs` | Windows/Obsidian-safe filenames, collision-safe naming, note write. |
| `report.mjs` | Aggregate per-item outcomes into the JSON summary. |

### State

The **vault is the source of truth**: a note's `source:` frontmatter means
"already imported". The per-inbox manifest is a fast path plus provenance for
failures and thin skips, and `--retry-failed` reconsiders those. `--dry-run`
plans without writing either.
