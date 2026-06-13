import { describe, it, expect } from 'vitest';
import { interpretSyncz } from '../scripts/src/bootstrap/syncz.mjs';

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
