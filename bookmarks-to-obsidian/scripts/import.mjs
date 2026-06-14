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
import { writeNoteFile } from './src/note.mjs';
import {
  scanVault,
  readManifest,
  writeManifest,
} from './src/dedup.mjs';
import { buildReport } from './src/report.mjs';
import { connectBrowser, renderPage } from './src/render.mjs';
import { downloadImages } from './src/images.mjs';
import { looksLikeShell } from './src/shell.mjs';
import { fingerprint } from './src/fingerprint.mjs';
import { reconcile } from './src/reconcile.mjs';
import {
  classifyBookmarks,
  buildListPayload,
  partitionIds,
  buildDeclineEntries,
  clearDeclined,
} from './src/classify.mjs';

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
  --list                 Classify only: print { new[], counts } as JSON, then exit (read-only).
  --import-ids <id,…>    Import only the bookmarks whose ids are in this comma-separated set.
  --decline-ids <id,…>   Record these bookmark ids as declined (hidden from future syncs).
  --reset-declined       Remove every declined manifest entry, report the count, and exit.
  --min-words <N>        Word-count floor for the thin-content gate (default: 200).
  --dup-distance <N>     SimHash Hamming threshold for near-duplicate detection (default: 6).
  --no-content-dedup     Disable content dedup (URL dedup only; no fingerprinting).
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
    list: false,
    importIds: null,
    declineIds: null,
    resetDeclined: false,
    minWords: 200,
    dupDistance: 6,
    contentDedup: true,
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
      case '--list': opts.list = true; break;
      case '--import-ids': opts.importIds = parseIdList(next()); break;
      case '--decline-ids': opts.declineIds = parseIdList(next()); break;
      case '--reset-declined': opts.resetDeclined = true; break;
      case '--min-words': opts.minWords = Number(next()); break;
      case '--dup-distance': opts.dupDistance = Math.max(0, Number(next())); break;
      case '--no-content-dedup': opts.contentDedup = false; break;
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

function parseIdList(s) {
  return String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
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

  // --reset-declined: pure local manifest op — no gateway, no folder required.
  if (opts.resetDeclined) {
    const vaultAbs0 = isAbsolute(opts.vault) ? opts.vault : resolve(opts.vault);
    const manifestPath0 = join(vaultAbs0, opts.inbox, '.import-state.json');
    const manifest0 = await readManifest(manifestPath0);
    const { cleared } = clearDeclined(manifest0);
    if (cleared) await writeManifest(manifestPath0, manifest0);
    process.stdout.write(`${JSON.stringify({
      mode: 'reset-declined',
      cleared,
      meta: { vault: vaultAbs0, inbox: opts.inbox, generatedAt: todayISO() },
    }, null, 2)}\n`);
    return;
  }

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

  // --list: read-only classification. URL-only scan (skip the unused content index).
  if (opts.list) {
    const { urls: vaultSet } = await scanVault(vaultAbs, { content: false });
    const manifest = await readManifest(manifestPath);
    const classification = classifyBookmarks(bookmarks, { vaultSet, manifest, retryFailed: opts.retryFailed });
    process.stdout.write(`${JSON.stringify(buildListPayload(classification, {
      folder: folderName,
      folderSpec: opts.folder,
      vault: vaultAbs,
      inbox: opts.inbox,
      generatedAt: created,
    }), null, 2)}\n`);
    return;
  }

  // 3. Dedup state: vault scan (truth) + manifest (provenance/fast path).
  const { urls: vaultSet, content: contentIndex } = await scanVault(vaultAbs, { content: opts.contentDedup });
  const manifest = await readManifest(manifestPath);
  let existingNames = new Set();
  try {
    existingNames = new Set((await readdir(inboxAbs)).filter((n) => n.toLowerCase().endsWith('.md')));
  } catch {
    /* inbox not created yet */
  }

  // 4. Classify into new vs already-decided — the single definition of "new".
  const { newItems, decided } = classifyBookmarks(bookmarks, {
    vaultSet,
    manifest,
    retryFailed: opts.retryFailed,
  });

  // 5. Populate the report slots (bookmark order, sparse) and the work list.
  //    Two modes:
  //      - id-scoped (--import-ids/--decline-ids): exactly the kept ids; record declines.
  //      - default: all new, capped by --limit (the "import everything" escape).
  const outcomes = new Array(bookmarks.length); // sparse; filtered before report
  const idScoped = opts.importIds !== null || opts.declineIds !== null;
  let within = []; // [{ bm, norm, slot }] to render this run
  let declinedThisRun = 0;
  const notes = [];

  if (idScoped) {
    const { importSet, declineSet } = partitionIds(opts.importIds, opts.declineIds);

    // Kept ids that turned out to be already-decided (e.g. now in the vault) are
    // echoed at their slot; an item that became existing in the meantime stays skipped.
    for (const d of decided) {
      if (importSet.has(d.id)) {
        outcomes[d.slot] = { url: d.url, title: d.title, status: d.status, reason: d.reason, file: d.file, duplicateOf: d.duplicateOf };
      }
    }
    // Kept ids that are genuinely new → render them.
    for (const it of newItems) {
      if (!importSet.has(it.id)) continue;
      outcomes[it.slot] = { url: it.url, title: it.title, status: 'pending' };
      within.push({ bm: { id: it.id, title: it.title, url: it.url }, norm: it.norm, slot: it.slot });
    }
    // Kept ids that no longer exist (deleted since --list) → a note, no crash.
    const known = new Set(bookmarks.map((b) => b.id));
    for (const id of importSet) if (!known.has(id)) notes.push(`import: unknown id ${id} (skipped)`);

    // Declines: pure manifest writes, no render.
    const { entries, declined, unknownIds } = buildDeclineEntries([...declineSet], bookmarks, created);
    for (const [norm, rec] of Object.entries(entries)) manifest[norm] = rec;
    declinedThisRun = declined;
    for (const id of unknownIds) notes.push(`decline: unknown id ${id} (skipped)`);
  } else {
    for (const d of decided) {
      outcomes[d.slot] = { url: d.url, title: d.title, status: d.status, reason: d.reason, file: d.file, duplicateOf: d.duplicateOf };
    }
    const toProcess = [];
    for (const it of newItems) {
      outcomes[it.slot] = { url: it.url, title: it.title, status: 'pending' };
      toProcess.push({ bm: { id: it.id, title: it.title, url: it.url }, norm: it.norm, slot: it.slot });
    }
    // --limit: dry-run renders for an honest preview; without an explicit --limit, cap it.
    const effectiveLimit = (opts.dryRun && !Number.isFinite(opts.limit)) ? 10 : opts.limit;
    within = toProcess.slice(0, effectiveLimit);
    for (const { bm, slot } of toProcess.slice(effectiveLimit)) {
      outcomes[slot] = { url: bm.url, title: bm.title, status: 'skipped-limit', reason: `beyond --limit ${effectiveLimit}` };
    }
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

  // 6. Phase A: EXTRACT (parallel) → pick winner → fingerprint. Terminal
  //    failures (failed / binary / thin) settle straight into the report here.
  const poolSize = browser ? opts.renderConcurrency : opts.concurrency;
  const candidates = [];
  let settled = 0;

  await mapPool(within, poolSize, async ({ bm, norm, slot }) => {
    let host = '';
    try { host = new URL(bm.url).host; } catch { /* keep '' */ }

    // --- 1. Render candidate. ---
    let rendered = null;
    if (browser) {
      const r = await renderPage(browser, bm.url, {
        navTimeoutMs: 25000,
        dismissConsent: opts.dismissConsent,
      });
      if (r.status === 'ok') {
        const md = r.content || '';
        rendered = {
          markdown: md,
          wordCount: r.wordCount || 0,
          meta: r,
          images: r.images,
          shell: looksLikeShell(md, { minWords: opts.minWords }),
        };
      }
    }
    const renderGood = rendered && rendered.wordCount >= opts.minWords && !rendered.shell;

    // --- 2. Fetch candidate, only when the render isn't already good. ---
    let fetched = null;
    let fetchOutcome = null;
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
        fetchOutcome = f;
      }
    }

    // --- 3. Pick the better: disqualify shell/thin, longest wins, render breaks ties. ---
    const cands = [];
    if (rendered) cands.push({ ...rendered, path: 'rendered' });
    if (fetched) cands.push({ ...fetched, path: 'fetched-fallback' });
    const qualified = cands.filter((c) => c.wordCount >= opts.minWords && !c.shell);
    qualified.sort((a, b) => (b.wordCount - a.wordCount) || (a.path === 'rendered' ? -1 : 1));
    const winner = qualified[0] || null;

    if (!winner) {
      settled += 1;
      if (fetchOutcome && fetchOutcome.status === 'failed') {
        outcomes[slot] = { url: bm.url, title: bm.title, status: 'failed', reason: fetchOutcome.reason, path: 'fetched-fallback' };
        manifest[norm] = { bookmarkId: bm.id, status: 'failed', reason: fetchOutcome.reason, at: created };
        process.stderr.write(`[A ${settled}/${within.length}] failed  ${bm.title || host}\n`);
        return;
      }
      if (fetchOutcome && fetchOutcome.status === 'skipped-binary') {
        outcomes[slot] = { url: bm.url, title: bm.title, status: 'skipped-binary', reason: fetchOutcome.reason, path: 'fetched-fallback' };
        manifest[norm] = { bookmarkId: bm.id, status: 'skipped-binary', reason: fetchOutcome.reason, at: created };
        process.stderr.write(`[A ${settled}/${within.length}] binary  ${bm.title || host}\n`);
        return;
      }
      const wc = (rendered && rendered.wordCount) || (fetched && fetched.wordCount) || 0;
      const reason = `wordCount ${wc} < ${opts.minWords}` + ((rendered && rendered.shell) || (fetched && fetched.shell) ? ' (shell)' : '');
      const path = rendered ? 'rendered' : 'fetched-fallback';
      outcomes[slot] = { url: bm.url, title: bm.title, status: 'skipped-thin', reason, path };
      manifest[norm] = { bookmarkId: bm.id, status: 'skipped-thin', reason, at: created };
      process.stderr.write(`[A ${settled}/${within.length}] thin    ${bm.title || host}\n`);
      return;
    }

    // Winner: fingerprint it (skipped when content dedup is off) and queue it.
    const title = (winner.meta && winner.meta.title) || bm.title || host || 'untitled';
    candidates.push({
      bm,
      norm,
      slot,
      title,
      markdown: winner.markdown,
      wordCount: winner.wordCount,
      metaSource: winner.meta,
      pathTaken: winner.path,
      capturedBytes: winner.path === 'rendered' ? winner.images : new Map(),
      fingerprint: opts.contentDedup ? fingerprint(title, winner.markdown) : null,
    });
  });

  // 6b. RECONCILE (serial, slot order): classify each candidate against the index.
  const decisions = reconcile(candidates, contentIndex, {
    distance: opts.dupDistance,
    existingNames,
    dedup: opts.contentDedup,
  });
  const accepted = decisions.filter((d) => d.action === 'accept');

  // Auto-skipped duplicates settle into the report + manifest (no note, no images).
  for (const d of decisions) {
    if (d.action !== 'skip') continue;
    const { candidate: c, verdict } = d;
    const reason = verdict.verdict === 'exact'
      ? 'exact content'
      : `near-duplicate (dist ${verdict.distance})`;
    outcomes[c.slot] = { url: c.bm.url, title: c.title, status: 'skipped-duplicate', reason, duplicateOf: verdict.duplicateOf };
    manifest[c.norm] = { bookmarkId: c.bm.id, status: 'skipped-duplicate', reason, duplicateOf: verdict.duplicateOf, at: created };
    process.stderr.write(`dup ${verdict.verdict.padEnd(5)} ${c.title} -> ${verdict.duplicateOf}\n`);
  }

  // 6c. Phase B: WRITE (parallel) — download images → write note → manifest entry.
  let written = 0;
  await mapPool(accepted, poolSize, async (d) => {
    const { candidate: c, filename, verdict } = d;
    let markdown = c.markdown;

    let images = { downloaded: 0, remote: 0, dropped: 0 };
    if (!opts.dryRun) {
      images = await downloadImages(markdown, {
        baseUrl: c.bm.url,
        slug: filename.replace(/\.md$/i, ''),
        attachDir,
        capturedBytes: c.capturedBytes,
        takenNames: attachTaken,
      });
      markdown = images.markdown;
    }

    const body = buildFrontmatter({
      title: c.title,
      source: c.bm.url,
      authors: splitAuthors(c.metaSource && c.metaSource.author),
      published: normalizeDate(c.metaSource && c.metaSource.published),
      description: (c.metaSource && c.metaSource.description) || '',
      created,
    }) + `\n${markdown}\n`;

    if (!opts.dryRun) await writeNoteFile(join(inboxAbs, filename), body);

    written += 1;
    const possibleDuplicateOf = verdict.verdict === 'flag' ? verdict.possibleDuplicateOf : undefined;
    outcomes[c.slot] = {
      url: c.bm.url,
      title: c.title,
      status: 'imported',
      file: filename,
      wordCount: c.wordCount,
      path: c.pathTaken,
      images: { downloaded: images.downloaded, remote: images.remote, dropped: images.dropped },
      possibleDuplicateOf,
      dryRun: opts.dryRun || undefined,
    };
    manifest[c.norm] = {
      bookmarkId: c.bm.id,
      status: 'imported',
      file: filename,
      ...(c.fingerprint
        ? { titleKey: c.fingerprint.titleKey, bodyHash: c.fingerprint.bodyHash, simhash: c.fingerprint.simhash, wordCount: c.wordCount }
        : {}),
      at: created,
    };
    process.stderr.write(`[B ${written}/${accepted.length}] ${c.pathTaken === 'rendered' ? 'render ' : 'fetch  '} ${c.title}\n`);
  });

  if (browser) { try { await browser.disconnect(); } catch { /* ignore */ } }

  // 7. Persist manifest (real runs only) and emit the report.
  if (!opts.dryRun) await writeManifest(manifestPath, manifest);

  const report = buildReport(outcomes.filter(Boolean));
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
  report.meta.dedup = {
    enabled: opts.contentDedup,
    distance: opts.dupDistance,
    skippedExact: outcomes.filter((o) => o && o.status === 'skipped-duplicate' && o.reason === 'exact content').length,
    skippedNear: outcomes.filter((o) => o && o.status === 'skipped-duplicate' && /^near-duplicate/.test(o.reason || '')).length,
    flagged: outcomes.filter((o) => o && o.status === 'imported' && o.possibleDuplicateOf).length,
  };
  report.meta.declined = declinedThisRun;
  report.meta.notes = notes;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e.stack || e}\n`);
  fail('unexpected', e.message || String(e));
});
