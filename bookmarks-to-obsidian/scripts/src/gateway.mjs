// Talk to the chrome-bookmarks-gateway and resolve folders within the tree.

const RPC_URL = 'http://localhost:3000/rpc';
const BASE_URL = 'http://localhost:3000';

/** GET /syncz — { ok, status, body }. status 200 = synced, 503 = not synced. */
export async function checkGateway(baseUrl = BASE_URL) {
  let res;
  try {
    res = await fetch(`${baseUrl}/syncz`, { method: 'GET' });
  } catch (e) {
    return { ok: false, status: 0, body: null, reason: e.message || String(e) };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, body };
}

/** Call getTree and return the array of root nodes. */
export async function getTree(rpcUrl = RPC_URL) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTree', params: [] }),
  });
  if (!res.ok) throw new Error(`gateway getTree HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`gateway getTree error: ${JSON.stringify(data.error)}`);
  return data.result;
}

const isFolder = (n) => n && Array.isArray(n.children);
const titleEq = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

// Every titled folder in the tree, paired with its slash path from the top.
function allFolders(roots) {
  const out = [];
  function walk(nodes, path) {
    for (const n of nodes) {
      if (!isFolder(n)) continue;
      const here = n.title ? [...path, n.title] : path;
      if (n.title) out.push({ node: n, path: here });
      walk(n.children, here);
    }
  }
  walk(roots, []);
  return out;
}

/**
 * Resolve a folder by name or slash-path (e.g. "Mobile Lesezeichen/AI").
 * A bare name that matches multiple folders throws an ambiguity error listing
 * the full paths; an unknown folder throws "not found".
 */
export function findFolder(roots, spec) {
  const segments = String(spec ?? '').split('/').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) throw new Error('findFolder: empty folder spec');

  if (segments.length === 1) {
    const matches = allFolders(roots).filter((f) => titleEq(f.node.title, segments[0]));
    if (matches.length === 0) throw new Error(`Folder not found: "${spec}"`);
    if (matches.length > 1) {
      const paths = matches.map((m) => m.path.join('/')).join(', ');
      throw new Error(
        `Ambiguous folder "${spec}" — matches multiple paths: ${paths}. Pass a full path to disambiguate.`,
      );
    }
    return matches[0].node;
  }

  const firstMatches = allFolders(roots).filter((f) => titleEq(f.node.title, segments[0]));
  if (firstMatches.length === 0) {
    throw new Error(`Folder not found: "${segments[0]}" (in path "${spec}")`);
  }
  if (firstMatches.length > 1) {
    const paths = firstMatches.map((m) => m.path.join('/')).join(', ');
    throw new Error(`Ambiguous path root "${segments[0]}" — matches: ${paths}.`);
  }

  let node = firstMatches[0].node;
  const pathSoFar = [...firstMatches[0].path];
  for (let i = 1; i < segments.length; i += 1) {
    const child = node.children.find((c) => isFolder(c) && titleEq(c.title, segments[i]));
    if (!child) {
      throw new Error(
        `Folder not found: "${segments[i]}" under "${pathSoFar.join('/')}" (in path "${spec}")`,
      );
    }
    node = child;
    pathSoFar.push(child.title);
  }
  return node;
}

/** Flatten every bookmark (url node) in a folder's subtree, including nested folders. */
export function collectBookmarks(folder) {
  const out = [];
  function walk(node) {
    for (const c of node.children || []) {
      if (c.url) out.push({ id: c.id, title: c.title, url: c.url });
      else if (Array.isArray(c.children)) walk(c);
    }
  }
  walk(folder);
  return out;
}
