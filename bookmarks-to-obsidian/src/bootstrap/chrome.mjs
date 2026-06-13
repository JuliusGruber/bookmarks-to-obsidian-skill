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
