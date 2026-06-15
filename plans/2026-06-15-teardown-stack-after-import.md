# Teardown the gateway stack after imports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bundled, cross-platform `teardown.mjs` that idempotently stops the whole gateway stack (container → proxy → Chrome) with a verified single-JSON report, and have `SKILL.md` invoke it as the skill's final step.

**Architecture:** Mirror `bootstrap.mjs`. A thin imperative shell `scripts/teardown.mjs` spawns OS/docker actions, connects puppeteer, and re-probes `:9222`/`:9223` to verify the final state; all decision logic (docker argv, listener lookup command + output parsing, kill command, status classification) lives in pure, unit-tested helpers in `scripts/src/bootstrap/teardown.mjs`. Each step is idempotent — a component already gone is reported `absent`, never an error. No consent gate (teardown only touches the skill's own isolated stack).

**Tech Stack:** Node ESM, `puppeteer-core` (already a dependency, used for CDP-close of Chrome), `node:child_process` (`spawnSync` for docker/`netstat`/`lsof`/`taskkill`/`kill`), reused `probe.mjs` `probeUrl` and `docker.mjs` `isDaemonUp`. Tests: vitest, root `test/` importing from `../bookmarks-to-obsidian/scripts/src/`.

---

## Spec reference

`specs/2026-06-15-teardown-stack-after-import-design.md`.

## Background the engineer must know

- **The stack `bootstrap.mjs` brings up (startup order):** dedicated debugging
  Chrome on `:9222` → bundled CDP proxy on `:9223` (`cbg-cdp-proxy.cjs`) → gateway
  Docker container named `cbg` on `:3000`. Teardown reverses this: container →
  proxy → Chrome.
- **The repo splits a thin shell from pure helpers.** `scripts/bootstrap.mjs` is
  the shell; `scripts/src/bootstrap/{chrome,docker,probe,syncz,config}.mjs` are the
  pure/injectable helpers. This plan adds `scripts/src/bootstrap/teardown.mjs`
  (pure) and `scripts/teardown.mjs` (shell), following that exact split.
- **Output contract** (printed as one JSON object to stdout, pretty-printed with
  `JSON.stringify(obj, null, 2)` exactly like `bootstrap.mjs`'s `emit`):
  ```json
  {
    "status":    "down | partial",
    "container": "removed | absent | docker-unavailable | error",
    "proxy":     "killed | absent | error",
    "chrome":    "closed | absent | error"
  }
  ```
  `status: "down"` ⇔ no component is `error`. `status: "partial"` ⇔ at least one is
  `error`. `docker-unavailable` and `absent` are **successes**, not errors.
- **Tests live at the repo root**, never inside `bookmarks-to-obsidian/`. New test
  file: `test/bootstrap.teardown.test.mjs`, importing from
  `../bookmarks-to-obsidian/scripts/src/bootstrap/teardown.mjs` (see siblings like
  `test/bootstrap.docker.test.mjs`).
- **No new dependency** is introduced (`puppeteer-core` already ships in the
  vendored tree, used by `render.mjs`), so **no re-vendor is needed**.
- **Run the suite from the repo root:** `npm test` (alias for `vitest run`). A
  single file: `npx vitest run test/bootstrap.teardown.test.mjs`.

## File structure

- **Create** `bookmarks-to-obsidian/scripts/src/bootstrap/teardown.mjs` — pure
  helpers: `dockerRmArgs`, `classifyTeardown`, `listenerPidCommand`,
  `parseListenerPids`, `killPidCommand`. No process spawning; unit-tested.
- **Create** `bookmarks-to-obsidian/scripts/teardown.mjs` — thin imperative shell:
  container → proxy → Chrome → verify → print one JSON object. No consent gate.
  Verified by a real run, not mocked (matching how `bootstrap.mjs` is treated).
- **Create** `test/bootstrap.teardown.test.mjs` — unit tests for the pure helpers.
- **Modify** `bookmarks-to-obsidian/SKILL.md` — add the final workflow step
  (fire-on-finish, skip-after-dry-run) and reword the "left running" language.

Tasks 1–3 grow the pure-helper file (and its one test file) incrementally; Task 4
adds the shell; Task 5 updates `SKILL.md`; Task 6 is end-to-end verification.

---

### Task 1: Pure helpers — `dockerRmArgs` + `classifyTeardown`

**Files:**
- Create: `bookmarks-to-obsidian/scripts/src/bootstrap/teardown.mjs`
- Test: `test/bootstrap.teardown.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/bootstrap.teardown.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import {
  dockerRmArgs,
  classifyTeardown,
} from '../bookmarks-to-obsidian/scripts/src/bootstrap/teardown.mjs';

describe('dockerRmArgs', () => {
  it('force-removes the cbg container by default', () => {
    expect(dockerRmArgs()).toEqual(['rm', '-f', 'cbg']);
  });

  it('honors a custom container name', () => {
    expect(dockerRmArgs('other')).toEqual(['rm', '-f', 'other']);
  });
});

describe('classifyTeardown', () => {
  it('is "down" when every component succeeded', () => {
    expect(classifyTeardown({ container: 'removed', proxy: 'killed', chrome: 'closed' })).toBe('down');
  });

  it('treats absent / docker-unavailable as success, not error', () => {
    expect(classifyTeardown({ container: 'docker-unavailable', proxy: 'absent', chrome: 'absent' })).toBe('down');
  });

  it('is "partial" when the container errored', () => {
    expect(classifyTeardown({ container: 'error', proxy: 'killed', chrome: 'closed' })).toBe('partial');
  });

  it('is "partial" when the proxy errored', () => {
    expect(classifyTeardown({ container: 'removed', proxy: 'error', chrome: 'closed' })).toBe('partial');
  });

  it('is "partial" when chrome errored', () => {
    expect(classifyTeardown({ container: 'removed', proxy: 'killed', chrome: 'error' })).toBe('partial');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/bootstrap.teardown.test.mjs`
Expected: FAIL — cannot resolve `.../teardown.mjs` (module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `bookmarks-to-obsidian/scripts/src/bootstrap/teardown.mjs`:

```js
// Pure decision logic for teardown.mjs (the thin imperative shell). No process
// spawning, no docker, no network here — every function maps inputs to an argv or
// a verdict, so it is unit-testable in isolation. Mirrors the bootstrap/* split
// (chrome.mjs, docker.mjs, syncz.mjs).

/** Args (after the literal `docker`) to force-remove the gateway container. */
export function dockerRmArgs(name = 'cbg') {
  return ['rm', '-f', name];
}

/**
 * Map the three component outcomes to the overall teardown status.
 *   'down'    -> nothing from the stack is running (the goal): no component is in
 *               'error' (removed / killed / closed / absent / docker-unavailable
 *               all count as success).
 *   'partial' -> at least one component resisted teardown ('error').
 */
export function classifyTeardown({ container, proxy, chrome }) {
  const errored = [container, proxy, chrome].includes('error');
  return errored ? 'partial' : 'down';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/bootstrap.teardown.test.mjs`
Expected: PASS (8 assertions across the two `describe` blocks).

- [ ] **Step 5: Commit**

```sh
git add bookmarks-to-obsidian/scripts/src/bootstrap/teardown.mjs test/bootstrap.teardown.test.mjs
git commit -m "feat(teardown): add dockerRmArgs and classifyTeardown helpers" -m "Pure decision logic for the teardown CLI: the docker force-remove argv and the component-outcome -> status classifier. Unit-tested; no spawning."
```

---

### Task 2: Pure helpers — listener lookup (`listenerPidCommand`, `parseListenerPids`)

The proxy on `:9223` is a bare TCP forwarder with no control channel, so the only
origin-independent way to find it is by who holds the listening socket:
`netstat -ano` on Windows (parse the `LISTENING` row whose local address ends in
`:9223`), `lsof -nP -iTCP:9223 -sTCP:LISTEN -t` on POSIX (prints PIDs directly).

> **Note (deliberate refinement of the spec signature):** the spec lists
> `parseListenerPids(platform, output)`. Windows `netstat` dumps *every* listener,
> so the parser needs the port to filter; this plan adds a third **optional**
> param `port = 9223`. POSIX `lsof` is already port-scoped, so the param is only
> consulted on `win32`. This keeps the spec's two required params and the default
> matches the proxy port.

**Files:**
- Modify: `bookmarks-to-obsidian/scripts/src/bootstrap/teardown.mjs`
- Test: `test/bootstrap.teardown.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `test/bootstrap.teardown.test.mjs` (add the two new names to the existing
import at the top — see Step 1a):

```js
describe('listenerPidCommand', () => {
  it('uses netstat -ano on win32', () => {
    expect(listenerPidCommand('win32', 9223)).toEqual({
      cmd: 'netstat',
      args: ['-ano', '-p', 'tcp'],
    });
  });

  it('uses lsof scoped to the port + LISTEN state on posix', () => {
    const expected = { cmd: 'lsof', args: ['-nP', '-iTCP:9223', '-sTCP:LISTEN', '-t'] };
    expect(listenerPidCommand('linux', 9223)).toEqual(expected);
    expect(listenerPidCommand('darwin', 9223)).toEqual(expected);
  });
});

describe('parseListenerPids (win32 netstat -ano)', () => {
  const NETSTAT = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:9223           0.0.0.0:0              LISTENING       12344',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       9999',
    '  TCP    [::]:9223              [::]:0                 LISTENING       12344',
    '  TCP    127.0.0.1:52000        127.0.0.1:9223         ESTABLISHED     5555',
    '',
  ].join('\r\n');

  it('returns the LISTENING PID(s) for the port, deduped across IPv4/IPv6 rows', () => {
    expect(parseListenerPids('win32', NETSTAT, 9223)).toEqual([12344]);
  });

  it('does not match a port appearing only as a foreign address', () => {
    // :9223 appears as the ESTABLISHED row's foreign address (PID 5555) — excluded.
    expect(parseListenerPids('win32', NETSTAT, 9223)).not.toContain(5555);
  });

  it('scopes by the requested port', () => {
    expect(parseListenerPids('win32', NETSTAT, 3000)).toEqual([9999]);
  });

  it('returns [] when nothing listens on the port', () => {
    expect(parseListenerPids('win32', NETSTAT, 8080)).toEqual([]);
  });

  it('returns [] for empty output', () => {
    expect(parseListenerPids('win32', '', 9223)).toEqual([]);
  });

  it('does not confuse :9223 with :19223', () => {
    const line = '  TCP    0.0.0.0:19223          0.0.0.0:0              LISTENING       4242\r\n';
    expect(parseListenerPids('win32', line, 9223)).toEqual([]);
  });
});

describe('parseListenerPids (posix lsof -t)', () => {
  it('parses one PID per line', () => {
    expect(parseListenerPids('linux', '12344\n', 9223)).toEqual([12344]);
  });

  it('dedupes repeated PIDs and keeps first-seen order', () => {
    expect(parseListenerPids('darwin', '12344\n12344\n12345\n', 9223)).toEqual([12344, 12345]);
  });

  it('returns [] for empty / whitespace-only output', () => {
    expect(parseListenerPids('linux', '\n', 9223)).toEqual([]);
  });
});
```

- [ ] **Step 1a: Update the import at the top of the test file**

Change the existing import block to include the two new names:

```js
import {
  dockerRmArgs,
  classifyTeardown,
  listenerPidCommand,
  parseListenerPids,
} from '../bookmarks-to-obsidian/scripts/src/bootstrap/teardown.mjs';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/bootstrap.teardown.test.mjs`
Expected: FAIL — `listenerPidCommand`/`parseListenerPids` are not exported (the new
`describe` blocks error; Task 1's blocks still pass).

- [ ] **Step 3: Write the minimal implementation**

Append to `bookmarks-to-obsidian/scripts/src/bootstrap/teardown.mjs`:

```js
/**
 * The command to find the process holding a listening TCP socket on `port`.
 *   win32 -> `netstat -ano` dumps every connection; parseListenerPids filters it.
 *   posix -> `lsof` is scoped to the port + LISTEN state, so it prints just PIDs.
 * Returns { cmd, args } ready for spawnSync.
 */
export function listenerPidCommand(platform, port) {
  if (platform === 'win32') {
    return { cmd: 'netstat', args: ['-ano', '-p', 'tcp'] };
  }
  return { cmd: 'lsof', args: ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'] };
}

/**
 * Parse listener PIDs from the command's stdout.
 *   win32 -> scan `netstat -ano` rows; keep TCP + LISTENING rows whose LOCAL
 *            address (column 2) ends in `:port`, take the trailing PID column.
 *   posix -> `lsof -t` already prints one PID per line, pre-filtered by port.
 * Returns numbers, deduped, in first-seen order. `port` (default 9223, the proxy
 * port) is only consulted for the win32 netstat scan.
 */
export function parseListenerPids(platform, output, port = 9223) {
  const text = String(output || '');
  const pids = [];
  const push = (value) => {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0 && !pids.includes(n)) pids.push(n);
  };

  if (platform === 'win32') {
    for (const raw of text.split(/\r?\n/)) {
      const cols = raw.trim().split(/\s+/);
      if (cols.length < 5) continue;
      const [proto, local, , state, pid] = cols;
      if (proto !== 'TCP' || state !== 'LISTENING') continue;
      if (!local.endsWith(`:${port}`)) continue;
      push(pid);
    }
    return pids;
  }

  for (const tok of text.split(/\s+/)) {
    if (tok) push(tok);
  }
  return pids;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/bootstrap.teardown.test.mjs`
Expected: PASS (Task 1 blocks + the new listener blocks).

- [ ] **Step 5: Commit**

```sh
git add bookmarks-to-obsidian/scripts/src/bootstrap/teardown.mjs test/bootstrap.teardown.test.mjs
git commit -m "feat(teardown): add cross-platform proxy-listener lookup helpers" -m "listenerPidCommand picks netstat (win32) or lsof (posix); parseListenerPids extracts the :9223 LISTENING PID(s) from netstat output or the PIDs from lsof -t, deduped. Port param defaults to 9223."
```

---

### Task 3: Pure helper — `killPidCommand`

**Files:**
- Modify: `bookmarks-to-obsidian/scripts/src/bootstrap/teardown.mjs`
- Test: `test/bootstrap.teardown.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/bootstrap.teardown.test.mjs`:

```js
describe('killPidCommand', () => {
  it('uses taskkill /F /PID on win32 (pid stringified)', () => {
    expect(killPidCommand('win32', 12344)).toEqual({ cmd: 'taskkill', args: ['/F', '/PID', '12344'] });
  });

  it('uses kill on posix (pid stringified)', () => {
    expect(killPidCommand('linux', 12344)).toEqual({ cmd: 'kill', args: ['12344'] });
    expect(killPidCommand('darwin', 7)).toEqual({ cmd: 'kill', args: ['7'] });
  });
});
```

- [ ] **Step 1a: Add `killPidCommand` to the test file import**

```js
import {
  dockerRmArgs,
  classifyTeardown,
  listenerPidCommand,
  parseListenerPids,
  killPidCommand,
} from '../bookmarks-to-obsidian/scripts/src/bootstrap/teardown.mjs';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/bootstrap.teardown.test.mjs`
Expected: FAIL — `killPidCommand` is not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `bookmarks-to-obsidian/scripts/src/bootstrap/teardown.mjs`:

```js
/** The command to kill process `pid`. win32 -> `taskkill /F`; posix -> `kill`. */
export function killPidCommand(platform, pid) {
  if (platform === 'win32') {
    return { cmd: 'taskkill', args: ['/F', '/PID', String(pid)] };
  }
  return { cmd: 'kill', args: [String(pid)] };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/bootstrap.teardown.test.mjs`
Expected: PASS (all `describe` blocks).

- [ ] **Step 5: Commit**

```sh
git add bookmarks-to-obsidian/scripts/src/bootstrap/teardown.mjs test/bootstrap.teardown.test.mjs
git commit -m "feat(teardown): add cross-platform killPidCommand helper" -m "taskkill /F /PID on win32, kill on posix; pid stringified for spawnSync."
```

---

### Task 4: Thin imperative shell — `scripts/teardown.mjs`

This is the imperative shell: it spawns docker/`netstat`/`lsof`/`taskkill`/`kill`,
connects puppeteer, and **re-probes `:9222`/`:9223` as the authority** on the final
state. Per the spec it is verified by a real run (Task 6), not by mocked unit tests
— matching how `bootstrap.mjs` is treated. Idempotency: a component already gone is
reported `absent`. Order is reverse of startup: container → proxy → Chrome.

Key correctness points for the engineer:
- **Container `absent` vs `error`:** `docker rm -f` of a missing container exits
  non-zero and the message is locale-dependent, so we **inspect first**
  (`docker container inspect cbg`) — exit 0 ⇒ exists ⇒ `rm -f` and report
  `removed`/`error`; non-zero ⇒ `absent`. Daemon unreachable ⇒ `docker-unavailable`
  (nothing can be running). Reuses `isDaemonUp` and `dockerRmArgs`.
- **Chrome closes over CDP, not by PID:** `puppeteer.connect({ browserURL })` then
  `browser.close()`. `connect()` + `close()` (not `disconnect()`) terminates the
  browser process; this targets **only** the `:9222` instance, never the user's
  everyday Chrome. `render.mjs` stays connect/disconnect-only — unchanged.
- **Verify after acting:** after killing the proxy or closing Chrome, re-probe the
  port until it goes quiet (`waitGone`). If the port still answers within the
  timeout ⇒ `error`. (On minimal Linux without `lsof`, no PID is found, the probe
  stays up, and the proxy is honestly reported `error` — the documented best-effort
  POSIX path.)

**Files:**
- Create: `bookmarks-to-obsidian/scripts/teardown.mjs`

- [ ] **Step 1: Write the shell**

Create `bookmarks-to-obsidian/scripts/teardown.mjs`:

```js
#!/usr/bin/env node
// Self-contained, cross-platform shutdown for the chrome-bookmarks-gateway stack —
// the mirror of bootstrap.mjs. Tears down in reverse of startup order:
//   1. gateway container          (docker rm -f cbg)
//   2. bundled CDP proxy :9223    (find the listening PID, kill it, verify)
//   3. dedicated Chrome :9222     (close over CDP — only that instance, verify)
// Each step is idempotent: a piece already gone is reported `absent`, never an
// error. No consent gate — teardown only touches the skill's own isolated stack,
// never user data or the everyday browser. Final state is VERIFIED by re-probing
// :9222/:9223, treated as the authority over spawn exit codes. Prints ONE JSON
// object on stdout for Claude to parse. Decision logic lives in
// src/bootstrap/teardown.mjs (pure, unit-tested); this file only spawns + verifies.
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { isDaemonUp } from './src/bootstrap/docker.mjs';
import { probeUrl } from './src/bootstrap/probe.mjs';
import {
  dockerRmArgs,
  listenerPidCommand,
  parseListenerPids,
  killPidCommand,
  classifyTeardown,
} from './src/bootstrap/teardown.mjs';

const PROXY_PORT = 9223;
const CHROME_URL = 'http://127.0.0.1:9222';
const CHROME_PROBE = 'http://127.0.0.1:9222/json/version';
const PROXY_PROBE = 'http://127.0.0.1:9223/json/version';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

// Re-probe `url` until nothing answers (true), or the deadline passes (false).
async function waitGone(url, timeoutMs = 6000, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await probeUrl(url))) return true;
    if (Date.now() >= deadline) return false;
    await delay(intervalMs);
  }
}

// 1. Container. Inspect first so an absent container is `absent`, not an error.
//    Daemon unreachable -> nothing can be running -> docker-unavailable.
function teardownContainer() {
  if (!isDaemonUp()) return 'docker-unavailable';
  const exists = spawnSync('docker', ['container', 'inspect', 'cbg'], { stdio: 'ignore' }).status === 0;
  if (!exists) return 'absent';
  const r = spawnSync('docker', dockerRmArgs(), { stdio: 'ignore' });
  return r.status === 0 ? 'removed' : 'error';
}

// 2. Proxy. Nothing on :9223 -> absent. Else find the listener PID(s), kill, verify.
async function teardownProxy() {
  if (!(await probeUrl(PROXY_PROBE))) return 'absent';
  const list = listenerPidCommand(process.platform, PROXY_PORT);
  const out = spawnSync(list.cmd, list.args, { encoding: 'utf8' });
  const pids = parseListenerPids(process.platform, out.stdout || '', PROXY_PORT);
  for (const pid of pids) {
    const k = killPidCommand(process.platform, pid);
    spawnSync(k.cmd, k.args, { stdio: 'ignore' });
  }
  return (await waitGone(PROXY_PROBE)) ? 'killed' : 'error';
}

// 3. Chrome. Nothing on :9222 -> absent. Else connect over CDP and close ONLY that
//    instance (never the user's everyday Chrome). Re-probe to confirm it went down.
async function teardownChrome() {
  if (!(await probeUrl(CHROME_PROBE))) return 'absent';
  try {
    const browser = await puppeteer.connect({ browserURL: CHROME_URL, protocolTimeout: 60000 });
    await browser.close();
  } catch {
    // Connect/close raced or failed; the re-probe below is the authority.
  }
  return (await waitGone(CHROME_PROBE)) ? 'closed' : 'error';
}

async function main() {
  const container = teardownContainer();
  const proxy = await teardownProxy();
  const chrome = await teardownChrome();
  emit({ status: classifyTeardown({ container, proxy, chrome }), container, proxy, chrome });
}

main().catch((e) => {
  emit({ status: 'partial', error: e.message || String(e) });
  process.exit(1);
});
```

- [ ] **Step 2: Sanity-check it parses and the full suite still passes**

Run: `node --check bookmarks-to-obsidian/scripts/teardown.mjs`
Expected: no output, exit 0 (valid syntax).

Run: `npm test`
Expected: PASS — the existing suite plus the new `bootstrap.teardown` unit tests.
(Adding the shell does not add or change any unit test; this confirms nothing
regressed and the import graph resolves.)

- [ ] **Step 3: Commit**

```sh
git add bookmarks-to-obsidian/scripts/teardown.mjs
git commit -m "feat(teardown): add the cross-platform teardown CLI" -m "Thin imperative shell mirroring bootstrap.mjs: removes the cbg container, kills the :9223 proxy by its listening PID, and closes the :9222 Chrome over CDP. Idempotent (absent != error), state verified by re-probing :9222/:9223, single JSON object on stdout. No consent gate."
```

---

### Task 5: Wire teardown into `SKILL.md` (behavioral contract)

Four edits: a new final workflow step, the "no new bookmarks" stop pointing at it,
and the two "left running" rewordings (Overview sentence + Rendering bullet).

**Files:**
- Modify: `bookmarks-to-obsidian/SKILL.md`

- [ ] **Step 1: Reword the Overview "thin operator" sentence**

Find (the run-on sentence ending the Overview, around lines 18–20):

```
deterministic Node CLI; this skill is the thin operator that health-checks it,
lists the genuinely-new bookmarks, walks them with you one-by-one (keep/skip),
imports the ones you keep, and summarizes the JSON report. A "just import
everything" bulk escape remains for when you don't want to choose.
```

Replace with:

```
deterministic Node CLI; this skill is the thin operator that health-checks it,
lists the genuinely-new bookmarks, walks them with you one-by-one (keep/skip),
imports the ones you keep, summarizes the JSON report, and shuts the whole stack
down when the session is finished. A "just import everything" bulk escape remains
for when you don't want to choose.
```

- [ ] **Step 2: Reword the Rendering "left running" bullet**

Find (first Rendering bullet, around lines 68–72):

```
  rendered and extracted with in-page Defuddle, and the tab is closed. The
  gateway's Chrome is left running (connect/disconnect only).
```

Replace with:

```
  rendered and extracted with in-page Defuddle, and the tab is closed.
  `render.mjs` leaves the gateway's Chrome running *during* the import
  (connect/disconnect only); the skill explicitly tears the whole stack down —
  container, proxy, and that Chrome — as its final step (Workflow step 8).
```

- [ ] **Step 3: Point the "Nothing new?" stop at teardown**

Find (step 3, around lines 120–121):

```
3. **Nothing new?** If `new` is empty, tell the user "No new bookmarks" (and
   mention `meta.counts.declined` if it is > 0), then stop.
```

Replace with:

```
3. **Nothing new?** If `new` is empty, tell the user "No new bookmarks" (and
   mention `meta.counts.declined` if it is > 0), then **tear down the stack
   (step 8) and stop**.
```

- [ ] **Step 4: Add the final workflow step 8**

Insert immediately after the end of step 7 (after the
`--reset-declined` … "un-hide every declined bookmark." line, around line 151) and
before the `## Report statuses` heading:

```
8. **Tear down the stack (session finished).** Once the work for this session is
   done, shut the whole stack down — symmetric to the bootstrap in step 1. Run
   from the skill's own folder:
   ```
   node scripts/teardown.mjs
   ```
   It prints one JSON object — `status` (`down` | `partial`) plus `container`,
   `proxy`, `chrome`. Report it in one line, e.g. "Stack shut down." On
   `status: "partial"`, name the component(s) reporting `error` (e.g. "the proxy
   did not stop"). This runs on **every** finish path: after an import, after the
   "No new bookmarks" stop (step 3), and after the user defers or declines
   everything without importing — the skill brought (or found) the stack up and is
   now done with it.
   - **Skip after a `--dry-run` preview.** If step 6 ran with `--dry-run`, do
     **not** tear down — a real import is expected to follow, so keep the stack
     warm.
   - **No consent needed.** Teardown only touches the skill's own isolated stack
     (container `cbg`, the proxy on `:9223`, the dedicated Chrome on `:9222`),
     never the user's everyday browser or data. Sign-in is preserved (Chrome is
     closed, not wiped), so the next `node scripts/bootstrap.mjs` relaunches a
     signed-in Chrome with no re-sync.
```

- [ ] **Step 5: Verify the edits read correctly**

Run: `npx vitest run` (full suite — confirms nothing else broke; SKILL.md has no
direct test, so also re-read the four edited regions to confirm wording and that
step numbering is intact: steps 1–8, with step 3 and the Rendering bullet both
referencing "step 8").

Expected: suite PASS; the four regions read as written above.

- [ ] **Step 6: Commit**

```sh
git add bookmarks-to-obsidian/SKILL.md
git commit -m "docs(skill): tear the stack down as the final workflow step" -m "Add Workflow step 8 (node scripts/teardown.mjs): fire on every finish path including the empty/decline path, skip right after a --dry-run preview. Reword the Overview and Rendering 'left running' language to note render.mjs leaves Chrome up only during the run while the skill tears the whole stack down at the end."
```

---

### Task 6: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS, including all `bootstrap.teardown` blocks (`dockerRmArgs`,
`classifyTeardown`, `listenerPidCommand`, `parseListenerPids` win32+posix,
`killPidCommand`). No regressions elsewhere.

- [ ] **Step 2: Real-run smoke (requires the live stack — manual)**

> Needs Docker + the dedicated Chrome signed in. Per the project's
> live-verification note: bring the stack up and wait for stable `ok:true` before
> testing teardown.

From `bookmarks-to-obsidian/`:

1. Bring the stack up: `node scripts/bootstrap.mjs` → wait for `status: "ready"`.
2. Tear it down: `node scripts/teardown.mjs`
   Expected stdout (one JSON object):
   ```json
   {
     "status": "down",
     "container": "removed",
     "proxy": "killed",
     "chrome": "closed"
   }
   ```
3. **Idempotency:** run `node scripts/teardown.mjs` again immediately.
   Expected: `status: "down"` with `container: "absent"`, `proxy: "absent"`,
   `chrome: "absent"` (everything already gone is reported `absent`, no error).
4. Confirm the ports are dead: `curl -sS http://localhost:3000/syncz`,
   `curl -sS http://127.0.0.1:9223/json/version`, and
   `curl -sS http://127.0.0.1:9222/json/version` should all fail to connect.
5. **Sign-in preserved:** `node scripts/bootstrap.mjs` again should return
   `status: "ready"` without prompting for a re-sync (the persistent profile
   survived the close).

If any component reports `error`, treat it as a real bug — inspect that
component's branch in `scripts/teardown.mjs` (debug with
`superpowers:systematic-debugging`), fix, re-run the affected unit test and this
smoke.

- [ ] **Step 3: Confirm no re-vendor is needed**

No new runtime dependency was added (`puppeteer-core` already ships in the vendored
tree). Confirm `bookmarks-to-obsidian/package.json` is unchanged and there is no
new entry under `bookmarks-to-obsidian/node_modules/`:

Run: `git status --porcelain bookmarks-to-obsidian/package.json bookmarks-to-obsidian/node_modules`
Expected: empty output (no changes). If it is **not** empty, a dependency crept in
— stop and reconcile against the spec before continuing.

- [ ] **Step 4: Final review against the spec**

Re-read `specs/2026-06-15-teardown-stack-after-import-design.md` and confirm:
- All five pure helpers exist and are unit-tested (Tasks 1–3).
- `teardown.mjs` brings down all three components in reverse order, idempotently,
  with verification, and prints the exact output contract (Task 4).
- `SKILL.md` fires teardown on finish (including the empty/decline path), skips it
  after `--dry-run`, and the "left running" wording is corrected (Task 5).
- `render.mjs` is unchanged; no consent gate was added; the Chrome profile is not
  wiped (out-of-scope items stayed out).

---

## Self-review notes (author checklist — already applied)

- **Spec coverage:** decisions 1–4 → Tasks 4 (separate CLI, reverse order,
  idempotent) + 5 (fire on finish, skip after dry-run); architecture/file-layout →
  Tasks 1–4; output contract → Task 4 + Task 6 smoke; testing section → Tasks 1–3;
  non-goals (no consent, never the everyday Chrome, sign-in preserved, render.mjs
  unchanged) → asserted in Task 4 design notes + Task 6 Step 4 review.
- **No placeholders:** every code/test step contains complete, runnable content.
- **Type/name consistency:** `dockerRmArgs`, `classifyTeardown`,
  `listenerPidCommand`, `parseListenerPids` (with the documented `port` param),
  `killPidCommand` — same names and `{ cmd, args }` shape across the shell (Task 4),
  the helpers (Tasks 1–3), and the tests. Component vocabulary
  (`removed`/`absent`/`docker-unavailable`/`error`, `killed`, `closed`,
  `down`/`partial`) is identical everywhere it appears.
- **Deliberate spec deviation:** `parseListenerPids` gains an optional third
  `port` param (needed to filter Windows `netstat`); documented in Task 2.
