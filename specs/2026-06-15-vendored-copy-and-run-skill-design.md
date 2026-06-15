# Vendored, copy-and-run skill folder — zero-install setup

- **Date:** 2026-06-15
- **Skill:** `bookmarks-to-obsidian`
- **Status:** design approved (2026-06-15); implementation plan pending

## Problem

The distributable skill is already a single folder (`bookmarks-to-obsidian/`), but
getting it onto a machine still takes several manual steps. The README's setup is:

```
git clone … → cp -r bookmarks-to-obsidian → cd … → npm install
```

The only reason `npm install` is required is that `node_modules/` is **not**
shipped — neither committed to git nor included in the `.skill` archive (the
official packager strips it). So a freshly-copied folder cannot run until the user
installs dependencies, and that install needs `npm` + internet.

The user wants the setup instructions to collapse to: **copy the folder, start the
skill.** No `npm install`, no `cd`, no build step on the user's side — for *both*
distribution routes the README documents (copy-the-folder and `.skill` archive).

This is a **setup/onboarding** simplification only. The engine's architecture
(Docker gateway, dedicated Chrome, CDP proxy, Google sync, the whole `scripts/`
tree) is explicitly **out of scope and unchanged**.

## Goal

Make the skill folder **copy-and-run**: dropping `bookmarks-to-obsidian/` into a
Claude skills directory is sufficient to use it, with no dependency-install step.
Both the copy-the-folder route and the `.skill` archive route arrive ready to run.

### Decisions (from brainstorming)

1. **Keep the architecture.** No change to the Docker gateway, dedicated Chrome,
   CDP proxy, Google sync, or any `scripts/` code. This is purely about making the
   dependencies present without a user-run install.
2. **Vendor `node_modules`.** Chosen over bundling (esbuild/ncc) and auto-install:
   it is the lowest-risk path to "copy and it just runs," with zero behavior change.
   `puppeteer-core` and `defuddle/node` are notoriously fiddly to bundle; vendoring
   sidesteps that entirely. Since `npm install` would download this same code
   anyway, vendoring costs the user no bytes they were not already fetching.
3. **Both distribution routes copy-and-run.** Keep the `.skill` archive as an
   option, but replace the build step so the archive *includes* the vendored
   `node_modules/`.
4. **Commit `node_modules/` directly** (not a renamed `vendor/` dir) — Node's
   normal resolution finds a co-located `node_modules`, so **no code changes**.
5. **No pruning for v1.** Ship the full runtime tree. Pruning (`*.md`, `*.ts`,
   source maps, in-package test dirs) adds fragility for ~30% savings; revisit only
   if the folder feels too big once the real size is known.

## Why vendoring is safe here

All three runtime dependencies are **pure JavaScript with no native binaries**, so
a tree vendored on one OS runs on every OS:

- `defuddle` (`defuddle/node`) — article extraction over a JS DOM stack.
- `image-size` — reads image dimensions from buffers.
- `puppeteer-core` — *connects* to Chrome over CDP via a websocket; it does **not**
  download or embed a browser, and has no native build.

The one native wrinkle is `ws`'s **optional** `bufferutil` / `utf-8-validate`
addons; `ws` falls back to a pure-JS path when they are absent. The vendor install
therefore uses `--omit=optional` so no compiled `.node` files enter the tree,
keeping it portable.

## Architecture / changes

Five small, independent changes. None touches the engine code.

### 1. Vendor the runtime dependency tree

- In `bookmarks-to-obsidian/` (which has its own `package-lock.json`), produce a
  deterministic **runtime-only** tree:

  ```
  npm ci --omit=dev --omit=optional
  ```

  This excludes the dev/test toolchain (vitest, rollup, esbuild) and optional
  native addons, leaving only `defuddle`, `image-size`, `puppeteer-core` and their
  transitive deps.
- **Commit `bookmarks-to-obsidian/node_modules/`** to git, as-is. No source changes:
  `import { Defuddle } from 'defuddle/node'`, `import { imageSize } from
  'image-size'`, and `import puppeteer from 'puppeteer-core'` all resolve from the
  co-located `node_modules`.

### 2. `.gitignore` — anchor the ignore to the repo root

Today line 1 is `node_modules/`, which ignores `node_modules` at **every** depth —
including the skill's. Change it to anchor at the repo root only:

```
/node_modules/
```

The repo-root `node_modules/` is the **dev/test harness** (vitest + the skill's
deps via the `file:` link) and stays ignored. The skill's
`bookmarks-to-obsidian/node_modules/` is no longer matched by the anchored pattern,
so it becomes trackable. No negation rules needed.

### 3. Replace the `.skill` build step

The official `skill-creator` packager hard-codes `node_modules` into its exclusion
set (`EXCLUDE_DIRS`), with no override flag — so it cannot produce a copy-and-run
archive. Add a **repo-root dev script** (never ships), e.g. `scripts/package-skill.mjs`:

- Zips the `bookmarks-to-obsidian/` folder **including** `node_modules/` into
  `dist/bookmarks-to-obsidian.skill` (a zip, matching the `.skill` format).
- May still run the official `quick_validate` on `SKILL.md` first for parity, but
  performs the archiving itself so dependencies are included.
- Exposed via a root `package.json` script (e.g. `npm run package`).

> Note: `dist/` and `*.skill` are already gitignored — unchanged.

### 4. Documentation

- **README:**
  - *Install* collapses to ~3 lines: clone/download → copy `bookmarks-to-obsidian/`
    into the skills dir → ask Claude to import. Remove the `npm install` step and
    the "re-run `npm install` whenever you copy the folder" note.
  - *Development* keeps `npm install` / `npm test` **at the repo root** — that is
    the dev/test harness and is unchanged.
  - *Building a distributable `.skill`* is rewritten to use the new
    `scripts/package-skill.mjs` (replacing the PowerShell + official-packager
    block), and notes that the archive now includes `node_modules/` so recipients
    do **not** run `npm install`.
- **CLAUDE.md:** update the "Tests live at the repo root" conventions. Today it
  states the skill's `package.json` is runtime-only **and** that `node_modules/` is
  excluded from the `.skill`. Revise to: the skill **ships its vendored
  `node_modules/`**, and the `.skill` archive includes it. Add a one-line
  re-vendor procedure (below) for dependency bumps.

### 5. Re-vendor procedure (for dependency updates)

Document a single, repeatable command sequence so the committed tree stays correct
after a dependency bump (run in `bookmarks-to-obsidian/`):

```
rm -rf node_modules
npm ci --omit=dev --omit=optional
git add node_modules
```

(Optionally wrapped as a root `npm run vendor` script for convenience.)

## File layout

- `bookmarks-to-obsidian/node_modules/` *(new — committed)* — runtime-only deps.
- `bookmarks-to-obsidian/` source, `SKILL.md`, `scripts/`, `package.json`,
  `package-lock.json` — **unchanged**.
- `.gitignore` *(edit)* — anchor `node_modules/` to the repo root.
- `scripts/package-skill.mjs` *(new — repo-root dev tool, never ships)* — builds a
  `.skill` that includes `node_modules/`.
- `package.json` *(root, edit)* — add `package` (and optional `vendor`) scripts.
- `README.md`, `CLAUDE.md` *(edits)* — as above.

## Testing / verification

- **Existing suite:** `npm install` + `npm test` at the repo root still pass. The
  tests import from `../bookmarks-to-obsidian/scripts/src/` and resolve deps from
  either the root harness or the vendored tree — no conflict introduced.
- **Fresh-copy smoke test (the real acceptance):** copy the
  `bookmarks-to-obsidian/` folder to a clean temp dir on a machine/shell with **no
  network and without running `npm install`**, then run `node scripts/import.mjs
  --help` to prove it loads all dependencies and runs with zero install. (With a
  live gateway, also run `--list` for an end-to-end check.)
- **`.skill` archive check:** build the archive with `scripts/package-skill.mjs`,
  extract it to a clean dir, and confirm `node_modules/` is present and
  `node scripts/import.mjs --help` runs without `npm install`.
- **Cross-platform spot check:** because the tree is pure JS, a Windows-vendored
  tree should run on macOS/Linux; verify no `.node` files were vendored
  (`--omit=optional` should guarantee this).

## Scope

**In scope:** vendoring the runtime `node_modules/` into the skill folder; the
`.gitignore` anchor change; a repo-root packaging script that includes
`node_modules/`; README + CLAUDE.md updates; a documented re-vendor procedure;
fresh-copy and `.skill` verification.

**Out of scope:** any engine/architecture change (Docker gateway, dedicated Chrome,
CDP proxy, Google sync, `scripts/` logic); bundling or auto-install approaches;
installing the prerequisites (Node, Docker, Chrome) — those remain user-provided
and detected by the existing bootstrap; pruning the vendored tree.
