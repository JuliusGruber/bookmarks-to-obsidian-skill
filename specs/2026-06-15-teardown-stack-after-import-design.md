# Teardown — shut the gateway stack down after imports finish

- **Date:** 2026-06-15
- **Skill:** `bookmarks-to-obsidian`
- **Status:** design approved (2026-06-15); implementation plan pending

## Problem

`bootstrap.mjs` brings a three-part stack up — a dedicated debugging Chrome on
`:9222`, the bundled CDP proxy (`cbg-cdp-proxy.cjs`) on `:9223`, and the gateway
Docker container `cbg` on `:3000`. Nothing ever brings it back down. `render.mjs`
only connects/disconnects (it deliberately never closes the browser), and
`import.mjs` exits leaving everything running.

Consequence: after an import the user is left with a headless Chrome, a node proxy
process, and a Docker container running indefinitely — consuming RAM and a browser
process for no reason until the machine reboots or the user manually cleans up.
There is no bundled, portable way to tear the stack down.

The desired end state: when the skill is done for the session, it shuts the whole
stack down with one command, symmetric to how `bootstrap.mjs` brings it up.

## Goal

Add a bundled, cross-platform **`teardown.mjs`** that stops everything
`bootstrap.mjs` started — container, proxy, and the dedicated Chrome — idempotently,
and have the skill invoke it as its final step once imports are done.

## Decisions (from brainstorming)

1. **Separate CLI, not an import flag.** Teardown is a new `scripts/teardown.mjs`
   mirroring `bootstrap.mjs` (thin shell, single JSON object, pure helpers). It
   keeps `import.mjs` focused on importing and stays symmetric with bootstrap.
2. **Always tear down, regardless of who started the stack.** Workflow step 1 skips
   bootstrap when `/syncz` already answers `ok`, so the stack may predate this
   session. Teardown does not try to track origin — it shuts the stack down either
   way. This keeps behavior predictable and needs no persisted "we-started-it"
   state. (It also drives the proxy-kill mechanism below: a PID file written by
   bootstrap would not exist for a stack started by other means.)
3. **Tear down all three components**, in reverse of startup order: container →
   proxy → Chrome. The user named Chrome + container; the proxy is part of the same
   stack and comes down too for full symmetry.
4. **Skill fires it on finish, but keeps the stack warm after a `--dry-run`.**
   Teardown runs whenever the skill finishes for the session — after an import run,
   after a "no new bookmarks" stop, or after the user defers/declines everything
   without importing. It is **skipped right after a `--dry-run` preview**, because a
   real import is expected to follow and a cold restart would be wasteful.

## Non-goals / constraints

- **No consent gate.** Unlike `bootstrap.mjs`, teardown takes no consent: it only
  ever touches the skill's own isolated stack, never user data. It is pure resource
  cleanup.
- **Never touches the user's everyday Chrome.** Teardown closes only the isolated
  debugging instance on `:9222` (launched with the skill's own
  `--user-data-dir`). The user's normal browser is not on that port and is never
  affected.
- **Sign-in is preserved.** Chrome is closed, not wiped. The Google sign-in /
  bookmark-sync state lives in the persistent profile dir, so the next
  `bootstrap.mjs` relaunches a signed-in Chrome with no re-sync needed.
- **`render.mjs` is unchanged** — it still only connects/disconnects. Teardown is
  the separate, explicit closer.

## Architecture

A single **Node** CLI, `scripts/teardown.mjs`, bundled in the skill folder — the
mirror of `bootstrap.mjs`. Node is already a hard dependency (`import.mjs`,
`puppeteer-core`), so it is the one runtime guaranteed present, giving one
cross-platform code path with no per-OS shell scripts.

The thin shell spawns OS actions and assembles output; all decision logic lives in
pure, unit-tested helpers under `scripts/src/bootstrap/teardown.mjs`.

### What `teardown.mjs` brings down (idempotent, reverse order)

1. **Container.** `docker rm -f cbg` (force-remove, stops and deletes in one step).
   - If the Docker daemon is unreachable (`isDaemonUp()` is false), the container
     cannot be running, so the goal state is already met — reported
     `docker-unavailable`, not an error.
   - Removing an already-absent container is reported `absent`, not an error.
2. **Proxy (`:9223`).** Find the PID holding the listening socket via an
   OS-specific lookup, kill it, then verify `:9223` is unreachable.
   - **Windows:** `netstat -ano -p tcp`, parse the `LISTENING` row whose local
     address ends in `:9223`, take the PID column, then `taskkill /F /PID <pid>`.
   - **POSIX:** `lsof -nP -iTCP:9223 -sTCP:LISTEN -t` → PID(s) → `kill`.
     (`lsof` is standard on macOS and typical dev Linux; documented as best-effort
     on minimal Linux without it.)
   - Nothing listening on `:9223` → reported `absent`.
3. **Chrome (`:9222`).** Close it **over CDP**, not by PID:
   `puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' })` → `browser.close()`.
   `puppeteer-core` is already a dependency. This closes only the isolated instance
   on `:9222`. If `:9222` is unreachable, Chrome is already down → reported
   `absent`.

Each step is **idempotent**: a piece already gone is reported `absent`, never an
error. Running teardown twice → all `absent`, `status: "down"`.

### Why CDP-close for Chrome but port-lookup for the proxy

Chrome speaks CDP, so closing it is both portable and exact — no OS process
matching, and it targets precisely the `:9222` instance. The proxy is a bare TCP
forwarder with no control channel, so the only origin-independent way to find it is
by who holds the `:9223` listening socket. Port-lookup is chosen over a
bootstrap-written PID file deliberately: it honors decision (2) — a PID file would
not exist for a stack someone else started — at the cost of leaning on `lsof` on
POSIX. Windows is first-class; POSIX `lsof` is the documented path.

### Output contract

`teardown.mjs` prints a single JSON object to stdout that Claude parses:

```json
{
  "status":    "down | partial",
  "container": "removed | absent | docker-unavailable | error",
  "proxy":     "killed | absent | error",
  "chrome":    "closed | absent | error"
}
```

- `status: "down"` — nothing from the stack is running (the goal). Reached when no
  component is in `error`.
- `status: "partial"` — at least one component resisted teardown (`error`); the
  per-component fields tell the skill what to surface.
- State is **verified** after acting — `:9222` and `:9223` are re-probed and treated
  as the authority, not just spawn exit codes — so the report reflects reality.

## File layout (inside `bookmarks-to-obsidian/`)

- `scripts/teardown.mjs` *(new)* — thin imperative shell: container → proxy →
  Chrome → verify → print one JSON object. No consent gate.
- `scripts/src/bootstrap/teardown.mjs` *(new — small, pure, independently testable)*:
  - `dockerRmArgs(name = 'cbg')` → `['rm', '-f', 'cbg']`.
  - `listenerPidCommand(platform, port)` → the argv to list the listener
    (`netstat`/`lsof`), and `parseListenerPids(platform, output)` → `number[]`.
  - `killPidCommand(platform, pid)` → the argv to kill it (`taskkill`/`kill`).
  - `classifyTeardown({ container, proxy, chrome })` → `'down' | 'partial'`.
- Reuses existing helpers: `probe.mjs` `probeUrl` (final-state verification),
  `docker.mjs` `isDaemonUp`.
- `SKILL.md` — updated (below).
- `test/` — unit tests for the new pure helpers.

### Design-for-isolation note

`teardown.mjs` is a thin **imperative shell** (it spawns processes / the docker CLI
and connects puppeteer). All decision logic — docker arg construction, listener
lookup command + output parsing, kill command, result classification — lives in
`src/bootstrap/teardown.mjs` pure functions, unit-testable without spawning
anything.

## SKILL.md changes (behavioral contract)

- **New final workflow step** (after step 7, "Summarize the report"): run
  `node scripts/teardown.mjs`, parse its JSON, and report the result in one line —
  e.g. "Stack shut down." On `status: "partial"`, surface which component resisted.
- **Fire on finish, including the empty path.** Teardown runs whenever the skill
  finishes for the session: after the import/decline run, after the "no new
  bookmarks" stop (current step 3), and after the user defers or declines
  everything without importing — the skill brought (or found) the stack up and is
  now done.
- **Skip after `--dry-run`.** When the user ran a dry-run preview (step 6 with
  `--dry-run`), do **not** tear down — a real import is expected to follow and the
  stack should stay warm.
- **Update the "left running" wording.** The Overview and Rendering sections
  currently say the gateway's Chrome is "left running". Reword to note that
  `render.mjs` leaves it running *during* the run, and the skill explicitly tears
  the whole stack down as its final step.

## Testing

Matches the existing repo (vitest, `src/*.mjs` + `test/*.test.mjs`). Unit tests for
the pure helpers:

- `dockerRmArgs` produces `['rm', '-f', 'cbg']` (and honors a custom name).
- `classifyTeardown` maps every combination of component outcomes to the correct
  `status` (`down` when none are `error`; `partial` when any is `error`;
  `docker-unavailable`/`absent` are not errors).
- `listenerPidCommand` / `parseListenerPids` for `win32` and `posix` against
  captured `netstat -ano` and `lsof` sample output (including the empty case → no
  PIDs, and multiple PIDs).
- `killPidCommand` produces the expected `taskkill` / `kill` argv per platform.

The process-spawning / puppeteer-connect in `teardown.mjs` is the thin imperative
shell — kept minimal and verified by a real run rather than mocked (matching how
`bootstrap.mjs` is treated).

## Scope

**In scope:** a bundled cross-platform `teardown.mjs` that stops the container,
proxy, and dedicated Chrome idempotently with a verified single-JSON-object report;
pure unit-tested helpers; SKILL.md workflow integration (fire on finish, skip after
dry-run); unit tests.

**Out of scope:** changing `render.mjs` (still connect/disconnect only); tracking
which session started the stack (decision 2 — always tear down); a consent gate for
teardown; wiping the Chrome profile (sign-in is preserved); auto-teardown inside
`import.mjs` (rejected in favor of the separate CLI).
