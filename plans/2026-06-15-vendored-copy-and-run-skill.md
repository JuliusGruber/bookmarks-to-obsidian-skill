# Vendored, copy-and-run skill folder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `bookmarks-to-obsidian/` skill folder copy-and-run — copying it into a Claude skills directory is enough to use it, with no `npm install` — for both the copy-the-folder and `.skill`-archive routes.

**Architecture:** Commit a runtime-only `node_modules/` *inside* the skill folder (Node resolves a co-located `node_modules`, so zero source changes), anchor the repo `.gitignore` so only the root harness's `node_modules/` stays ignored, and add a repo-root packaging script that produces a `.skill` zip **including** `node_modules/`. The engine (Docker gateway, Chrome, CDP proxy, Google sync, all `scripts/` logic) is untouched.

**Tech Stack:** Node 20+ (ESM), npm (`npm ci` from the skill's own `package-lock.json`), `archiver` (dev-only zip lib for the packager), vitest (existing root test harness). Windows / PowerShell is the primary shell.

---

## ⚠️ Deviation from the approved spec — read before starting

The spec (`specs/2026-06-15-vendored-copy-and-run-skill-design.md`) prescribes vendoring with:

```
npm ci --omit=dev --omit=optional
```

**This plan deliberately uses `npm ci --omit=dev` only — it drops `--omit=optional`.** Investigation of the actual dependency tree found the spec's `--omit=optional` to be both **unnecessary and harmful**:

1. **Harmful.** `defuddle` declares `linkedom`, `turndown`, `mathml-to-latex`, `temml` as `optionalDependencies`. But `defuddle/node` **requires `linkedom` and `turndown` at runtime** — `scripts/src/extract.mjs` → `Defuddle(html, url, {markdown:true})` lazily `require("linkedom")` (HTML parse) and `require("turndown")` (HTML→markdown). `--omit=optional` deletes them, producing a tree that **passes `node scripts/import.mjs --help` (static imports resolve) but crashes on the first real extraction.** The spec's chosen smoke test (`--help`) cannot see this.
2. **Unnecessary.** The spec wanted `--omit=optional` to keep native addons (`ws`'s `bufferutil`/`utf-8-validate`) out of the tree. But those two packages are **absent from the skill's `package-lock.json`** (so `npm ci` never installs them), and **no package in the lockfile has an install script** — the whole tree is pure JavaScript. There is nothing native to avoid.

**Consequences for this plan:**
- Vendor command is `npm ci --omit=dev` (the `npm run vendor` script encodes this).
- The acceptance smoke test exercises **real extraction** (`scripts/smoke-extract.mjs`), not just `--help`.
- The README / CLAUDE.md text written by Tasks 4–5 documents `--omit=dev` and explains why, instead of repeating the spec's `--omit=optional`.

The spec's prose ("Why vendoring is safe here", change #1, change #5) is now factually stale on this point. Updating the spec is **out of this plan's scope** — flag it to the maintainer; the plan is the source of truth for execution.

---

## File layout (what changes)

| Path | Change | Responsibility |
| --- | --- | --- |
| `.gitignore` | edit | Anchor `node_modules/` → `/node_modules/` so only the repo-root harness tree is ignored; the skill's vendored tree becomes trackable. |
| `bookmarks-to-obsidian/node_modules/` | new — committed | Runtime-only dependency tree (`npm ci --omit=dev` from the skill's lockfile). Thousands of files, by design. |
| `package.json` (root) | edit | Add `vendor` and `package` scripts; add `archiver` devDependency. |
| `package-lock.json` (root) | edit (generated) | Records the new `archiver` dev dep. |
| `scripts/smoke-extract.mjs` | new — repo-root dev tool, never ships | Offline real-extraction check: proves a skill folder's *vendored* tree can run Defuddle (linkedom + turndown) end-to-end. |
| `scripts/package-skill.mjs` | new — repo-root dev tool, never ships | Builds `dist/bookmarks-to-obsidian.skill` zip **including** `node_modules/`, mirroring the official packager's archive layout. |
| `README.md` | edit | Install collapses to clone → copy (no `npm install`); "Building a `.skill`" rewritten to use `npm run package`. |
| `CLAUDE.md` | edit | "Tests live at the repo root" section: skill now ships its vendored `node_modules/`; add re-vendor procedure. |

**Untouched:** every file under `bookmarks-to-obsidian/scripts/`, `SKILL.md`, the skill's `package.json` / `package-lock.json`, and the root `test/` suite. No engine/architecture change.

**Reference facts (verified against the current tree):**
- Skill runtime deps: `defuddle ^0.18.1`, `image-size ^2.0.0`, `puppeteer-core ^23.0.0` (`bookmarks-to-obsidian/package.json`). No `devDependencies`.
- `bookmarks-to-obsidian/node_modules/` currently exists locally but is **stale/polluted** (contains `vitest`, `@rollup/*`, etc. that are *not* in the skill's lockfile — leftovers from when tests lived inside the folder). It is **not** git-tracked. A clean `npm ci` replaces it entirely.
- `scripts/src/import.mjs`: `main()` prints `HELP` and returns at the top when `--help`/`-h` is passed (line ~157), before any gateway/network call. Its static import graph pulls `puppeteer-core` (via `src/render.mjs`), `defuddle/node` (via `src/extract.mjs`), and `image-size` (via `src/images.mjs`) — so `--help` is a valid **resolution** smoke test (but not a runtime-extraction test — see deviation above).
- `scripts/src/extract.mjs` exports `extractFromHtml(html, url, { minWords = 200 } = {})` → `{ status: 'ok'|'skipped-thin', content, wordCount, meta }`. It makes **no network call** (only `fetchPage` does), so it is safe for an offline smoke test.

---

## Task 1: Anchor `.gitignore` so the skill's vendored tree is trackable

**Files:**
- Modify: `.gitignore` (line 1)

- [x] **Step 1: Anchor the `node_modules` ignore to the repo root**

The current `.gitignore` line 1 is `node_modules/`, which ignores `node_modules` at *every* depth — including the skill's. Change only that line to anchor at the repo root. Final file:

```gitignore
/node_modules/
*.log

# Build output: packaged .skill artifacts
dist/
*.skill
```

(Edit: replace the first line `node_modules/` with `/node_modules/`. Leave every other line unchanged.)

- [x] **Step 2: Verify the root harness stays ignored**

Run:
```powershell
git check-ignore -v node_modules/
```
Expected: one line showing the match, e.g. `.gitignore:1:/node_modules/	node_modules/` (root tree still ignored).

- [x] **Step 3: Verify the skill's tree is no longer ignored**

Run:
```powershell
git check-ignore -v bookmarks-to-obsidian/node_modules/defuddle/package.json
echo "exit=$LASTEXITCODE"
```
Expected: **no match line printed**, and `exit=1` (`git check-ignore` exits 1 when the path is *not* ignored). This confirms `bookmarks-to-obsidian/node_modules/` is now trackable.

- [x] **Step 4: Commit (only `.gitignore` — do NOT stage node_modules yet; it is still the stale tree)**

```powershell
git add .gitignore
git commit -m "build(gitignore): anchor node_modules ignore to repo root" -m "Change node_modules/ to /node_modules/ so only the root dev/test harness tree stays ignored. The skill's bookmarks-to-obsidian/node_modules/ becomes trackable, ahead of vendoring it as a copy-and-run dependency tree."
```

---

## Task 2: Vendor a clean runtime-only tree + add the offline extraction smoke test

**Files:**
- Modify: `package.json` (root) — add `vendor` script
- Create: `scripts/smoke-extract.mjs`
- Create (committed): `bookmarks-to-obsidian/node_modules/` — runtime-only tree

- [x] **Step 1: Add the `vendor` script to the root `package.json`**

Edit the root `package.json` `scripts` block to add `vendor` (leave `test`/`test:watch` as-is). The `scripts` block becomes:

```json
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "vendor": "cd bookmarks-to-obsidian && npm ci --omit=dev"
  },
```

`cd … && …` works identically in both cmd (Windows npm scripts) and POSIX sh. `npm ci` wipes and recreates `node_modules` from the skill's `package-lock.json`; `--omit=dev` drops the dev toolchain but **keeps optional deps** (linkedom/turndown — see the deviation note).

- [x] **Step 2: Create the offline real-extraction smoke tool**

Create `scripts/smoke-extract.mjs`:

```javascript
#!/usr/bin/env node
// scripts/smoke-extract.mjs — repo-root dev tool (never ships).
//
// Proves a skill folder's *vendored* dependency tree is complete enough to run a
// real Defuddle extraction OFFLINE. This exercises defuddle/node -> linkedom +
// turndown (the optional-but-required DOM/markdown stack) that a plain
// `import.mjs --help` resolution check would NOT touch.
//
// Pass the skill folder to test; its deps resolve from THAT folder's co-located
// node_modules (Node walks up from the imported module's location):
//
//   node scripts/smoke-extract.mjs bookmarks-to-obsidian
//   node scripts/smoke-extract.mjs "C:\\Temp\\b2o-freshcopy"
//
// Exit 0 + "SMOKE OK ..." on success; exit 1 + "SMOKE FAIL ..." otherwise.
// Makes no network calls (extractFromHtml never fetches).

import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const skillDir = resolve(process.argv[2] ?? 'bookmarks-to-obsidian');
const extractUrl = pathToFileURL(join(skillDir, 'scripts', 'src', 'extract.mjs'));
const { extractFromHtml } = await import(extractUrl.href);

const body = Array.from({ length: 60 }, (_, i) =>
  `<p>Paragraph ${i}: enough real words here to comfortably clear the two ` +
  `hundred word floor so Defuddle treats this body as a substantial article.</p>`
).join('');
const html =
  `<!doctype html><html><head><title>Smoke</title></head><body><article>` +
  `<h1>Vendored tree smoke test</h1>${body}</article></body></html>`;

const r = await extractFromHtml(html, 'https://example.com/smoke');
if (r.status !== 'ok' || !r.content) {
  console.error('SMOKE FAIL:', JSON.stringify({ status: r.status, wordCount: r.wordCount }));
  process.exit(1);
}
console.log(`SMOKE OK: status=ok wordCount=${r.wordCount} contentChars=${r.content.length}`);
```

- [x] **Step 3: Vendor the runtime-only tree (replaces the stale local tree)**

Run from the repo root:
```powershell
npm run vendor
```
Expected: npm removes the existing `bookmarks-to-obsidian/node_modules`, then installs from the skill's lockfile. Output ends with something like `added NNN packages, and audited NNN packages in …`. (`npm run` executes the script string directly; it does **not** require the root harness to be installed first.)

- [x] **Step 4: Verify the tree is pure-JS and contains the right packages**

Run:
```powershell
"native_node_files=" + (Get-ChildItem bookmarks-to-obsidian/node_modules -Recurse -Filter *.node -File -ErrorAction SilentlyContinue | Measure-Object).Count
"linkedom=$(Test-Path bookmarks-to-obsidian/node_modules/linkedom)"
"turndown=$(Test-Path bookmarks-to-obsidian/node_modules/turndown)"
"domino=$(Test-Path bookmarks-to-obsidian/node_modules/@mixmark-io/domino)"
"puppeteer_core=$(Test-Path bookmarks-to-obsidian/node_modules/puppeteer-core)"
"vitest_GONE=$(-not (Test-Path bookmarks-to-obsidian/node_modules/vitest))"
"rollup_GONE=$(-not (Test-Path bookmarks-to-obsidian/node_modules/@rollup))"
```
Expected:
```
native_node_files=0
linkedom=True
turndown=True
domino=True
puppeteer_core=True
vitest_GONE=True
rollup_GONE=True
```
`native_node_files=0` confirms cross-platform safety; `linkedom`/`turndown`/`domino` present confirms the deviation fix; `vitest`/`@rollup` gone confirms the stale pollution was cleared.

- [x] **Step 5: Offline resolution smoke — `--help` loads every runtime dep**

Run:
```powershell
node bookmarks-to-obsidian/scripts/import.mjs --help
```
Expected: prints the usage text beginning `bookmarks-to-obsidian — import Chrome bookmarks into an Obsidian vault.` and exits 0. (Proves `puppeteer-core`, `defuddle/node`, `image-size` all resolve from the vendored tree.)

- [x] **Step 6: Offline runtime smoke — real extraction works (the critical check)**

Run:
```powershell
node scripts/smoke-extract.mjs bookmarks-to-obsidian
```
Expected: a single line `SMOKE OK: status=ok wordCount=… contentChars=…`, exit 0. This proves `linkedom` + `turndown` are present and functional in the vendored tree — the failure mode `--omit=optional` would have introduced.

- [x] **Step 7: Commit the vendored tree + the smoke tool + the script**

This stages thousands of files under `bookmarks-to-obsidian/node_modules/` — expected and intentional.
```powershell
git add bookmarks-to-obsidian/node_modules scripts/smoke-extract.mjs package.json
git commit -m "feat(skill): vendor runtime node_modules for copy-and-run" -m "Commit bookmarks-to-obsidian/node_modules/ as a runtime-only tree (npm ci --omit=dev from the skill's lockfile) so the copied folder runs with no npm install. Add an npm run vendor script and scripts/smoke-extract.mjs, an offline real-extraction check." -m "Uses --omit=dev only (NOT --omit=optional): defuddle/node loads linkedom and turndown from optionalDependencies at runtime, so omitting optionals would pass --help but break real extraction. The tree is pure JS (no install-script packages), so it is cross-platform."
```

- [x] **Step 8: Confirm the commit recorded the tree**

Run:
```powershell
"tracked_node_modules_files=" + (git ls-files bookmarks-to-obsidian/node_modules | Measure-Object -Line).Lines
```
Expected: a number in the thousands (e.g. `tracked_node_modules_files=8000+`), confirming git tracks the vendored tree.

---

## Task 3: Add the `.skill` packager that includes `node_modules/`

> **⚠️ Deviation from this task as written (applied during implementation):**
> Step 1 below adds a `"bookmarks-to-obsidian": "file:./bookmarks-to-obsidian"`
> root devDependency, and Step 4's guard rationale assumes it exists. **The final
> implementation drops that `file:` dependency entirely** — the root
> `devDependencies` are `vitest` + `archiver` only (see the actual root
> `package.json`). A `file:` link makes the skill folder a managed package, so a
> later root `npm install` can **prune the committed
> `bookmarks-to-obsidian/node_modules/`** while cleaning that linked package —
> corrupting the very vendored tree this plan ships. The test suite instead
> imports runtime code directly by relative path
> (`../bookmarks-to-obsidian/scripts/src/…`), so no `file:` link is needed.
> Corrected in commit `2a94a93`; now codified in `AGENTS.md` / `CLAUDE.md` and the
> README's Development section. Step 4's pollution guard stays useful as general
> install/vendor hygiene, just not as a check on a `file:` symlink. The steps
> below are left as the as-originally-written record.

**Files:**
- Modify: `package.json` (root) — add `archiver` devDependency + `package` script
- Modify: `package-lock.json` (root) — generated by `npm install`
- Create: `scripts/package-skill.mjs`

- [x] **Step 1: Add `archiver` and the `package` script to the root `package.json`**

Update the root `package.json`: add the `package` script and an `archiver` devDependency. After this edit the relevant blocks read:

```json
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "vendor": "cd bookmarks-to-obsidian && npm ci --omit=dev",
    "package": "node scripts/package-skill.mjs"
  },
  "devDependencies": {
    "vitest": "^2.1.0",
    "archiver": "^7.0.1",
    "bookmarks-to-obsidian": "file:./bookmarks-to-obsidian"
  }
```

(`archiver` is a streaming zip library; it is a **dev-only** dependency of the repo harness and never ships inside the skill.)

- [x] **Step 2: Create the packaging script**

Create `scripts/package-skill.mjs`:

```javascript
#!/usr/bin/env node
// scripts/package-skill.mjs — repo-root dev tool (never ships).
//
// Builds dist/bookmarks-to-obsidian.skill: a zip of the bookmarks-to-obsidian/
// skill folder *including* its vendored node_modules/, so recipients run the
// skill with zero `npm install`. Mirrors the official skill-creator packager's
// archive layout (every entry prefixed with the skill folder name) but
// deliberately KEEPS node_modules, which the official packager strips.

import { createWriteStream } from 'node:fs';
import { mkdir, stat, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const skillName = 'bookmarks-to-obsidian';
const skillDir = join(repoRoot, skillName);
const distDir = join(repoRoot, 'dist');
const outFile = join(distDir, `${skillName}.skill`);

// Parity with the official packager's exclusions, MINUS node_modules (we ship it).
const EXCLUDE_DIRS = new Set(['__pycache__']);
const EXCLUDE_FILES = new Set(['.DS_Store']);
const EXCLUDE_SUFFIXES = ['.pyc'];

function isExcluded(relPath) {
  const parts = relPath.split(sep);
  if (parts.some((p) => EXCLUDE_DIRS.has(p))) return true;
  const name = parts[parts.length - 1];
  if (EXCLUDE_FILES.has(name)) return true;
  return EXCLUDE_SUFFIXES.some((s) => name.endsWith(s));
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function main() {
  // The whole point is a copy-and-run archive, so refuse to build one that is
  // missing the manifest or the vendored deps.
  if (!(await exists(join(skillDir, 'SKILL.md')))) {
    throw new Error(`SKILL.md not found in ${skillName}/`);
  }
  if (!(await exists(join(skillDir, 'node_modules')))) {
    throw new Error(`${skillName}/node_modules/ is missing — run \`npm run vendor\` first.`);
  }

  await mkdir(distDir, { recursive: true });

  const output = createWriteStream(outFile);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const done = new Promise((res, rej) => {
    output.on('close', res);
    archive.on('warning', rej);
    archive.on('error', rej);
  });
  archive.pipe(output);

  let count = 0;
  for await (const file of walk(skillDir)) {
    const rel = relative(skillDir, file);
    if (isExcluded(rel)) continue;
    // Prefix every entry with the skill folder name, matching the official
    // packager's `relative_to(skill_path.parent)` layout.
    const arc = `${skillName}/${rel.split(sep).join('/')}`;
    archive.file(file, { name: arc });
    count++;
  }

  await archive.finalize();
  await done;
  console.log(`Packaged ${count} files -> ${relative(repoRoot, outFile)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

- [x] **Step 3: Install the dev harness (pulls in `archiver`)**

Run from the repo root:
```powershell
npm install
```
Expected: completes without error; `archiver` is added under root `node_modules/` and `package-lock.json` is updated.

- [x] **Step 4: Guard — confirm the root install did NOT disturb the vendored tree**

Run:
```powershell
git status --porcelain bookmarks-to-obsidian/node_modules
echo "lines_above_should_be_zero"
```
Expected: **no output** before the echo line. The root `file:` dependency symlinks the skill folder and hoists its deps into the *root* `node_modules/`; it must not modify the committed `bookmarks-to-obsidian/node_modules/`. If anything prints, stop and investigate before continuing.

- [x] **Step 5: Build the `.skill` archive**

Run:
```powershell
npm run package
```
Expected: prints `Packaged NNNN files -> dist\bookmarks-to-obsidian.skill` (NNNN in the thousands). `dist/` is gitignored.

- [x] **Step 6: Verify the archive is copy-and-run (includes node_modules, runs offline)**

Run:
```powershell
$tmp = Join-Path $env:TEMP 'b2o-skill-extract'
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory((Resolve-Path dist/bookmarks-to-obsidian.skill).Path, $tmp)
"node_modules_in_archive=$(Test-Path "$tmp/bookmarks-to-obsidian/node_modules/defuddle")"
node "$tmp/bookmarks-to-obsidian/scripts/import.mjs" --help
node scripts/smoke-extract.mjs "$tmp/bookmarks-to-obsidian"
```
Expected:
- `node_modules_in_archive=True`
- the `--help` usage text prints (exit 0)
- `SMOKE OK: status=ok wordCount=… contentChars=…`

(`ZipFile::ExtractToDirectory` is used instead of `Expand-Archive` because the latter rejects the non-`.zip` extension.)

- [x] **Step 7: Commit the packager**

```powershell
git add scripts/package-skill.mjs package.json package-lock.json
git commit -m "build(package): add .skill packager that bundles node_modules" -m "Add scripts/package-skill.mjs (repo-root dev tool, never ships) and an npm run package script. It zips bookmarks-to-obsidian/ into dist/bookmarks-to-obsidian.skill INCLUDING the vendored node_modules/, mirroring the official packager's archive layout but keeping the deps the official packager strips — so the .skill route is copy-and-run too." -m "Adds archiver as a root devDependency (dev harness only; never ships in the skill)."
```

---

## Task 4: Update the README — install becomes copy-and-run

**Files:**
- Modify: `README.md` (Install section ~lines 33–52; "Building a distributable `.skill`" section ~lines 154–174)

- [x] **Step 1: Replace the Install section with the no-install version**

Replace the entire current Install block (from the `## Install` heading through the paragraph ending `…whenever you copy the folder to a new machine.`) with:

````markdown
## Install

The skill is a single, self-contained folder — copy it in and start using it. No
`npm install`, no build step: its dependencies ship inside the folder.

```bash
git clone https://github.com/JuliusGruber/bookmarks-to-obsidian-skill.git
cp -r bookmarks-to-obsidian-skill/bookmarks-to-obsidian ~/.claude/skills/bookmarks-to-obsidian
```

Then ask Claude to import your bookmarks — that's it.

- **Personal skill (all projects):** use `~/.claude/skills/` as shown. For a
  **project-scoped** skill, copy into `<project>/.claude/skills/` instead.
- **Windows:** the skills directory is `C:\Users\<you>\.claude\skills\`.
- **ZIP download** works too — copy the **inner** `bookmarks-to-obsidian/` folder
  (not the `-main` wrapper GitHub adds). Nothing to install afterward.

Keep the folder named `bookmarks-to-obsidian` — Claude discovers the skill from
its `SKILL.md`. The folder is copy-and-run: its `node_modules/` ships with it, so
moving it to a new machine needs no `npm install`.
````

- [x] **Step 2: Rewrite the "Building a distributable `.skill`" section**

Replace the entire current "### Building a distributable `.skill`" section (from that heading through the paragraph ending `…same runtime-only install as under [Install](#install).)`) with:

````markdown
### Building a distributable `.skill`

The skill can also be published as a single `.skill` file — a zip of the
`bookmarks-to-obsidian/` folder. Anthropic's official packager strips
`node_modules/`, which would force recipients to run `npm install`; this repo
ships its own packager that **includes** the vendored `node_modules/`, so the
archive is copy-and-run too. Build it from the repo root:

```bash
npm install      # once — installs the dev/test harness, including the packager
npm run package  # writes dist/bookmarks-to-obsidian.skill (gitignored)
```

The archive contains `node_modules/`, so a recipient unzips it into their skills
directory and uses it immediately — **no `npm install`**.

#### Re-vendoring after a dependency bump

The skill's `node_modules/` is committed. After changing a dependency in
`bookmarks-to-obsidian/package.json` (and its `package-lock.json`), refresh the
committed tree:

```bash
npm run vendor                            # = (cd bookmarks-to-obsidian && npm ci --omit=dev)
git add bookmarks-to-obsidian/node_modules
```

Use `--omit=dev` only — **not** `--omit=optional`. `defuddle/node` loads
`linkedom` and `turndown` from `optionalDependencies` at runtime, so omitting
optionals would pass `--help` but break real extraction. The tree is pure
JavaScript (no package compiles native code), so a tree vendored on one OS runs on
every OS.
````

- [x] **Step 3: Verify no stale `npm install` instructions remain in Install**

Run:
```powershell
Select-String -Path README.md -Pattern "re-run `npm install`","isn't committed" -SimpleMatch
```
Expected: **no matches** (the old "node_modules/ isn't committed, so re-run npm install" note is gone). The `npm install` under the **Development** section is expected to remain — that is the root harness, not the install step.

- [x] **Step 4: Commit**

```powershell
git add README.md
git commit -m "docs(readme): install is copy-and-run; document new .skill packager" -m "Collapse Install to clone -> copy (no npm install, no cd, no build). Rewrite 'Building a distributable .skill' to use npm run package (archive now includes node_modules/) and document the npm run vendor re-vendor procedure."
```

---

## Task 5: Update CLAUDE.md conventions

**Files:**
- Modify: `CLAUDE.md` (the "## Tests live at the repo root, outside the skill folder" section)

- [x] **Step 1: Replace the closing paragraph of the "Tests live at the repo root" section**

In `CLAUDE.md`, the three bullet points (test suite in `test/`, skill `package.json` runtime-only, root `package.json` is the harness) stay **unchanged** — they are still accurate. Replace only the final paragraph of that section:

Current text to replace:
```markdown
When packaging a `.skill`, only the `bookmarks-to-obsidian/` folder ships;
`node_modules/` is excluded and the root harness stays behind.
```

New text:
````markdown
The skill **ships its vendored `node_modules/`**: the committed
`bookmarks-to-obsidian/node_modules/` is a runtime-only tree (`npm ci --omit=dev`
from the skill's lockfile) so the copied folder runs with **no `npm install`**.
Both distribution routes are copy-and-run — the repo's own packager
(`npm run package`) includes `node_modules/` in the `.skill` archive (the official
`skill-creator` packager strips it). The tree is pure JavaScript (nothing compiles
native code), so it is cross-platform. The root harness still stays behind.

Re-vendor after a dependency bump (keeps the committed tree correct):

```
npm run vendor                            # (cd bookmarks-to-obsidian && npm ci --omit=dev)
git add bookmarks-to-obsidian/node_modules
```

Keep `--omit=dev` **only** — not `--omit=optional`: `defuddle/node` loads
`linkedom` and `turndown` from `optionalDependencies` at runtime, so omitting
optionals would pass `--help` but break real extraction.
````

- [x] **Step 2: Commit**

```powershell
git add CLAUDE.md
git commit -m "docs(claude): skill now ships vendored node_modules" -m "Revise the 'Tests live at the repo root' convention: the skill commits a runtime-only node_modules/ and the .skill archive includes it (copy-and-run). Document the npm run vendor re-vendor procedure and why it must stay --omit=dev (not --omit=optional)."
```

---

## Task 6: Full verification pass (acceptance)

No code changes expected. If any check fails, fix the cause and re-run that check.

- [x] **Step 1: Root dev harness still passes**

Run:
```powershell
npm install
npm test
```
Expected: `npm test` runs the vitest suite from `test/` against `bookmarks-to-obsidian/scripts/src` and reports all tests passing (no failures).

- [x] **Step 2: Pollution guard — the test run did not alter the vendored tree**

Run:
```powershell
git status --porcelain bookmarks-to-obsidian/node_modules
echo "lines_above_should_be_zero"
```
Expected: no output before the echo line. (Confirms the root harness and test run leave the committed vendored tree untouched.)

- [x] **Step 3: Fresh-copy acceptance — copy the folder, run with no install, offline**

This is the real acceptance test: a clean copy of just the skill folder, no `npm install`, no network dependency (both commands below make zero network calls).
```powershell
$fresh = Join-Path $env:TEMP 'b2o-freshcopy'
Remove-Item -Recurse -Force $fresh -ErrorAction SilentlyContinue
Copy-Item -Recurse bookmarks-to-obsidian $fresh
node "$fresh/scripts/import.mjs" --help
node scripts/smoke-extract.mjs $fresh
```
Expected:
- `--help` prints the usage text (exit 0) — all deps resolve from the copied tree.
- `SMOKE OK: status=ok wordCount=… contentChars=…` — real extraction (linkedom + turndown) works from the copied tree.

- [x] **Step 4: Cross-platform spot check — no native binaries vendored**

Run:
```powershell
"native_node_files=" + (Get-ChildItem bookmarks-to-obsidian/node_modules -Recurse -Filter *.node -File -ErrorAction SilentlyContinue | Measure-Object).Count
```
Expected: `native_node_files=0`. Because the tree is pure JS, a Windows-vendored tree runs unchanged on macOS/Linux.

- [x] **Step 5: Clean up temp artifacts (optional)**

```powershell
Remove-Item -Recurse -Force (Join-Path $env:TEMP 'b2o-freshcopy'),(Join-Path $env:TEMP 'b2o-skill-extract') -ErrorAction SilentlyContinue
```

- [x] **Step 6: Push**

```powershell
git push origin main
```
Expected: all Task 1–5 commits land on `origin/main`. (Per repo convention, work commits directly to `main`.)

---

## Self-review (author's check against the spec)

**Spec coverage:**
- Change #1 "Vendor the runtime dependency tree" → Task 2 (command corrected to `npm ci --omit=dev`; see deviation note).
- Change #2 ".gitignore anchor" → Task 1.
- Change #3 "Replace the `.skill` build step" → Task 3 (`scripts/package-skill.mjs` + `npm run package`).
- Change #4 "Documentation: README + CLAUDE.md" → Tasks 4 & 5.
- Change #5 "Re-vendor procedure" → documented in Tasks 4 & 5 (`npm run vendor`), command corrected.
- Spec "Testing / verification": existing suite → Task 6 Step 1; fresh-copy smoke → Task 6 Step 3; `.skill` archive check → Task 3 Step 6; cross-platform spot check → Task 6 Step 4. The spec's `--help`-only smoke is **strengthened** to also run real extraction (Task 2 Step 6, Task 3 Step 6, Task 6 Step 3) to catch the optional-dep failure mode.
- Spec "Out of scope" (engine, bundling/auto-install, prerequisites, pruning) → honoured; no engine files touched.

**Type/name consistency:** `extractFromHtml(html, url, { minWords })` returning `{ status, content, wordCount, meta }` is used consistently by `scripts/smoke-extract.mjs`. The npm scripts `vendor`/`package` and the file names `scripts/smoke-extract.mjs` / `scripts/package-skill.mjs` are referenced identically across all tasks and docs.

**Placeholder scan:** no TBD/"handle errors"/"similar to" placeholders; every code and doc step contains literal content.
