// Build the `docker run` argv for the pinned gateway container, and probe the
// daemon. dockerRunArgs is pure (unit-tested); isDaemonUp is the thin shell
// wrapper exercised by the real first run.
import { spawnSync } from 'node:child_process';

export const GATEWAY_IMAGE = 'pvoronin/chrome-bookmarks-gateway:0.3.0';

// Tiny throwaway image used only to read the container's /etc/hosts (no getent
// dependency — every image has `cat`). See resolveHostIp.
export const PROBE_IMAGE = 'busybox';

/**
 * Args (after the literal `docker`) to run the gateway container.
 * Adds --add-host=host.docker.internal:host-gateway so the name resolves on
 * native Linux Docker too (Docker Desktop resolves it already).
 *
 * `hostCdpUrl` MUST carry an IP literal, not a hostname: Chrome's remote-
 * debugging HTTP endpoint rejects any Host header that is not an IP address or
 * `localhost` (DNS-rebinding guard), and the raw-forwarding proxy preserves that
 * Host. bootstrap.mjs resolves the host's IP via resolveHostIp() and passes it
 * here. The hostname default below is a documented fallback only — it does not
 * satisfy Chrome's allowlist, so production callers always override it.
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

/**
 * Pure: extract the IP that an /etc/hosts dump maps to `host.docker.internal`.
 * `--add-host=host.docker.internal:host-gateway` writes that line for us, so the
 * value is the host-routable IP (Docker Desktop -> 192.168.65.254; native Linux
 * -> the host-gateway IP). Returns the first matching IP, or null.
 */
export function parseHostIp(etcHosts, hostname = 'host.docker.internal') {
  for (const raw of String(etcHosts).split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const [ip, ...names] = line.split(/\s+/);
    if (names.includes(hostname)) return ip;
  }
  return null;
}

/**
 * Thin shell: run a throwaway container that prints its /etc/hosts (with the
 * host-gateway add-host) and parse out the host IP. Returns the IP string, or
 * null if docker/the probe failed. Injectable `run` for tests.
 */
export function resolveHostIp(run = spawnSync) {
  try {
    const r = run(
      'docker',
      ['run', '--rm', '--add-host=host.docker.internal:host-gateway', PROBE_IMAGE, 'cat', '/etc/hosts'],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) return null;
    return parseHostIp(r.stdout || '');
  } catch {
    return null;
  }
}
