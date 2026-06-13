---
name: bookmarks-to-obsidian
description: Use when the user wants to import, sync, or pull their Chrome bookmarks into an Obsidian vault as full-article markdown notes — e.g. "import my AI bookmarks", "sync bookmarks to obsidian", "pull new bookmarks into the vault", "clip my bookmarked articles". Covers the AI reading folder in synced Chrome bookmarks.
---

# Bookmarks → Obsidian

## Overview

On-demand importer. Reads a Chrome bookmark folder via the local
`chrome-bookmarks-gateway`, **renders each new article in the gateway's Chrome
over CDP** and runs Defuddle in the live page (the Obsidian Web Clipper's own
engine + technique), **harvests the images the page already loaded**, and writes
Web-Clipper-quality notes into a vault inbox. For each page it renders *and*, when
the render looks thin or like a cookie/paywall shell, also raw-fetches and keeps
the better of the two — so it never does worse than before. The work is a
deterministic Node CLI; this skill is the thin operator that health-checks, runs
it, and summarizes the JSON report.

## When to use

- "import my AI bookmarks", "sync bookmarks to obsidian", "pull new bookmarks into the vault"
- **Not** for editing/searching bookmarks (use `chrome-bookmarks-gateway`) or one-off single-URL clips.

## Prerequisites

The skill brings its own dependency stack up (see Workflow step 1), but four
things cannot be scripted and must exist first — the bootstrap detects each and
tells the user what to do:

- **Docker installed and running.** A skill cannot install Docker Desktop or
  start its daemon. Bootstrap reports `docker-unavailable` when it is down.
- **Chrome or Chromium installed.** Bootstrap reports `chrome-not-found` when no
  browser is located. (Set `CBG_CHROME`/`CHROME_PATH` to point at a non-standard
  install.)
- **One-time Google sign-in + bookmark sync** in the dedicated Chrome window the
  bootstrap opens. Until done, `/syncz` returns `503` (`not-synced`). This is the
  single irreducible manual step on every fresh machine.
- **Internet for the first image pull** of `pvoronin/chrome-bookmarks-gateway:0.3.0`.

> **Apple Silicon (arm64):** the pinned gateway image is amd64-only; on Apple
> Silicon it runs under Docker Desktop's emulation (slower but functional).

## Configuration

All per-user values live in `config.json` in an OS config dir **outside** the
skill (`%APPDATA%\bookmarks-to-obsidian\` on Windows; `$XDG_CONFIG_HOME` or
`~/.config/bookmarks-to-obsidian/` on macOS/Linux), so re-copying the skill never
wipes them. Read/write it via the bundled CLI, run from the skill folder:

- `node scripts/src/bootstrap/config.mjs --get` — print the full config.
- `node scripts/src/bootstrap/config.mjs --set vault=<path>` — set the vault.
- `node scripts/src/bootstrap/config.mjs --consent` — record consent (stamps `consentedAt`).

Fields: `vault` (Obsidian vault root), `folder` (default `Mobile Lesezeichen/AI`),
`inbox` (default `Clippings`), `consentedAt`.

**First use:** if `vault` is unset, ask the user for their Obsidian vault path and
validate it — the directory **must exist** (reject and re-ask if not); a missing
`.obsidian/` folder is a soft warning that does not block. On success,
`--set vault=<path>`. Tool paths are skill-relative: invoke `node scripts/import.mjs` and
`node scripts/bootstrap.mjs` from the skill's own folder — never a hardcoded absolute path.

## Rendering & images

- Rendering uses the **same dedicated Chrome the gateway already runs** (CDP on
  `http://localhost:9222`) — no extra browser. Each article is opened in a fresh
  tab, consent banners are dismissed (EN+DE, precision-targeted), the page is
  rendered and extracted with in-page Defuddle, and the tab is closed. The
  gateway's Chrome is left running (connect/disconnect only).
- **Pick-the-better:** if the render is missing, below `--min-words`, or looks
  like a consent/paywall/JS shell, the importer also raw-fetches and keeps the
  better extraction. Each `imported` item reports `path`: `rendered` or
  `fetched-fallback`.
- **Images** are harvested from the render's own network responses (authenticated,
  defeats hotlink/cookie/CORS); anything not captured is node-fetched, and
  anything still unreachable keeps its remote URL (counted as `imagesRemote`).
  They are saved to `Clippings/_attachments/` and referenced as Obsidian embeds
  (`![[name]]`) so links survive when you move notes into `Articles/…`. Tracking
  pixels (< 33px) are dropped.
- A full backfill renders ~3 pages at a time; budget roughly **15–30 minutes for
  ~200 links** (slower than the old fetch-only path). Per-item progress is printed
  to **stderr**. `--dry-run` **does** render (capped to `--limit`, or 10 if no
  limit) for an honest preview, but writes no notes and downloads no images — so
  dry-run notes still show remote image URLs; do a small throwaway-inbox import to
  verify the downloaded-image experience.

## Workflow

1. **Health-check, then self-bootstrap if down.** Run all commands from the
   skill's own folder.
   - Health check: `curl -sS http://localhost:3000/syncz` → expect `{"ok":true}`.
   - **If it answers `{"ok":true}`** → the stack is up; go to step 2.
   - **If it is unreachable or returns `503`** → bring the stack up:
     1. **Consent.** Read `node scripts/src/bootstrap/config.mjs --get`. If `consentedAt`
        is absent, explain once — bootstrap will *launch a dedicated Chrome,
        start a local CDP proxy, and run a Docker container, binding ports
        3000 / 9222 / 9223* — and ask permission. On **yes**:
        `node scripts/src/bootstrap/config.mjs --consent`. On no, stop.
     2. **Bootstrap:** `node scripts/bootstrap.mjs`. It prints one JSON object; parse its
        `status` and branch:
        - `needs-consent` → consent was not recorded; do the consent step, retry.
        - `docker-unavailable` → tell the user to install/start Docker Desktop; stop.
        - `chrome-not-found` → tell the user to install Chrome/Chromium (or set
          `CBG_CHROME`); stop.
        - `not-synced` → tell the user to sign into Google **and enable bookmark
          sync** in the dedicated Chrome window the bootstrap opened (the one
          manual step); re-check `/syncz` after they confirm.
        - `down` → the stack did not come up; surface the JSON and stop.
        - `ready` → proceed.
2. **First run / when unsure → dry-run first** so the user can eyeball quality.
   Read `vault`/`folder` from config (`--get`) and pass them as flags:
   ```
   node scripts/import.mjs --vault "<config.vault>" --folder "<config.folder, default Mobile Lesezeichen/AI>" --dry-run --limit 10
   ```
3. **Real import** (writes notes) — drop `--dry-run`; omit `--limit` for the full backfill:
   ```
   node scripts/import.mjs --vault "<config.vault>" --folder "<config.folder>"
   ```
4. **Parse** the JSON report on stdout and **summarize** in prose: imported N →
   inbox, plus skipped/failed counts. List the `skipped-thin` and `failed` items
   for manual triage. Never paste the raw JSON at the user.
5. **Offer next**: `--retry-failed` (re-attempts `failed` + `skipped-thin`), open
   the inbox, or clip a thin one manually in Safari/Web Clipper.

## Report statuses

| status | meaning |
|---|---|
| `imported` | new note written to the inbox |
| `skipped-existing` | URL already in the vault or import manifest |
| `skipped-thin` | wordCount below `--min-words` (video / SPA / paywall) |
| `skipped-binary` | non-HTML content type (PDF, image) |
| `failed` | fetch error (HTTP/DNS/timeout); retry with `--retry-failed` |
| `skipped-limit` | a new bookmark held back by `--limit` this run |

Each `imported` item also reports `path` (`rendered` or `fetched-fallback`) and an
`images` count (`downloaded` / `remote` / `dropped`). The report `meta.render`
block summarizes how many were rendered vs. fell back, and total images
downloaded vs. left remote — surface this in your summary (e.g. "42 imported
(40 rendered, 2 fetch-fallback), 130 images saved, 4 left remote").

## Flags

`--vault`, `--folder`, `--inbox`, `--dry-run`, `--limit N`, `--retry-failed`,
`--min-words N`, `--concurrency N`, `--rpc-url`, `--gateway`, `--no-render`,
`--cdp-url`, `--render-concurrency N`, `--no-dismiss-consent`. Run the CLI with
`--help` for the full list.

## Common mistakes

- Running with the gateway down → the CLI exits 2 with `{"error":"gateway-unreachable"|"gateway-not-synced"}`. Bring the stack up first via Workflow step 1 (`node scripts/bootstrap.mjs`); don't fabricate results.
- A bare `--folder "AI"` is **ambiguous** (an AI folder exists on the bar *and* under Mobile bookmarks) — the CLI errors with both paths. Use the full path `Mobile Lesezeichen/AI`.
- A real import mutates the vault. For an unfamiliar vault state, dry-run first (step 2) before writing.
- Transient `failed` (e.g. HTTP 429) is normal for rate-limited hosts; re-run later with `--retry-failed`.
