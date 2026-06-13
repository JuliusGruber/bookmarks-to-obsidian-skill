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
