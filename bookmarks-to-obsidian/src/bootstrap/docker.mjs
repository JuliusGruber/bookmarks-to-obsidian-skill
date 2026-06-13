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
