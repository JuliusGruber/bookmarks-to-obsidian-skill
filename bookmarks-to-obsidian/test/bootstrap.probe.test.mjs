import { describe, it, expect, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { probeUrl } from '../scripts/src/bootstrap/probe.mjs';

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
