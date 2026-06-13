# Portable auto-bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make the `chrome-bookmarks-gateway` dependency start itself from inside the `bookmarks-to-obsidian` skill on any OS the first time the skill is used, with a one-time consent prompt, and replace SKILL.md's hardcoded machine paths with per-user config.

**Architecture:** A single Node orchestrator `bootstrap.mjs` (thin imperative shell) reproduces what the machine-specific `cbg-up.ps1` did — launch a dedicated debugging Chrome, start the now-bundled CDP proxy, run the pinned gateway container, poll `/syncz` — and prints one JSON status object Claude parses. All decision logic lives in small pure modules under `src/bootstrap/` (Chrome-path detection, Docker arg construction, `/syncz` interpretation, OS config-dir resolution) so they unit-test without spawning anything. Per-user state (consent + vault/folder/inbox) lives in an OS-appropriate config dir **outside** the skill folder so re-copying the skill never wipes it. SKILL.md is rewritten to health-check → consent-gate → bootstrap → branch on status, and to read tool/vault paths from config instead of literals.

**Tech Stack:** Node ESM (`.mjs`), one CommonJS file (`cbg-cdp-proxy.cjs`, raw TCP proxy), `node:child_process` (`spawn`/`spawnSync`), `fetch` (probes + `/syncz` poll), vitest. Docker (`pvoronin/chrome-bookmarks-gateway:0.3.0`, pinned) is an external prerequisite, not vendored.

---

## File structure

All paths are under the skill folder `bookmarks-to-obsidian/` (the repo nests the skill there).

**New files:**
- `bootstrap.mjs` — imperative orchestrator: consent gate → preflight → Chrome → proxy → container → poll `/syncz` → print JSON. Verified by a real run, not mocked.
- `cbg-cdp-proxy.cjs` — the CDP proxy, moved in from `C:\Users\juliu\` so nothing lives outside the skill. Unchanged content.
- `src/bootstrap/syncz.mjs` — `interpretSyncz(status, body)` → `'ready' | 'not-synced' | 'down'`. Pure.
- `src/bootstrap/chrome.mjs` — `chromeCandidates(platform, env)`, `findChromePath(platform, env, exists)`, `chromeArgs(profileDir)`. Pure (filesystem check injectable).
- `src/bootstrap/docker.mjs` — `GATEWAY_IMAGE`, `dockerRunArgs(opts)` (pure), `isDaemonUp(run)` (thin shell).
- `src/bootstrap/config.mjs` — `resolveConfigDir(platform, env, home)`, `configPath(...)`, `readConfig(file)`, `writeConfig(file, patch)`, plus a tiny CLI (`--get [key]`, `--set k=v…`, `--consent`, `--path`).
- `src/bootstrap/probe.mjs` — `probeUrl(url, opts)` liveness check. Thin shell (network), smoke-tested against a localhost server.

**New tests** (`test/bootstrap.*.test.mjs`): `syncz`, `chrome`, `docker`, `config`, `probe`.

**Modified:**
- `SKILL.md` — rewritten Prerequisites / Configuration / Workflow; all `cbg-up.ps1` references removed.

**Design-for-isolation invariant:** `bootstrap.mjs` only spawns processes and assembles the output object. Every branch it takes is decided by a pure function from `src/bootstrap/*`. If you find yourself writing an `if (platform === …)` or a Docker flag string *inside* `bootstrap.mjs`, move it into the matching pure module and unit-test it there.

---

## Task 1: Confirm the gateway image architecture (arm64 risk)

This is the spec's mandated first step. It produces a finding that feeds the SKILL.md Apple-Silicon caveat in Task 9. No code, no test.

**Files:** none (investigation only).

- [x] **Step 1: Inspect the published architectures of the pinned image**

Run (Docker must be running):

```bash
docker manifest inspect pvoronin/chrome-bookmarks-gateway:0.3.0 | grep -A2 '"platform"'
```

If `docker manifest inspect` is disabled in your Docker config, use:

```bash
docker buildx imagetools inspect pvoronin/chrome-bookmarks-gateway:0.3.0
```

- [x] **Step 2: Record the finding**

Read the `architecture` fields in the output.
- If `arm64` (linux/arm64) **is** present → the image is multi-arch; no caveat needed. Note "multi-arch, arm64 native" for Task 9.
- If only `amd64` (linux/amd64) is present → the image is amd64-only; on Apple Silicon it runs under Docker Desktop's emulation (slower) or may fail. Note "amd64-only — Apple Silicon runs under emulation" for Task 9.

Write the one-line finding into the scratch area of your task tracker (it is consumed verbatim by Task 9, Step 1). No commit.

> **FINDING (2026-06-13):** `docker manifest inspect pvoronin/chrome-bookmarks-gateway:0.3.0` lists only `linux/amd64` (plus an `unknown/unknown` attestation manifest); no `linux/arm64`. The image is **amd64-only — Apple Silicon runs under emulation**. Task 9, Step 2 keeps the caveat: "the pinned gateway image is amd64-only; on Apple Silicon it runs under Docker Desktop's emulation (slower but functional)."

---

## Task 2: Bundle the CDP proxy into the skill

Move the proxy that today lives at `C:\Users\juliu\cbg-cdp-proxy.cjs` into the skill folder so the skill is self-contained. Content is copied verbatim (it is already portable raw-byte forwarding).

**Files:**
- Create: `bookmarks-to-obsidian/cbg-cdp-proxy.cjs`

- [x] **Step 1: Create the bundled proxy**

Create `bookmarks-to-obsidian/cbg-cdp-proxy.cjs` with exactly:

```js
// Minimal TCP proxy: exposes host-loopback Chrome CDP (127.0.0.1:9222) on
// 0.0.0.0:9223 so the Docker container can reach it via host.docker.internal.
// Raw byte forwarding preserves the HTTP Host header (an IP literal from the
// container), which Chrome's remote-debugging host-allowlist accepts.
const net = require('net');
const LISTEN_PORT = 9223;
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = 9222;

const server = net.createServer((client) => {
  const upstream = net.connect(TARGET_PORT, TARGET_HOST);
  client.pipe(upstream);
  upstream.pipe(client);
  const kill = () => { client.destroy(); upstream.destroy(); };
  client.on('error', kill);
  upstream.on('error', kill);
});

server.on('error', (e) => { console.error('proxy error:', e.message); process.exit(1); });
server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`CDP proxy listening on 0.0.0.0:${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);
});
```

- [x] **Step 2: Sanity-check it parses and binds**

Run from `bookmarks-to-obsidian/`:

```bash
node -e "require('./cbg-cdp-proxy.cjs')" & sleep 1; \
  node -e "const n=require('net');const s=n.connect(9223,'127.0.0.1');s.on('connect',()=>{console.log('listening OK');s.destroy();process.exit(0)});s.on('error',e=>{console.error(e.message);process.exit(1)})"; \
  kill %1 2>/dev/null
```

Expected: prints `CDP proxy listening on 0.0.0.0:9223 -> 127.0.0.1:9222` then `listening OK`.

- [x] **Step 3: Commit**

```bash
git add bookmarks-to-obsidian/cbg-cdp-proxy.cjs
git commit -m "feat(bootstrap): bundle cbg-cdp-proxy into the skill folder"
```

---

## Task 3: `interpretSyncz` — map gateway health to a verdict

Pure function. Decides whether the gateway is ready, up-but-not-signed-in, or down, from the `/syncz` HTTP status. This is the smallest pure module; do it first to establish the `src/bootstrap/` pattern.

**Files:**
- Create: `bookmarks-to-obsidian/src/bootstrap/syncz.mjs`
- Test: `bookmarks-to-obsidian/test/bootstrap.syncz.test.mjs`

- [x] **Step 1: Write the failing test**

Create `bookmarks-to-obsidian/test/bootstrap.syncz.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { interpretSyncz } from '../src/bootstrap/syncz.mjs';

describe('interpretSyncz', () => {
  it('maps 200 to ready', () => {
    expect(interpretSyncz(200, { ok: true })).toBe('ready');
  });

  it('maps 200 with no body to ready', () => {
    expect(interpretSyncz(200, null)).toBe('ready');
  });

  it('maps 503 to not-synced (gateway up, Chrome not signed in)', () => {
    expect(interpretSyncz(503, { ok: false })).toBe('not-synced');
  });

  it('maps status 0 (unreachable) to down', () => {
    expect(interpretSyncz(0, null)).toBe('down');
  });

  it('maps any other status to down', () => {
    expect(interpretSyncz(500, null)).toBe('down');
    expect(interpretSyncz(404, null)).toBe('down');
  });

  it('treats a 200 that explicitly reports ok:false as not-synced', () => {
    expect(interpretSyncz(200, { ok: false })).toBe('not-synced');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run from `bookmarks-to-obsidian/`: `npx vitest run test/bootstrap.syncz.test.mjs`
Expected: FAIL — `Failed to resolve import "../src/bootstrap/syncz.mjs"`.

- [x] **Step 3: Write the minimal implementation**

Create `bookmarks-to-obsidian/src/bootstrap/syncz.mjs`:

```js
// Interpret the gateway's GET /syncz response. Pure — the network call lives in
// bootstrap.mjs; this only maps (status, body) to a verdict the orchestrator
// and SKILL.md branch on.
//   200            -> ready       (gateway up, Chrome signed into Google sync)
//   503            -> not-synced  (gateway up, sign-in/sync not done yet)
//   0 / anything   -> down        (unreachable or unexpected)
export function interpretSyncz(status, body) {
  if (status === 200) {
    return body && body.ok === false ? 'not-synced' : 'ready';
  }
  if (status === 503) return 'not-synced';
  return 'down';
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/bootstrap.syncz.test.mjs`
Expected: PASS (6 tests).

- [x] **Step 5: Commit**

```bash
git add bookmarks-to-obsidian/src/bootstrap/syncz.mjs bookmarks-to-obsidian/test/bootstrap.syncz.test.mjs
git commit -m "feat(bootstrap): add interpretSyncz health-status mapper"
```

---

## Task 4: `chrome.mjs` — locate the browser and build its launch args

Pure functions. `findChromePath` returns the first existing Chrome/Chromium for the OS (filesystem check injectable so tests are deterministic on any machine). `chromeArgs` builds the dedicated-profile debugging args.

**Files:**
- Create: `bookmarks-to-obsidian/src/bootstrap/chrome.mjs`
- Test: `bookmarks-to-obsidian/test/bootstrap.chrome.test.mjs`

- [x] **Step 1: Write the failing test**

Create `bookmarks-to-obsidian/test/bootstrap.chrome.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { chromeCandidates, findChromePath, chromeArgs } from '../src/bootstrap/chrome.mjs';

describe('chromeCandidates', () => {
  it('uses Program Files locations on win32', () => {
    const c = chromeCandidates('win32', { ProgramFiles: 'C:\\Program Files' });
    expect(c[0]).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  });

  it('uses /Applications on darwin', () => {
    const c = chromeCandidates('darwin', {});
    expect(c).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });

  it('uses /usr/bin locations on linux', () => {
    const c = chromeCandidates('linux', {});
    expect(c).toContain('/usr/bin/google-chrome');
    expect(c).toContain('/usr/bin/chromium');
  });

  it('puts an explicit CBG_CHROME / CHROME_PATH override first', () => {
    const c = chromeCandidates('linux', { CHROME_PATH: '/opt/brave' });
    expect(c[0]).toBe('/opt/brave');
  });
});

describe('findChromePath', () => {
  it('returns the first candidate the injected exists() accepts (win32)', () => {
    const target = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const exists = (p) => p === target;
    expect(findChromePath('win32', { ProgramFiles: 'C:\\Program Files' }, exists)).toBe(target);
  });

  it('returns the darwin path when it exists', () => {
    const target = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    expect(findChromePath('darwin', {}, (p) => p === target)).toBe(target);
  });

  it('returns a linux chromium fallback when chrome is absent', () => {
    const exists = (p) => p === '/usr/bin/chromium';
    expect(findChromePath('linux', {}, exists)).toBe('/usr/bin/chromium');
  });

  it('honors the override before the OS defaults', () => {
    const exists = (p) => p === '/opt/my-chrome' || p === '/usr/bin/google-chrome';
    expect(findChromePath('linux', { CBG_CHROME: '/opt/my-chrome' }, exists)).toBe('/opt/my-chrome');
  });

  it('returns null when nothing exists', () => {
    expect(findChromePath('linux', {}, () => false)).toBeNull();
  });
});

describe('chromeArgs', () => {
  it('builds isolated-profile remote-debugging args ending in about:blank', () => {
    const args = chromeArgs('/tmp/cbg-profile');
    expect(args).toContain('--remote-debugging-port=9222');
    expect(args).toContain('--remote-allow-origins=*');
    expect(args).toContain('--user-data-dir=/tmp/cbg-profile');
    expect(args).toContain('--no-first-run');
    expect(args).toContain('--no-default-browser-check');
    expect(args[args.length - 1]).toBe('about:blank');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bootstrap.chrome.test.mjs`
Expected: FAIL — cannot resolve `../src/bootstrap/chrome.mjs`.

- [x] **Step 3: Write the minimal implementation**

Create `bookmarks-to-obsidian/src/bootstrap/chrome.mjs`:

```js
// Locate a Chrome/Chromium binary for the current OS and build the dedicated
// debugging-profile launch args. Pure: candidate paths are derived from the
// injected `env`, and the filesystem check is an injected `exists` predicate so
// tests never depend on what is installed on the test machine.
//
// Candidate strings are written with literal OS separators (not path.join) so
// the win32 candidates are correct even when the tests run on POSIX CI.
import { existsSync } from 'node:fs';

function winCandidates(env) {
  const pf = env['ProgramFiles'] || 'C:\\Program Files';
  const pfx86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local =
    env['LOCALAPPDATA'] ||
    `${env['USERPROFILE'] || 'C:\\Users\\Default'}\\AppData\\Local`;
  return [
    `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
    `${pfx86}\\Google\\Chrome\\Application\\chrome.exe`,
    `${local}\\Google\\Chrome\\Application\\chrome.exe`,
    `${pf}\\Chromium\\Application\\chrome.exe`,
  ];
}

function macCandidates(env) {
  const home = env['HOME'] || '';
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    home && `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean);
}

function linuxCandidates() {
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}

/** Ordered candidate paths for `platform`, override (CBG_CHROME/CHROME_PATH) first. */
export function chromeCandidates(platform, env = {}) {
  const override = env.CBG_CHROME || env.CHROME_PATH;
  const base =
    platform === 'win32'
      ? winCandidates(env)
      : platform === 'darwin'
        ? macCandidates(env)
        : linuxCandidates();
  return override ? [override, ...base] : base;
}

/** First candidate that `exists` accepts, or null. `exists` defaults to existsSync. */
export function findChromePath(platform, env = {}, exists = existsSync) {
  for (const p of chromeCandidates(platform, env)) {
    if (p && exists(p)) return p;
  }
  return null;
}

/** Args for the dedicated debugging Chrome with an isolated, persistent profile. */
export function chromeArgs(profileDir) {
  return [
    '--remote-debugging-port=9222',
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ];
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/bootstrap.chrome.test.mjs`
Expected: PASS (all describe blocks green).

- [x] **Step 5: Commit**

```bash
git add bookmarks-to-obsidian/src/bootstrap/chrome.mjs bookmarks-to-obsidian/test/bootstrap.chrome.test.mjs
git commit -m "feat(bootstrap): add cross-OS Chrome locator and launch args"
```

---

## Task 5: `docker.mjs` — build the gateway `docker run` args

`dockerRunArgs` is pure and is the portability core: it uses `host.docker.internal` (not the brittle `192.168.65.254`) and adds `--add-host=host.docker.internal:host-gateway` so that name resolves on native Linux Docker too. `isDaemonUp` is the thin shell wrapper around `docker version` (no unit test — exercised by the real run in Task 10).

**Files:**
- Create: `bookmarks-to-obsidian/src/bootstrap/docker.mjs`
- Test: `bookmarks-to-obsidian/test/bootstrap.docker.test.mjs`

- [x] **Step 1: Write the failing test**

Create `bookmarks-to-obsidian/test/bootstrap.docker.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { GATEWAY_IMAGE, dockerRunArgs } from '../src/bootstrap/docker.mjs';

describe('GATEWAY_IMAGE', () => {
  it('is the pinned 0.3.0 image', () => {
    expect(GATEWAY_IMAGE).toBe('pvoronin/chrome-bookmarks-gateway:0.3.0');
  });
});

describe('dockerRunArgs', () => {
  const args = dockerRunArgs();

  it('runs detached and names the container cbg', () => {
    expect(args.slice(0, 2)).toEqual(['run', '-d']);
    const nameIdx = args.indexOf('--name');
    expect(args[nameIdx + 1]).toBe('cbg');
  });

  it('publishes port 3000', () => {
    const pIdx = args.indexOf('-p');
    expect(args[pIdx + 1]).toBe('3000:3000');
  });

  it('adds the host-gateway alias so host.docker.internal resolves on native Linux', () => {
    expect(args).toContain('--add-host=host.docker.internal:host-gateway');
  });

  it('disables auth and points CDP at host.docker.internal:9223 by default', () => {
    expect(args).toContain('AUTH_TOKEN=off');
    expect(args).toContain('CHROME_CDP_URL=http://host.docker.internal:9223');
  });

  it('puts the pinned image last', () => {
    expect(args[args.length - 1]).toBe(GATEWAY_IMAGE);
  });

  it('honors a custom hostCdpUrl', () => {
    const a = dockerRunArgs({ hostCdpUrl: 'http://host.docker.internal:9999' });
    expect(a).toContain('CHROME_CDP_URL=http://host.docker.internal:9999');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bootstrap.docker.test.mjs`
Expected: FAIL — cannot resolve `../src/bootstrap/docker.mjs`.

- [x] **Step 3: Write the minimal implementation**

Create `bookmarks-to-obsidian/src/bootstrap/docker.mjs`:

```js
// Build the `docker run` argv for the pinned gateway container, and probe the
// daemon. dockerRunArgs is pure (unit-tested); isDaemonUp is the thin shell
// wrapper exercised by the real first run.
import { spawnSync } from 'node:child_process';

export const GATEWAY_IMAGE = 'pvoronin/chrome-bookmarks-gateway:0.3.0';

/**
 * Args (after the literal `docker`) to run the gateway container.
 * Uses host.docker.internal everywhere instead of a hardcoded host IP, and adds
 * --add-host=host.docker.internal:host-gateway so the name also resolves on
 * native Linux Docker (Docker Desktop resolves it already).
 */
export function dockerRunArgs({
  image = GATEWAY_IMAGE,
  hostCdpUrl = 'http://host.docker.internal:9223',
  name = 'cbg',
} = {}) {
  return [
    'run', '-d',
    '--name', name,
    '-p', '3000:3000',
    '--add-host=host.docker.internal:host-gateway',
    '-e', 'AUTH_TOKEN=off',
    '-e', `CHROME_CDP_URL=${hostCdpUrl}`,
    image,
  ];
}

/** True when `docker version` exits 0 (daemon reachable). Injectable for tests. */
export function isDaemonUp(run = spawnSync) {
  try {
    const r = run('docker', ['version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/bootstrap.docker.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add bookmarks-to-obsidian/src/bootstrap/docker.mjs bookmarks-to-obsidian/test/bootstrap.docker.test.mjs
git commit -m "feat(bootstrap): add portable docker run args (host.docker.internal)"
```

---

## Task 6: `config.mjs` — per-user config dir, read/write, and CLI

Resolves the OS-appropriate config dir **outside** the skill, reads/writes `config.json` (merge semantics, missing file → `{}`), and exposes a tiny CLI so path-resolution lives in one tested place rather than being guessed by Claude.

**Files:**
- Create: `bookmarks-to-obsidian/src/bootstrap/config.mjs`
- Test: `bookmarks-to-obsidian/test/bootstrap.config.test.mjs`

- [x] **Step 1: Write the failing test**

Create `bookmarks-to-obsidian/test/bootstrap.config.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfigDir, configPath, readConfig, writeConfig } from '../src/bootstrap/config.mjs';

describe('resolveConfigDir', () => {
  it('uses %APPDATA% on win32', () => {
    const dir = resolveConfigDir('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' });
    expect(dir).toBe('C:\\Users\\me\\AppData\\Roaming\\bookmarks-to-obsidian');
  });

  it('falls back to <home>\\AppData\\Roaming on win32 when APPDATA is unset', () => {
    const dir = resolveConfigDir('win32', {}, 'C:\\Users\\me');
    expect(dir).toBe('C:\\Users\\me\\AppData\\Roaming\\bookmarks-to-obsidian');
  });

  it('uses $XDG_CONFIG_HOME on linux', () => {
    const dir = resolveConfigDir('linux', { XDG_CONFIG_HOME: '/home/me/.config' }, '/home/me');
    expect(dir).toBe('/home/me/.config/bookmarks-to-obsidian');
  });

  it('falls back to ~/.config on linux when XDG is unset', () => {
    const dir = resolveConfigDir('linux', {}, '/home/me');
    expect(dir).toBe('/home/me/.config/bookmarks-to-obsidian');
  });

  it('uses ~/.config on darwin (grouped with linux)', () => {
    const dir = resolveConfigDir('darwin', {}, '/Users/me');
    expect(dir).toBe('/Users/me/.config/bookmarks-to-obsidian');
  });
});

describe('configPath', () => {
  it('appends config.json to the resolved dir', () => {
    expect(configPath('linux', {}, '/home/me')).toBe('/home/me/.config/bookmarks-to-obsidian/config.json');
  });
});

describe('readConfig / writeConfig', () => {
  it('returns {} for a missing file', async () => {
    const file = join(tmpdir(), 'cbg-does-not-exist', 'config.json');
    expect(await readConfig(file)).toEqual({});
  });

  it('round-trips a written config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cbg-cfg-'));
    const file = join(dir, 'config.json');
    await writeConfig(file, { vault: '/v', folder: 'Mobile Lesezeichen/AI' });
    expect(await readConfig(file)).toEqual({ vault: '/v', folder: 'Mobile Lesezeichen/AI' });
    await rm(dir, { recursive: true, force: true });
  });

  it('merges a partial write into the existing config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cbg-cfg-'));
    const file = join(dir, 'config.json');
    await writeConfig(file, { vault: '/v' });
    const next = await writeConfig(file, { consentedAt: '2026-06-13T10:00:00.000Z' });
    expect(next).toEqual({ vault: '/v', consentedAt: '2026-06-13T10:00:00.000Z' });
    expect(await readConfig(file)).toEqual(next);
    await rm(dir, { recursive: true, force: true });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bootstrap.config.test.mjs`
Expected: FAIL — cannot resolve `../src/bootstrap/config.mjs`.

- [x] **Step 3: Write the minimal implementation**

Create `bookmarks-to-obsidian/src/bootstrap/config.mjs`:

```js
// Per-user state & configuration, kept OUTSIDE the skill folder so re-copying
// the skill never wipes consent or config. One JSON file holds everything:
//   { consentedAt, vault, folder, inbox }
//
// The pure resolver/read/write are unit-tested; the CLI at the bottom is the
// thin entry point Claude and bootstrap.mjs call so path resolution lives in one
// tested place instead of being guessed.
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const APP = 'bookmarks-to-obsidian';

/** OS-appropriate config directory (Windows: %APPDATA%; else $XDG_CONFIG_HOME or ~/.config). */
export function resolveConfigDir(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'win32') {
    const base = env.APPDATA || `${home}\\AppData\\Roaming`;
    return `${base}\\${APP}`;
  }
  const base = env.XDG_CONFIG_HOME || `${home}/.config`;
  return `${base}/${APP}`;
}

/** Absolute path to config.json. */
export function configPath(platform = process.platform, env = process.env, home = homedir()) {
  return join(resolveConfigDir(platform, env, home), 'config.json');
}

/** Parse config.json; a missing file is not an error (returns {}). */
export async function readConfig(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

/** Merge `patch` over the existing config and persist (creating the dir). Returns the merged object. */
export async function writeConfig(file, patch) {
  const next = { ...(await readConfig(file)), ...patch };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// --- tiny CLI ---------------------------------------------------------------
// node config.mjs --get [key]      -> full config JSON, or one raw value
// node config.mjs --set k=v [k=v]  -> merge and print the result
// node config.mjs --consent        -> stamp consentedAt = now (ISO)
// node config.mjs --path           -> print the resolved config.json path
async function cli(argv) {
  const file = configPath();
  const cmd = argv[0];
  if (cmd === '--path') {
    process.stdout.write(`${file}\n`);
    return;
  }
  if (cmd === '--consent') {
    const next = await writeConfig(file, { consentedAt: new Date().toISOString() });
    process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
    return;
  }
  if (cmd === '--get') {
    const cfg = await readConfig(file);
    if (argv[1]) process.stdout.write(`${cfg[argv[1]] ?? ''}\n`);
    else process.stdout.write(`${JSON.stringify(cfg, null, 2)}\n`);
    return;
  }
  if (cmd === '--set') {
    const patch = {};
    for (const kv of argv.slice(1)) {
      const eq = kv.indexOf('=');
      if (eq === -1) throw new Error(`--set expects key=value, got "${kv}"`);
      patch[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    const next = await writeConfig(file, patch);
    process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
    return;
  }
  process.stderr.write('usage: config.mjs --get [key] | --set k=v ... | --consent | --path\n');
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  cli(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`${e.message || e}\n`);
    process.exit(1);
  });
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/bootstrap.config.test.mjs`
Expected: PASS.

- [x] **Step 5: Verify the CLI round-trips end-to-end**

Run from `bookmarks-to-obsidian/`:

```bash
node src/bootstrap/config.mjs --path
node src/bootstrap/config.mjs --set vault=/tmp/test-vault folder="Mobile Lesezeichen/AI"
node src/bootstrap/config.mjs --get vault
node src/bootstrap/config.mjs --get
```

Expected: `--path` prints a `…/bookmarks-to-obsidian/config.json` path; `--get vault` prints `/tmp/test-vault`; `--get` prints the JSON with `vault` and `folder`. (This writes to your real config dir — delete the file afterward if you do not want the test value to persist: `node -e "const{configPath}=await import('./src/bootstrap/config.mjs');console.log(configPath())"` then remove it.)

- [x] **Step 6: Commit**

```bash
git add bookmarks-to-obsidian/src/bootstrap/config.mjs bookmarks-to-obsidian/test/bootstrap.config.test.mjs
git commit -m "feat(bootstrap): add per-user config resolver, read/write, and CLI"
```

---

## Task 7: `probe.mjs` — port/URL liveness check

Thin shell (it does real network I/O), used for cross-platform idempotency: if Chrome already answers on `:9222` or the proxy on `:9223`, don't relaunch. Smoke-tested against an ephemeral localhost server so the test is deterministic, not mocked.

**Files:**
- Create: `bookmarks-to-obsidian/src/bootstrap/probe.mjs`
- Test: `bookmarks-to-obsidian/test/bootstrap.probe.test.mjs`

- [x] **Step 1: Write the failing test**

Create `bookmarks-to-obsidian/test/bootstrap.probe.test.mjs`:

```js
import { describe, it, expect, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { probeUrl } from '../src/bootstrap/probe.mjs';

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"Browser":"Chrome"}');
});
const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

afterAll(() => new Promise((r) => server.close(r)));

describe('probeUrl', () => {
  it('returns true when something answers', async () => {
    expect(await probeUrl(`http://127.0.0.1:${port}/json/version`)).toBe(true);
  });

  it('returns false for a port with no listener', async () => {
    // Port 1 is privileged and never has our listener -> connection refused fast.
    expect(await probeUrl('http://127.0.0.1:1/json/version', { timeoutMs: 500 })).toBe(false);
  });

  it('returns false (not throw) on timeout', async () => {
    // 203.0.113.0/24 is TEST-NET-3, reserved and unroutable -> hangs until abort.
    expect(await probeUrl('http://203.0.113.1:9222/json/version', { timeoutMs: 300 })).toBe(false);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bootstrap.probe.test.mjs`
Expected: FAIL — cannot resolve `../src/bootstrap/probe.mjs`.

- [x] **Step 3: Write the minimal implementation**

Create `bookmarks-to-obsidian/src/bootstrap/probe.mjs`:

```js
// Liveness probe used for idempotency: does anything answer at `url`? Any HTTP
// response (even an error status) means a server is listening, which is all we
// need to decide "already running, skip launch". Network errors and timeouts
// resolve to false rather than throwing.
export async function probeUrl(url, { timeoutMs = 1500 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/bootstrap.probe.test.mjs`
Expected: PASS (3 tests).

- [x] **Step 5: Commit**

```bash
git add bookmarks-to-obsidian/src/bootstrap/probe.mjs bookmarks-to-obsidian/test/bootstrap.probe.test.mjs
git commit -m "feat(bootstrap): add URL liveness probe for idempotency"
```

---

## Task 8: `bootstrap.mjs` — the imperative orchestrator

Wires the pure modules together: consent gate → preflight → Chrome → proxy → container → poll → print the JSON output contract. It spawns processes (the only place that does) and assembles the status object; every decision delegates to a `src/bootstrap/*` function. There is no unit test for this file — it is the thin shell, verified by the real run in Task 10. After writing it, you smoke-test only its guard branches (consent gate, docker-unavailable) which need no Docker/Chrome.

**Files:**
- Create: `bookmarks-to-obsidian/bootstrap.mjs`

- [x] **Step 1: Write `bootstrap.mjs`**

Create `bookmarks-to-obsidian/bootstrap.mjs`:

```js
#!/usr/bin/env node
// Self-contained, cross-platform startup for the chrome-bookmarks-gateway stack.
// Reproduces, portably, what the old machine-specific cbg-up.ps1 did:
//   1. consent gate (refuse without recorded consent — safety belt)
//   2. preflight: docker daemon reachable? chrome located?
//   3. dedicated debugging Chrome on :9222 (idempotent by probe)
//   4. bundled CDP proxy 0.0.0.0:9223 -> 127.0.0.1:9222 (idempotent by probe)
//   5. gateway container (docker rm -f cbg; docker run …)
//   6. poll GET /syncz and classify
// Prints ONE JSON object on stdout for Claude to parse. Decision logic lives in
// src/bootstrap/* (pure, unit-tested); this file only spawns and assembles.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findChromePath, chromeArgs } from './src/bootstrap/chrome.mjs';
import { dockerRunArgs, isDaemonUp } from './src/bootstrap/docker.mjs';
import { probeUrl } from './src/bootstrap/probe.mjs';
import { interpretSyncz } from './src/bootstrap/syncz.mjs';
import { resolveConfigDir, configPath, readConfig } from './src/bootstrap/config.mjs';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const CHROME_PROBE = 'http://127.0.0.1:9222/json/version';
const PROXY_PROBE = 'http://127.0.0.1:9223/json/version';
const SYNCZ_URL = 'http://localhost:3000/syncz';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function spawnDetached(cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

async function waitUntil(fn, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await delay(intervalMs);
  }
}

async function getSyncz() {
  try {
    const res = await fetch(SYNCZ_URL);
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

async function pollSyncz(timeoutMs = 30000, intervalMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { status, body } = await getSyncz();
    const verdict = interpretSyncz(status, body);
    if (verdict === 'ready' || verdict === 'not-synced') return { verdict, status, body };
    if (Date.now() >= deadline) return { verdict: 'down', status, body };
    await delay(intervalMs);
  }
}

async function main() {
  // 1. Consent gate (safety belt). bootstrap never runs without recorded consent.
  const cfg = await readConfig(configPath());
  if (!cfg.consentedAt) {
    emit({ status: 'needs-consent', detail: 'No consent recorded. Ask the user, then `node src/bootstrap/config.mjs --consent`.' });
    process.exit(3);
  }

  // 2a. Preflight: docker daemon.
  if (!isDaemonUp()) {
    emit({ status: 'docker-unavailable', chrome: 'unknown', proxy: 'unknown', container: 'failed', syncz: null });
    return;
  }

  // 2b. Preflight: locate Chrome.
  const chromePath = findChromePath(process.platform, process.env);
  if (!chromePath) {
    emit({ status: 'chrome-not-found', chrome: 'not-found', proxy: 'unknown', container: 'failed', syncz: null });
    return;
  }

  // 3. Dedicated Chrome (persistent profile in the config dir — keeps the
  //    one-time Google sign-in across runs). Idempotent by probing :9222.
  let chrome = 'running';
  if (!(await probeUrl(CHROME_PROBE))) {
    const profileDir = join(resolveConfigDir(), 'chrome-profile');
    spawnDetached(chromePath, chromeArgs(profileDir));
    const up = await waitUntil(() => probeUrl(CHROME_PROBE), 20000, 500);
    chrome = up ? 'launched' : 'not-found';
    if (!up) {
      emit({ status: 'down', chrome, proxy: 'unknown', container: 'failed', syncz: null });
      return;
    }
  }

  // 4. Bundled CDP proxy. Idempotent by probing :9223 (which forwards to :9222).
  let proxy = 'running';
  if (!(await probeUrl(PROXY_PROBE))) {
    spawnDetached('node', [join(SKILL_DIR, 'cbg-cdp-proxy.cjs')]);
    await waitUntil(() => probeUrl(PROXY_PROBE), 8000, 400);
    proxy = 'started';
  }

  // 5. Gateway container: remove any existing `cbg`, then run fresh.
  spawnSync('docker', ['rm', '-f', 'cbg'], { stdio: 'ignore' });
  const run = spawnSync('docker', dockerRunArgs(), { stdio: 'ignore' });
  const container = run.status === 0 ? 'started' : 'failed';
  if (container === 'failed') {
    emit({ status: 'down', chrome, proxy, container, syncz: null });
    return;
  }

  // 6. Poll /syncz and classify.
  const { verdict, status } = await pollSyncz();
  emit({
    status: verdict, // ready | not-synced | down
    chrome,
    proxy,
    container,
    syncz: { status, ok: status === 200 },
  });
}

main().catch((e) => {
  emit({ status: 'down', error: e.message || String(e) });
  process.exit(1);
});
```

- [x] **Step 2: Smoke-test the consent gate (no Docker/Chrome needed)**

The gate must fire before any preflight. Point the config dir at an empty temp location so `consentedAt` is absent:

```bash
# from bookmarks-to-obsidian/  — XDG_CONFIG_HOME redirects the config dir on macOS/Linux.
XDG_CONFIG_HOME="$(mktemp -d)" node bootstrap.mjs; echo "exit=$?"
```

Expected: prints `{ "status": "needs-consent", … }` and `exit=3`.

On Windows PowerShell, redirect via `$env:APPDATA`:

```powershell
$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid()))
$env:APPDATA = $tmp.FullName; node bootstrap.mjs; "exit=$LASTEXITCODE"
```

Expected: `status: needs-consent`, `exit=3`.

- [x] **Step 3: Smoke-test the docker-unavailable branch**

Record consent in the temp config dir, then run with Docker stopped (or with `PATH` not containing docker) to confirm the daemon check short-circuits:

```bash
# from bookmarks-to-obsidian/
CFG="$(mktemp -d)"
XDG_CONFIG_HOME="$CFG" node src/bootstrap/config.mjs --consent >/dev/null
# Force isDaemonUp() false by hiding docker from PATH for this invocation:
XDG_CONFIG_HOME="$CFG" PATH="/nonexistent" node bootstrap.mjs; echo "exit=$?"
```

Expected: `{ "status": "docker-unavailable", … }`, `exit=0`. (If `node` itself is not on the stripped PATH on your system, instead stop Docker Desktop and run without the PATH override.)

- [x] **Step 4: Commit**

```bash
git add bookmarks-to-obsidian/bootstrap.mjs
git commit -m "feat(bootstrap): add cross-platform gateway orchestrator"
```

---

## Task 9: Rewrite SKILL.md (behavioral contract)

Replace the machine-specific "Defaults (this machine)" + `cbg-up.ps1` workflow with: a Prerequisites section, a config-driven Configuration section, and a Workflow step 1 that health-checks, consent-gates, bootstraps, and branches on the JSON status. Tool/vault paths become skill-relative and config-driven. Carry over everything in the existing SKILL.md that is unrelated to startup/paths (Rendering & images, Report statuses, Flags, Common mistakes) unchanged.

**Files:**
- Modify: `bookmarks-to-obsidian/SKILL.md` (replace lines for "Defaults (this machine)" and "Workflow"; add "Prerequisites" and "Configuration"; drop `cbg-up.ps1` from "Common mistakes" wording).

- [x] **Step 1: Replace the "Defaults (this machine)" section with Prerequisites + Configuration**

In `bookmarks-to-obsidian/SKILL.md`, replace this block:

```markdown
## Defaults (this machine)

- Tool: `C:\Users\juliu\.claude\skills\bookmarks-to-obsidian\import.mjs`
- Vault: `C:\Users\juliu\Documents\AIEngineeringArticles`
- Folder: `Mobile Lesezeichen/AI` (the iPad-reading home; ~197 links)
- Destination: `Clippings/` inside the vault — the Obsidian Web Clipper's own folder (created on first import). Override with `--inbox <subpath>`.
```

with:

```markdown
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

> **Apple Silicon (arm64):** <FINDING FROM TASK 1 — if the image is amd64-only,
> write: "the pinned gateway image is amd64-only; on Apple Silicon it runs under
> Docker Desktop's emulation (slower but functional)." If multi-arch, delete this
> callout entirely.>

## Configuration

All per-user values live in `config.json` in an OS config dir **outside** the
skill (`%APPDATA%\bookmarks-to-obsidian\` on Windows; `$XDG_CONFIG_HOME` or
`~/.config/bookmarks-to-obsidian/` on macOS/Linux), so re-copying the skill never
wipes them. Read/write it via the bundled CLI, run from the skill folder:

- `node src/bootstrap/config.mjs --get` — print the full config.
- `node src/bootstrap/config.mjs --set vault=<path>` — set the vault.
- `node src/bootstrap/config.mjs --consent` — record consent (stamps `consentedAt`).

Fields: `vault` (Obsidian vault root), `folder` (default `Mobile Lesezeichen/AI`),
`inbox` (default `Clippings`), `consentedAt`.

**First use:** if `vault` is unset, ask the user for their Obsidian vault path and
validate it — the directory **must exist** (reject and re-ask if not); a missing
`.obsidian/` folder is a soft warning that does not block. On success,
`--set vault=<path>`. Tool paths are skill-relative: invoke `node import.mjs` and
`node bootstrap.mjs` from the skill's own folder — never a hardcoded absolute path.
```

- [x] **Step 2: Fill in the Apple-Silicon caveat from Task 1**

Replace the `<FINDING FROM TASK 1 …>` placeholder with the actual finding recorded in Task 1, Step 2 — either the amd64-only sentence or delete the whole `> **Apple Silicon (arm64):** …` callout if the image is multi-arch. Do not leave the angle-bracket placeholder in the file.

- [x] **Step 3: Rewrite the Workflow section**

Replace the existing `## Workflow` block (steps 1–5, including the `cbg-up.ps1` lines and the two hardcoded `node "C:\Users\juliu\…\import.mjs" …` commands) with:

```markdown
## Workflow

1. **Health-check, then self-bootstrap if down.** Run all commands from the
   skill's own folder.
   - Health check: `curl -sS http://localhost:3000/syncz` → expect `{"ok":true}`.
   - **If it answers `{"ok":true}`** → the stack is up; go to step 2.
   - **If it is unreachable or returns `503`** → bring the stack up:
     1. **Consent.** Read `node src/bootstrap/config.mjs --get`. If `consentedAt`
        is absent, explain once — bootstrap will *launch a dedicated Chrome,
        start a local CDP proxy, and run a Docker container, binding ports
        3000 / 9222 / 9223* — and ask permission. On **yes**:
        `node src/bootstrap/config.mjs --consent`. On no, stop.
     2. **Bootstrap:** `node bootstrap.mjs`. It prints one JSON object; parse its
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
   node import.mjs --vault "<config.vault>" --folder "<config.folder, default Mobile Lesezeichen/AI>" --dry-run --limit 10
   ```
3. **Real import** (writes notes) — drop `--dry-run`; omit `--limit` for the full backfill:
   ```
   node import.mjs --vault "<config.vault>" --folder "<config.folder>"
   ```
4. **Parse** the JSON report on stdout and **summarize** in prose: imported N →
   inbox, plus skipped/failed counts. List the `skipped-thin` and `failed` items
   for manual triage. Never paste the raw JSON at the user.
5. **Offer next**: `--retry-failed` (re-attempts `failed` + `skipped-thin`), open
   the inbox, or clip a thin one manually in Safari/Web Clipper.
```

- [x] **Step 4: Drop the `cbg-up.ps1` reference from Common mistakes**

In the `## Common mistakes` section, replace the first bullet:

```markdown
- Running with the gateway down → the CLI exits 2 with `{"error":"gateway-unreachable"|"gateway-not-synced"}`. Start the gateway first; don't fabricate results.
```

with:

```markdown
- Running with the gateway down → the CLI exits 2 with `{"error":"gateway-unreachable"|"gateway-not-synced"}`. Bring the stack up first via Workflow step 1 (`node bootstrap.mjs`); don't fabricate results.
```

- [x] **Step 5: Verify no stale references remain**

Run from the repo root:

```bash
grep -rn "cbg-up.ps1\|C:\\\\Users\\\\juliu" bookmarks-to-obsidian/SKILL.md
```

Expected: no matches (empty output). If anything prints, fix it before committing.

- [x] **Step 6: Commit**

```bash
git add bookmarks-to-obsidian/SKILL.md
git commit -m "docs(skill): portable bootstrap + config-driven paths, drop cbg-up.ps1"
```

---

## Task 10: Full-suite green + real first-run verification

The pure helpers are unit-tested; the imperative shell is verified by an actual run on this machine (the spec's "verified by a real first run on each OS rather than mocked"). This is the integration gate.

**Files:** none (verification only).

- [x] **Step 1: Run the entire test suite**

Run from `bookmarks-to-obsidian/`: `npm test`
Expected: all suites pass — the pre-existing tests plus the five new `bootstrap.*` suites. Confirm the count went up by the new files and nothing regressed.

- [x] **Step 2: Real bootstrap run on this machine (Windows)**

With Docker Desktop running, from `bookmarks-to-obsidian/`:

```bash
node src/bootstrap/config.mjs --consent
node bootstrap.mjs
```

Expected: a JSON object with `chrome` `running`/`launched`, `proxy` `running`/`started`, `container` `started`, and `status` either `ready` (if the dedicated Chrome profile is already signed into Google sync) or `not-synced` (fresh profile — a Chrome window opened; this is the expected first-run state).

- [x] **Step 3: Confirm idempotency**

Run `node bootstrap.mjs` a second time.
Expected: `chrome: "running"` and `proxy: "running"` (probes found them already up — no duplicate Chrome window opens), container re-created, same `status`. Confirm only one dedicated Chrome window exists.

- [x] **Step 4: If `not-synced`, complete the one manual step and re-verify**

Sign into Google and enable bookmark sync in the dedicated Chrome window, then:

```bash
curl -sS http://localhost:3000/syncz
```

Expected: `{"ok":true}`. Re-run `node bootstrap.mjs` → `status: "ready"`.

- [x] **Step 5: End-to-end through the importer (unchanged CLI)**

Confirm the importer still drives the now-bootstrapped stack using config-supplied flags:

```bash
node src/bootstrap/config.mjs --set vault="C:\\Users\\juliu\\Documents\\AIEngineeringArticles"
node import.mjs --vault "C:\\Users\\juliu\\Documents\\AIEngineeringArticles" --folder "Mobile Lesezeichen/AI" --dry-run --limit 3
```

Expected: a JSON report with the dry-run preview (rendered candidates, no notes written). This proves the bootstrap brought up exactly what the unchanged importer needs.

- [x] **Step 6: Final commit (if any verification fixes were needed)**

If Steps 1–5 surfaced fixes, commit them with a clear message; otherwise nothing to commit (verification only). The branch is now ready for the finishing-a-development-branch flow.

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Task |
|---|---|
| Keep Docker, automate it (pinned image) | 5 (`GATEWAY_IMAGE`, `dockerRunArgs`), 8 |
| Any OS (win/mac/linux) | 4 (`chromeCandidates`/`findChromePath`), 6 (config dir), 8 |
| Consent: ask once, then automatic | 6 (`--consent`, `consentedAt`), 8 (gate), 9 (workflow) |
| Hard constraints surfaced & detected | 8 (`docker-unavailable`, `chrome-not-found`, poll→`not-synced`), 9 |
| arm64 risk verified first | 1, fed into 9 |
| `bootstrap.mjs` orchestrator, idempotent, in order | 8 |
| Preflight (`docker version`, locate Chrome) | 5 (`isDaemonUp`), 4 (`findChromePath`), 8 |
| Dedicated Chrome, idempotent by probing `:9222` | 4 (`chromeArgs`), 7 (`probeUrl`), 8 |
| Bundled CDP proxy, idempotent by probing `:9223` | 2 (bundle), 8 |
| Container with `host.docker.internal` + `--add-host`; rm then run | 5, 8 |
| Poll `/syncz` → ready/not-synced/down | 3 (`interpretSyncz`), 8 (`pollSyncz`) |
| Output contract (single JSON object) | 8 (`emit`) |
| Refuse without consent (distinct status) | 8 (`needs-consent`, exit 3) |
| Config file outside skill, OS-appropriate dir | 6 |
| Config CLI (`--get`/`--set`) | 6 |
| Vault validated on first use (dir must exist; `.obsidian` soft) | 9 (Configuration) |
| Importer unchanged; Claude passes config as flags | 9 (Workflow), unchanged `import.mjs` |
| Skill-relative tool paths | 9 |
| Move proxy into skill | 2 |
| `src/bootstrap/*` pure & independently testable | 3–7 |
| SKILL.md rewrite (Prereqs/Config/Workflow), remove `cbg-up.ps1` | 9 |
| Unit tests for pure helpers | 3, 4, 5, 6 (+ probe smoke 7) |

No gaps. The optional `cbg-up.ps1`/`cbg-up.sh` wrapper from the spec is explicitly out (spec marks it "not required") — deliberately omitted to stay YAGNI.

**2. Placeholder scan**

One intentional placeholder exists: the `<FINDING FROM TASK 1>` Apple-Silicon caveat in Task 9, Step 1, resolved in Task 9, Step 2 from the Task 1 investigation. It is a sequenced hand-off, not an unfilled blank — the resolving step and both possible literal texts are spelled out. No other `TBD`/"add error handling"/"write tests for the above" placeholders; every code step shows complete code.

**3. Type / name consistency**

- `findChromePath(platform, env, exists)` / `chromeArgs(profileDir)` — defined Task 4, called Task 8 with matching arity (`findChromePath(process.platform, process.env)`, `chromeArgs(profileDir)`). ✓
- `dockerRunArgs()` default `hostCdpUrl: 'http://host.docker.internal:9223'`; `isDaemonUp()` — defined Task 5, called Task 8. ✓
- `interpretSyncz(status, body)` — defined Task 3, called Task 8 in `pollSyncz`. ✓
- `resolveConfigDir`/`configPath`/`readConfig`/`writeConfig` — defined Task 6, called Task 8 (`readConfig(configPath())`, `resolveConfigDir()`) and by the config CLI. ✓
- `probeUrl(url, { timeoutMs })` — defined Task 7, called Task 8 (`probeUrl(CHROME_PROBE)`, `probeUrl(PROXY_PROBE)`). ✓
- Probe targets: Chrome `:9222/json/version`, proxy `:9223/json/version`; container ports `3000/9222/9223` consistent across Tasks 8 and 9. ✓
- Output `status` vocabulary (`ready | not-synced | docker-unavailable | chrome-not-found | down | needs-consent`) consistent between Task 8 (`emit`) and Task 9 (Workflow branch). ✓

No mismatches found.

---

## Execution Handoff

**Plan complete and saved to `docs/plans/2026-06-13-portable-docker-bootstrap.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

---

## Execution Notes (2026-06-13)

Executed inline on `main` (Windows / Docker Desktop). All 10 tasks complete; full
suite green (102 passing, 2 skipped). Real run reached `ready` after the manual
Google sign-in; the 3-item dry-run import drove the bootstrapped stack end-to-end
(gateway listed 230 bookmarks, Chrome rendered 3 previews over CDP).

Two deviations from the plan, both verified and committed:

1. **`configPath` portability fix (Task 6).** The plan used `path.join`, which
   emits `\` on Windows and so produced `\home\me\…` when called with the explicit
   `'linux'` platform argument, failing the plan's own forward-slash test. Changed
   `configPath` to append `config.json` with the separator for the *platform
   argument* (matching how `resolveConfigDir` already builds its string), keeping
   the pure resolver host-independent. Removed the now-unused `join` import.

2. **`CHROME_CDP_URL` must be an IP literal, not a hostname (Tasks 5 & 8).** The
   plan's `dockerRunArgs` default `http://host.docker.internal:9223` made the
   gateway send `Host: host.docker.internal`, which Chrome's remote-debugging
   endpoint rejects ("not an IP address or localhost" — DNS-rebinding guard), so
   the container logged "CDP endpoint did not become ready" and exited 1. This is
   internally inconsistent with the proxy's own comment, which assumes an IP-literal
   Host. Fix (commit `918a862`): added pure `parseHostIp` + thin-shell
   `resolveHostIp` to `docker.mjs` (probes a throwaway `busybox` container's
   `/etc/hosts`, which `--add-host=host.docker.internal:host-gateway` populates with
   the host-routable IP — Docker Desktop → `192.168.65.254`, native Linux → the
   host-gateway IP); `bootstrap.mjs` now passes that IP as `http://<ip>:9223`.
   Portable, no hardcoded IP, satisfies Chrome's allowlist. Added 6 `parseHostIp`
   unit tests. The hostname default in `dockerRunArgs` is retained as a documented
   fallback (pinned by the existing test) but `bootstrap.mjs` always overrides it.
