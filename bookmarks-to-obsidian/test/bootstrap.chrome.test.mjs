import { describe, it, expect } from 'vitest';
import { chromeCandidates, findChromePath, chromeArgs } from '../scripts/src/bootstrap/chrome.mjs';

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
