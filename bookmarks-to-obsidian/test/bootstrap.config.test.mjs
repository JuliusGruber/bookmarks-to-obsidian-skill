import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfigDir, configPath, readConfig, writeConfig } from '../scripts/src/bootstrap/config.mjs';

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
