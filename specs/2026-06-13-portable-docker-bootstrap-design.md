# Portable auto-bootstrap — self-contained, cross-platform gateway startup

- **Date:** 2026-06-13
- **Skill:** `bookmarks-to-obsidian`
- **Status:** design approved (2026-06-13); implementation plan pending

## Problem

The skill depends on the `chrome-bookmarks-gateway` service being up at
`http://localhost:3000`. Today that dependency is brought up by a machine-specific
PowerShell script, `C:\Users\juliu\cbg-up.ps1`, which is **not part of the skill**
and references a CDP proxy (`C:\Users\juliu\cbg-cdp-proxy.cjs`) that also lives
outside the skill folder. Worse, SKILL.md hardcodes this machine's absolute paths
for the tool, the vault, and the bookmark folder.

Consequences:

- The skill is **not self-contained**: copying the skill folder onto another
  machine leaves the gateway down with no bundled way to start it, and SKILL.md
  points at paths that exist only on the original machine.
- When the gateway is down, the skill's documented behavior is to *tell the user*
  to run an external script — not to bring the dependency up itself.

The desired end state: a user copies the skill into their Claude skills folder, and
on first use the skill brings its own dependency stack up (modulo prerequisites it
cannot install), asking for consent once.

## Goal

Make the gateway dependency **start itself, from inside the skill, on any OS**, the
first time the skill is used — and make the skill's tool/vault/folder configuration
portable rather than hardcoded.

### Decisions (from brainstorming)

1. **Keep Docker, automate it.** The gateway stays a Docker container
   (`pvoronin/chrome-bookmarks-gateway:0.3.0`, pinned). We do not vendor a
   Dockerfile or remove Docker; we bundle a bootstrap that brings the existing
   3-part stack up.
2. **Target: any machine, any OS** (Windows / macOS / Linux).
3. **Consent model: ask once, then automatic.** First time the gateway is down,
   Claude explains what it will launch and asks; thereafter it bootstraps silently.

## Hard constraints (cannot be made zero-touch)

These are surfaced to the user, detected by the bootstrap, and guided by Claude —
but **nothing can script them**:

- **Docker must be installed and running.** A skill cannot install Docker Desktop
  or start its daemon.
- **Chrome / Chromium must be installed.** A skill cannot install a browser.
- **Google sign-in + bookmark sync** must be done once, interactively, in the
  dedicated Chrome window. Until then `/syncz` returns `503`. This is the single
  irreducible manual step on every fresh machine.
- **First image pull needs internet.** Pulling the pinned gateway image the first
  time requires network access.

### Known risk to verify during implementation

- **Apple Silicon (arm64):** `pvoronin/chrome-bookmarks-gateway:0.3.0` may be
  amd64-only. On arm64 Macs it would run under emulation or fail. First
  implementation step: inspect the image's published architectures; if amd64-only,
  document the limitation in SKILL.md (and rely on Docker Desktop's emulation).

## Architecture

A single **Node** orchestrator, `bootstrap.mjs`, bundled in the skill folder. Node
is chosen deliberately: it is already a hard dependency of the skill (the importer
CLI and `puppeteer-core`), so it is the one runtime guaranteed present on every
target machine. This avoids per-OS shell scripts and gives one cross-platform code
path.

The bootstrap reproduces, portably, what `cbg-up.ps1` did — and the external
`cbg-cdp-proxy.cjs` is **moved into the skill folder** so nothing lives outside it.

### What `bootstrap.mjs` brings up (idempotent, in order)

1. **Preflight.**
   - `docker version` — is the daemon reachable? If not → status `docker-unavailable`.
   - Locate the Chrome/Chromium binary for the current OS. If not found →
     status `chrome-not-found`.
2. **Dedicated Chrome.** Launch an isolated-profile Chrome:
   `--remote-debugging-port=9222 --remote-allow-origins=*
   --user-data-dir=<profile> --no-first-run --no-default-browser-check about:blank`.
   - Idempotency by **probing** `http://127.0.0.1:9222/json/version` (cross-platform;
     avoids OS-specific process matching). If it already answers, skip launching.
3. **CDP proxy.** Start the bundled `cbg-cdp-proxy.cjs` binding
   `0.0.0.0:9223 → 127.0.0.1:9222`.
   - Idempotency by probing `127.0.0.1:9223`.
   - Kept on **all** platforms (one code path): Chrome binds remote debugging to
     loopback and enforces an origin/Host check, so the container cannot reach it
     directly. The proxy is what makes the container able to connect.
4. **Gateway container.**
   ```
   docker run -d --name cbg -p 3000:3000 \
     --add-host=host.docker.internal:host-gateway \
     -e AUTH_TOKEN=off \
     -e CHROME_CDP_URL=http://host.docker.internal:9223 \
     pvoronin/chrome-bookmarks-gateway:0.3.0
   ```
   - Uses `host.docker.internal` **everywhere** instead of the brittle hardcoded
     `192.168.65.254`. The `--add-host=...:host-gateway` flag makes that name
     resolve on native Linux Docker too (it already resolves on Docker Desktop).
   - Idempotent: remove any existing `cbg` container, then run.
5. **Poll** `GET http://localhost:3000/syncz` until one of:
   - `200` → `ready`
   - `503` → `not-synced` (gateway up, Chrome not signed into Google sync yet)
   - timeout / unreachable → `down`

### Output contract

`bootstrap.mjs` prints a single JSON object to stdout that Claude parses, e.g.:

```json
{
  "status": "ready | not-synced | docker-unavailable | chrome-not-found | down",
  "chrome": "running | launched | not-found",
  "proxy": "running | started",
  "container": "running | started | failed",
  "syncz": { "status": 200, "ok": true }
}
```

It **refuses to run if consent has not been recorded** (safety belt), exiting with a
distinct status so Claude knows to ask first.

## Per-user state & configuration

One JSON file holds all per-user state, in an OS-appropriate config directory —
**outside the skill folder**, so re-copying the skill never wipes consent or config.

`<config-dir>/bookmarks-to-obsidian/config.json`:

```json
{
  "consentedAt": "<iso-8601>",
  "vault": "/path/to/Obsidian/Vault",
  "folder": "Mobile Lesezeichen/AI",
  "inbox": "Clippings"
}
```

`config-dir` resolution:

- **Windows:** `%APPDATA%\bookmarks-to-obsidian\`
- **macOS / Linux:** `$XDG_CONFIG_HOME/bookmarks-to-obsidian/` or
  `~/.config/bookmarks-to-obsidian/`

### How config is used

- **Consent:** Claude reads `consentedAt`. Absent → explain (launches a dedicated
  Chrome, starts a container, binds ports 3000/9222/9223) and ask once. On yes,
  write `consentedAt` and bootstrap. Present → bootstrap silently when down.
- **Vault / folder / inbox:** replace SKILL.md's hardcoded
  `C:\Users\juliu\Documents\AIEngineeringArticles` etc. On first use, if `vault`
  is unset, Claude asks for the user's Obsidian vault path and validates it: the
  directory must exist (hard requirement — reject and re-ask if not); a missing
  `.obsidian/` folder is a soft warning that does not block. On success, write it.
  The importer CLI is
  **unchanged** — Claude passes the configured values as the existing
  `--vault` / `--folder` / `--inbox` flags instead of literals.
- **Tool path:** SKILL.md stops hardcoding the absolute `import.mjs` path. It
  invokes `node <this-skill-dir>/import.mjs` and `node <this-skill-dir>/bootstrap.mjs`,
  resolved relative to the skill's own location.

## File layout (inside `bookmarks-to-obsidian/`)

- `bootstrap.mjs` *(new)* — thin imperative orchestrator: preflight → Chrome →
  proxy → container → poll → print JSON status. Refuses to run without consent.
- `cbg-cdp-proxy.cjs` *(new — moved in from `C:\Users\juliu\`)* — the CDP proxy,
  now bundled with the skill.
- `src/bootstrap/` *(new — small, pure, independently testable units)*:
  - `chrome.mjs` — `findChromePath(platform, env)`, `chromeArgs(profileDir)`
  - `docker.mjs` — `dockerRunArgs({ image, hostCdpUrl })`, `isDaemonUp()`
  - `probe.mjs` — `probeUrl(url)` (Chrome / proxy / gateway liveness)
  - `syncz.mjs` — `interpretSyncz(status, body)` → `ready | not-synced | down`
  - `config.mjs` — resolve config-dir per OS; read/write config; tiny CLI
    (`node config.mjs --get`, `node config.mjs --set vault=…`) so path-resolution
    lives in one tested place rather than being guessed by Claude.
- `SKILL.md` — rewritten (below).
- `test/` — unit tests for the pure helpers.

### Design-for-isolation note

`bootstrap.mjs` is a thin **imperative shell** (it spawns processes and the
container). All decision logic — Chrome-path detection, Docker arg construction,
`/syncz` interpretation, config-dir resolution — lives in `src/bootstrap/*` pure
functions that can be unit-tested without spawning anything.

## SKILL.md rewrite (behavioral contract)

- **Prerequisites** *(new section)*: Docker and Chrome must be installed; one-time
  Google sign-in noted; Apple Silicon caveat if confirmed.
- **Configuration** *(replaces "Defaults (this machine)")*: values come from
  `config.json`; first run asks for the vault; tool paths are skill-relative.
- **Workflow step 1** *(rewritten)*: health-check `/syncz` → if down: check consent
  → ask once if needed → `node bootstrap.mjs` → re-check. Branch on the bootstrap's
  JSON `status`:
  - `docker-unavailable` → tell the user to install/start Docker Desktop; stop.
  - `chrome-not-found` → tell the user to install Chrome/Chromium; stop.
  - `not-synced` / `503` → tell the user to sign into Google and enable bookmark
    sync in the dedicated Chrome window (the one manual step); re-check after.
  - `ready` → proceed to import.
- Remove all `cbg-up.ps1` references. (Optional: a 2-line `cbg-up.ps1` / `cbg-up.sh`
  wrapper that just calls `node bootstrap.mjs`, for users who prefer running it by
  hand — not required.)

## Testing

Matches the existing repo (vitest, `src/*.mjs` + `test/*.test.mjs`). Unit tests for
the pure helpers:

- `findChromePath` across `win32` / `darwin` / `linux` candidate sets (env-injected,
  no real filesystem dependence on the test machine).
- `dockerRunArgs` produces the expected flag/arg array (incl. `host.docker.internal`
  and `--add-host`).
- `interpretSyncz` maps `(status, body)` → `ready | not-synced | down`.
- Config-dir resolution per OS (`%APPDATA%` vs `$XDG_CONFIG_HOME` vs `~/.config`).
- Config read/write round-trip (incl. partial config, missing file).

The process-spawning in `bootstrap.mjs` is the thin imperative shell — kept minimal
and verified by a real first run on each OS rather than mocked.

## Scope

**In scope:** self-contained cross-platform dependency bootstrap; bundling the CDP
proxy; per-user consent + vault/folder/inbox configuration; skill-relative tool
paths; SKILL.md rewrite; unit tests for pure helpers.

**Out of scope (cannot be scripted):** installing Docker or Chrome; the Google
sign-in / bookmark-sync step. The skill detects these and guides the user; it does
not perform them.
