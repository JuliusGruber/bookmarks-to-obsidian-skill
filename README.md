# bookmarks-to-obsidian (Claude skill)

A self-contained Claude Code skill that imports your Chrome bookmarks into an
Obsidian vault as clean, Web-Clipper-quality markdown notes — full article text
and images included. You ask Claude in plain language ("import my AI bookmarks")
and the skill handles the rest, including **starting its own dependency stack**
(a Dockerized bookmark gateway plus a dedicated Chrome) the first time you use it,
after a single consent prompt. No manual setup scripts.

The skill is the **[`bookmarks-to-obsidian/`](./bookmarks-to-obsidian)** folder —
that's the copy-pastable unit you drop into your Claude skills directory.
Everything else in this repo is scaffolding that never ships: this README,
`LICENSE`, the root-level `test/` suite, and the `specs/` and `plans/` folders.

## Requirements

The skill brings its own stack up, but four things must exist first. It detects
each one and tells you what's missing:

- **Node 20+** — to run the skill.
- **Docker, installed and running** — the gateway runs as a pinned container.
  (On Apple Silicon the image is amd64-only, so it runs under Docker Desktop's
  emulation — slower, but functional.)
- **Chrome or Chromium, installed** — the skill opens a *dedicated, isolated*
  Chrome window it controls, separate from your everyday browser. Set
  `CBG_CHROME` / `CHROME_PATH` if it lives in a non-standard location.
- **A Google account** — you sign into it once in that dedicated window and turn
  on bookmark sync, so the gateway can read your bookmarks.

Plus an internet connection on the first run to pull the gateway image.

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

## Usage

Just ask Claude, in natural language:

> "import my AI bookmarks"
> "sync my bookmarks to Obsidian"
> "pull new bookmarks into the vault"

What happens on a first run:

1. **Bootstrap.** Claude checks whether the gateway is up. If it isn't, it
   explains that it will launch a dedicated Chrome, a small local helper, and a
   Docker container (using local ports `3000`, `9222`, and `9223`), and **asks
   your permission once**. On yes, it brings the whole stack up automatically.
2. **Sign in (once).** A dedicated Chrome window opens. Sign into Google there and
   turn on **sync with bookmarks included**. This is the only manual step — the
   isolated profile remembers it for next time.
3. **Pick your vault (once).** Claude asks for your Obsidian vault path and saves
   it, so you never have to repeat it.
4. **Dry run.** Claude previews a handful of articles so you can judge quality
   before anything is written.
5. **Import.** Claude writes the new notes into a `Clippings/` inbox in your vault
   (full text plus downloaded images as Obsidian embeds), then summarizes how many
   were imported, skipped, or failed.
6. **Follow-ups.** Ask it to retry failures, import the full backlog, or open the
   inbox.

Later runs skip straight to importing — consent, sign-in, and vault are all
remembered.

### Running the importer directly (optional)

Once the stack is up, you can drive the engine without Claude. From the skill
folder:

```bash
# preview (renders, writes nothing)
node scripts/import.mjs --vault "/path/to/Vault" --folder "Mobile Lesezeichen/AI" --dry-run --limit 10

# real import (writes notes; omit --limit for the full backlog)
node scripts/import.mjs --vault "/path/to/Vault" --folder "Mobile Lesezeichen/AI"

# every flag
node scripts/import.mjs --help
```

`--folder` is the Chrome bookmark folder to import (use the full path if the name
is ambiguous). Add `--retry-failed` to re-attempt earlier failures and thin skips.

## Configuration

Your settings live in a config file **outside** the skill folder, so updating or
re-copying the skill never wipes them:

- **Windows:** `%APPDATA%\bookmarks-to-obsidian\config.json`
- **macOS / Linux:** `$XDG_CONFIG_HOME/bookmarks-to-obsidian/` or
  `~/.config/bookmarks-to-obsidian/`

Read or change it with the bundled CLI (run from the skill folder):

```bash
node scripts/src/bootstrap/config.mjs --get                       # show current config
node scripts/src/bootstrap/config.mjs --set vault="/path/to/Vault"
node scripts/src/bootstrap/config.mjs --set folder="Mobile Lesezeichen/AI"
node scripts/src/bootstrap/config.mjs --path                      # print the config file location
```

Fields: `vault` (your Obsidian vault root), `folder` (bookmark folder to import),
`inbox` (destination subfolder, default `Clippings`), and `consentedAt` (stamped
when you grant bootstrap permission).

## Troubleshooting

If a run can't start, the bootstrap reports a status that tells you what to fix:

| Status | What it means / what to do |
| --- | --- |
| `docker-unavailable` | Docker isn't running — start Docker Desktop and retry. |
| `chrome-not-found` | No Chrome/Chromium found — install one, or set `CBG_CHROME` to its path. |
| `not-synced` | The gateway is up but the dedicated Chrome isn't signed in — sign into Google and enable bookmark sync in that window. |
| `needs-consent` | Permission wasn't recorded yet — approve the one-time prompt, or run `node scripts/src/bootstrap/config.mjs --consent`. |
| `down` | The stack didn't come up — check Docker, and that ports `3000` / `9222` / `9223` are free. |
| `ready` | Everything's up — imports will run. |

## Development

This repository is a thin wrapper around the distributable skill. The skill — the
only thing users copy or that gets packaged into a `.skill` — is the
self-contained [`bookmarks-to-obsidian/`](./bookmarks-to-obsidian) folder, whose
`package.json` declares **runtime dependencies only**. The **test suite lives in
[`test/`](./test) at the repo root, deliberately *outside* the skill folder**, so
it never ships to users. The outer `package.json` is the dev/test harness: it
pulls in `vitest` and packaging tools only. Tests import runtime code and the
vendored Defuddle module directly from the skill folder, so the skill's lockfile
and committed `node_modules/` remain the single source of truth. A `file:`
dependency is intentionally avoided because root `npm install` can prune the
skill's committed dependency tree while cleaning the linked package.

```bash
npm install   # at the repo root — vitest + packaging tools
npm test      # runs the suite against bookmarks-to-obsidian/scripts/src
```

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
JavaScript (no package compiles native code), so a tree vendored on one OS runs
on every OS.

## License

MIT — see [`LICENSE`](./LICENSE).
