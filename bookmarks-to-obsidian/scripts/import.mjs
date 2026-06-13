#!/usr/bin/env node
// Bookmark -> Obsidian importer (deterministic CLI).
//
// Walks a Chrome bookmark folder via the local chrome-bookmarks-gateway,
// extracts each new article to clean Web-Clipper-parity markdown with Defuddle,
// writes notes into a vault inbox, and prints a structured JSON report.
//
// Usage:
//   node import.mjs --vault <path> --folder "Mobile Lesezeichen/AI" [options]
//
// See --help for the full flag list.

import { mkdir, readdir } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { checkGateway, getTree, findFolder, collectBookmarks } from './src/gateway.mjs';
import { fetchPage, extractFromHtml } from './src/extract.mjs';
import { splitAuthors, normalizeDate, buildFrontmatter } from './src/frontmatter.mjs';
import { sanitizeFilename, uniqueFilename, writeNoteFile } from './src/note.mjs';
import {
  normalizeUrl,
  scanVaultSources,
  readManifest,
  writeManifest,
} from './src/dedup.mjs';
import { buildReport } from './src/report.mjs';
import { connectBrowser, renderPage } from './src/render.mjs';
import { downloadImages } from './src/images.mjs';
import { looksLikeShell } from './src/shell.mjs';

const HELP = `bookmarks-to-obsidian — import Chrome bookmarks into an Obsidian vault.

Required:
  --vault <path>         Absolute path to the Obsidian vault root.
  --folder <name|path>   Bookmark folder, e.g. "Mobile Lesezeichen/AI".
                         A bare ambiguous name errors with the candidate paths.

Options:
  --inbox <subpath>      Vault-relative destination folder (default: Clippings).
  --dry-run              Plan only: fetch/extract nothing is written, no manifest update.
  --limit <N>            Process at most N new bookmarks this run.
  --retry-failed         Re-attempt manifest entries marked failed or skipped-thin.
  --min-words <N>        Word-count floor for the thin-content gate (default: 200).
  --concurrency <N>      Parallel fetches (default: 4).
  --no-render            Skip Chrome rendering; use the raw-fetch path only.
  --cdp-url <url>        Chrome CDP endpoint for rendering (default: http://localhost:9222).
  --render-concurrency <N>  Parallel render tabs (default: 3).
  --no-dismiss-consent   Do not auto-click cookie/consent accept buttons (default: on).
  --rpc-url <url>        Gateway RPC URL (default: http://localhost:3000/rpc).
  --gateway <url>        Gateway base URL for health check (default: http://localhost:3000).
  -h, --help             Show this help.

Output: a JSON report on stdout. Diagnostics go to stderr.`;

function parseArgs(argv) {
  const opts = {
    vault: null,
    folder: null,
    inbox: 'Clippings',
    dryRun: false,
    limit: Infinity,
    retryFailed: false,
    minWords: 200,
    concurrency: 4,
    render: true,
    cdpUrl: 'http://localhost:9222',
    renderConcurrency: 3,
    dismissConsent: true,
    rpcUrl: 'http://localhost:3000/rpc',
    gateway: 'http://localhost:3000',
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    switch (a) {
      case '--vault': opts.vault = next(); break;
      case '--folder': opts.folder = next(); break;
      case '--inbox': opts.inbox = next(); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--limit': opts.limit = Number(next()); break;
      case '--retry-failed': opts.retryFailed = true; break;
      case '--min-words': opts.minWords = Number(next()); break;
      case '--concurrency': opts.concurrency = Math.max(1, Number(next())); break;
      case '--rpc-url': opts.rpcUrl = next(); break;
      case '--gateway': opts.gateway = next(); break;
      case '--no-render': opts.render = false; break;
      case '--cdp-url': opts.cdpUrl = next(); break;
      case '--render-concurrency': opts.renderConcurrency = Math.max(1, Number(next())); break;
      case '--no-dismiss-consent': opts.dismissConsent = false; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

function todayISO() {
  const d = new Date();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mo}-${da}`;
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function fail(error, detail) {
  process.stdout.write(`${JSON.stringify({ error, detail }, null, 2)}\n`);
  process.exit(2);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (!opts.vault) fail('missing-vault', 'Pass --vault <path>.');
  if (!opts.folder) fail('missing-folder', 'Pass --folder "<name or path>".');

  const vaultAbs = isAbsolute(opts.vault) ? opts.vault : resolve(opts.vault);
  const inboxAbs = join(vaultAbs, opts.inbox);
  const attachDir = join(inboxAbs, '_attachments');
  const manifestPath = join(inboxAbs, '.import-state.json');
  const created = todayISO();

  // 1. Gateway health.
  const health = await checkGateway(opts.gateway);
  if (health.status === 0) fail('gateway-unreachable', `Cannot reach ${opts.gateway}. Run cbg-up.ps1.`);
  if (!health.ok) fail('gateway-not-synced', `GET /syncz -> ${health.status}. Chrome profile not synced.`);

  // 2. Resolve the folder and its bookmarks.
  let bookmarks;
  let folderName;
  try {
    const roots = await getTree(opts.rpcUrl);
    const folder = findFolder(roots, opts.folder);
    folderName = folder.title;
    bookmarks = collectBookmarks(folder);
  } catch (e) {
    fail('folder-resolution-failed', e.message);
    return;
  }

  // 3. Dedup state: vault scan (truth) + manifest (provenance/fast path).
  const vaultSet = await scanVaultSources(vaultAbs);
  const manifest = await readManifest(manifestPath);
  let existingNames = new Set();
  try {
    existingNames = new Set((await readdir(inboxAbs)).filter((n) => n.toLowerCase().endsWith('.md')));
  } catch {
    /* inbox not created yet */
  }

  // 4. Classify each bookmark into already-decided vs. to-process.
  const outcomes = []; // final report items, in bookmark order
  const toProcess = []; // { bm, norm, slot } slot = index into outcomes
  const seen = new Set();
  for (const bm of bookmarks) {
    const norm = normalizeUrl(bm.url);
    const slot = outcomes.length;
    if (seen.has(norm)) {
      outcomes.push({ url: bm.url, title: bm.title, status: 'skipped-existing', reason: 'duplicate in run' });
      continue;
    }
    seen.add(norm);
    if (vaultSet.has(norm)) {
      outcomes.push({ url: bm.url, title: bm.title, status: 'skipped-existing', reason: 'already in vault' });
      continue;
    }
    const m = manifest[norm];
    const retryable = m && (m.status === 'failed' || m.status === 'skipped-thin');
    if (m && !(opts.retryFailed && retryable)) {
      const status = m.status === 'imported' ? 'skipped-existing' : m.status;
      outcomes.push({ url: bm.url, title: bm.title, status, reason: 'remembered', file: m.file });
      continue;
    }
    outcomes.push({ url: bm.url, title: bm.title, status: 'pending' });
    toProcess.push({ bm, norm, slot });
  }

  // 5. Apply --limit; anything beyond it is reported, never silently dropped.
  // Dry-run renders for an honest preview; without an explicit --limit, cap it.
  const effectiveLimit = (opts.dryRun && !Number.isFinite(opts.limit)) ? 10 : opts.limit;
  const within = toProcess.slice(0, effectiveLimit);
  for (const { bm, slot } of toProcess.slice(effectiveLimit)) {
    outcomes[slot] = { url: bm.url, title: bm.title, status: 'skipped-limit', reason: `beyond --limit ${effectiveLimit}` };
  }

  if (!opts.dryRun && within.length) await mkdir(inboxAbs, { recursive: true });

  // Connect to the gateway Chrome for rendering. Failure → whole run uses fetch.
  let browser = null;
  if (opts.render && within.length) {
    try {
      browser = await connectBrowser(opts.cdpUrl);
    } catch (e) {
      process.stderr.write(`render disabled: cannot connect to ${opts.cdpUrl} (${e.message})\n`);
    }
  }

  // Seed attachment names from the existing _attachments/ so a later run never
  // overwrites a prior note's image when two articles share a sanitized title.
  const attachTaken = new Set();
  if (!opts.dryRun) {
    try { for (const n of await readdir(attachDir)) attachTaken.add(n); } catch { /* none yet */ }
  }

  // 6. Render → pick-the-better-vs-fetch → harvest images → write.
  const poolSize = browser ? opts.renderConcurrency : opts.concurrency;
  let done = 0;

  await mapPool(within, poolSize, async ({ bm, norm, slot }) => {
    let host = '';
    try { host = new URL(bm.url).host; } catch { /* keep '' */ }

    // --- 1. Render candidate (markdown + rendered-DOM metadata + captured bytes). ---
    let rendered = null;   // { markdown, wordCount, meta, images, shell }
    if (browser) {
      const r = await renderPage(browser, bm.url, {
        navTimeoutMs: 25000,
        dismissConsent: opts.dismissConsent,
      });
      if (r.status === 'ok') {
        // r.content is already markdown, converted in-page (preserves inline images
        // that a node re-parse of the cleaned fragment would drop — see render.mjs).
        const md = r.content || '';
        rendered = {
          markdown: md,
          wordCount: r.wordCount || 0,
          meta: r,                 // rendered-DOM metadata
          images: r.images,        // Map<url,{bytes,contentType}> from the live page
          shell: looksLikeShell(md, { minWords: opts.minWords }),
        };
      }
      // render-failed → rendered stays null → fetch below.
    }

    const renderGood = rendered && rendered.wordCount >= opts.minWords && !rendered.shell;

    // --- 2. Fetch candidate, only when the render isn't already good. ---
    let fetched = null;       // { markdown, wordCount, meta, shell }
    let fetchOutcome = null;  // terminal fetch status when there is no usable body
    if (!renderGood) {
      const f = await fetchPage(bm.url, { timeoutMs: 20000 });
      if (f.status === 'ok') {
        const ex = await extractFromHtml(f.html, bm.url, { minWords: opts.minWords });
        const md = ex.content || '';
        fetched = {
          markdown: md,
          wordCount: ex.wordCount || 0,
          meta: ex.meta,
          shell: looksLikeShell(md, { minWords: opts.minWords }),
        };
      } else {
        fetchOutcome = f; // { status: 'failed' | 'skipped-binary', reason }
      }
    }

    // --- 3. Pick the better: disqualify shell/thin, longest wins, render breaks ties. ---
    const candidates = [];
    if (rendered) candidates.push({ ...rendered, path: 'rendered' });
    if (fetched) candidates.push({ ...fetched, path: 'fetched-fallback' });
    const qualified = candidates.filter((c) => c.wordCount >= opts.minWords && !c.shell);
    qualified.sort((a, b) => (b.wordCount - a.wordCount) || (a.path === 'rendered' ? -1 : 1));
    const winner = qualified[0] || null;

    if (!winner) {
      // Nothing usable. Prefer a terminal fetch status (failed/binary) when we have
      // one; otherwise report thin against whichever candidate we did get.
      done += 1;
      if (fetchOutcome && fetchOutcome.status === 'failed') {
        outcomes[slot] = { url: bm.url, title: bm.title, status: 'failed', reason: fetchOutcome.reason, path: 'fetched-fallback' };
        manifest[norm] = { bookmarkId: bm.id, status: 'failed', reason: fetchOutcome.reason, at: created };
        process.stderr.write(`[${done}/${within.length}] failed  ${bm.title || host}\n`);
        return;
      }
      if (fetchOutcome && fetchOutcome.status === 'skipped-binary') {
        outcomes[slot] = { url: bm.url, title: bm.title, status: 'skipped-binary', reason: fetchOutcome.reason, path: 'fetched-fallback' };
        manifest[norm] = { bookmarkId: bm.id, status: 'skipped-binary', reason: fetchOutcome.reason, at: created };
        process.stderr.write(`[${done}/${within.length}] binary  ${bm.title || host}\n`);
        return;
      }
      const wc = (rendered && rendered.wordCount) || (fetched && fetched.wordCount) || 0;
      const reason = `wordCount ${wc} < ${opts.minWords}` + ((rendered && rendered.shell) || (fetched && fetched.shell) ? ' (shell)' : '');
      const path = rendered ? 'rendered' : 'fetched-fallback';
      outcomes[slot] = { url: bm.url, title: bm.title, status: 'skipped-thin', reason, path };
      manifest[norm] = { bookmarkId: bm.id, status: 'skipped-thin', reason, at: created };
      process.stderr.write(`[${done}/${within.length}] thin    ${bm.title || host}\n`);
      return;
    }

    let markdown = winner.markdown;
    const wordCount = winner.wordCount;
    const metaSource = winner.meta;
    const pathTaken = winner.path;
    const capturedBytes = winner.path === 'rendered' ? winner.images : new Map();

    // --- 4. Title + filename (disambiguated against existing notes). ---
    const title = (metaSource && metaSource.title) || bm.title || host || 'untitled';
    const base = sanitizeFilename(title);
    const filename = uniqueFilename(base, '.md', (n) => existingNames.has(n));
    existingNames.add(filename);

    // --- 5. Harvest images (real runs only). Slug = disambiguated filename so the
    //        attachment names trace to THIS note and never collide cross-run. ---
    let images = { downloaded: 0, remote: 0, dropped: 0 };
    if (!opts.dryRun) {
      images = await downloadImages(markdown, {
        baseUrl: bm.url,
        slug: filename.replace(/\.md$/i, ''),
        attachDir,
        capturedBytes,
        takenNames: attachTaken,
      });
      markdown = images.markdown;
    }

    // --- 6. Assemble + write the note. ---
    const body = buildFrontmatter({
      title,
      source: bm.url,
      authors: splitAuthors(metaSource && metaSource.author),
      published: normalizeDate(metaSource && metaSource.published),
      description: (metaSource && metaSource.description) || '',
      created,
    }) + `\n${markdown}\n`;

    if (!opts.dryRun) await writeNoteFile(join(inboxAbs, filename), body);

    done += 1;
    outcomes[slot] = {
      url: bm.url,
      title,
      status: 'imported',
      file: filename,
      wordCount,
      path: pathTaken,
      images: { downloaded: images.downloaded, remote: images.remote, dropped: images.dropped },
      dryRun: opts.dryRun || undefined,
    };
    manifest[norm] = { bookmarkId: bm.id, status: 'imported', file: filename, at: created };
    process.stderr.write(`[${done}/${within.length}] ${pathTaken === 'rendered' ? 'render ' : 'fetch  '} ${title}\n`);
  });

  if (browser) { try { await browser.disconnect(); } catch { /* ignore */ } }

  // 7. Persist manifest (real runs only) and emit the report.
  if (!opts.dryRun) await writeManifest(manifestPath, manifest);

  const report = buildReport(outcomes);
  report.meta = {
    folder: folderName,
    folderSpec: opts.folder,
    vault: vaultAbs,
    inbox: opts.inbox,
    totalBookmarks: bookmarks.length,
    dryRun: opts.dryRun,
    minWords: opts.minWords,
    limit: Number.isFinite(opts.limit) ? opts.limit : null,
    retryFailed: opts.retryFailed,
    render: {
      enabled: Boolean(browser),
      rendered: outcomes.filter((o) => o && o.path === 'rendered').length,
      fetchedFallback: outcomes.filter((o) => o && o.path === 'fetched-fallback').length,
      imagesDownloaded: outcomes.reduce((n, o) => n + ((o && o.images && o.images.downloaded) || 0), 0),
      imagesRemote: outcomes.reduce((n, o) => n + ((o && o.images && o.images.remote) || 0), 0),
    },
    generatedAt: created,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e.stack || e}\n`);
  fail('unexpected', e.message || String(e));
});
