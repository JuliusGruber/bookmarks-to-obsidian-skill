// Per-user state & configuration, kept OUTSIDE the skill folder so re-copying
// the skill never wipes consent or config. One JSON file holds everything:
//   { consentedAt, vault, folder, inbox }
//
// The pure resolver/read/write are unit-tested; the CLI at the bottom is the
// thin entry point Claude and bootstrap.mjs call so path resolution lives in one
// tested place instead of being guessed.
import { homedir } from 'node:os';
import { dirname } from 'node:path';
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

/** Absolute path to config.json. Uses the separator for `platform` (not the host)
 *  so the pure resolver stays correct when a foreign platform is passed in tests. */
export function configPath(platform = process.platform, env = process.env, home = homedir()) {
  const sep = platform === 'win32' ? '\\' : '/';
  return `${resolveConfigDir(platform, env, home)}${sep}config.json`;
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
