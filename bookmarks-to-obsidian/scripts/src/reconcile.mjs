// Serial, slot-ordered duplicate reconciliation. Pure: no IO. The dup decision
// is a function of (fingerprint, slot order), independent of render timing — so
// the earliest bookmark always wins as the canonical note.
import { sanitizeFilename, uniqueFilename } from './note.mjs';

/**
 * reconcile(candidates, contentIndex, opts) → decisions[], one per candidate.
 *
 *   candidate: { slot, title, fingerprint, bm, norm, ... } (passed through).
 *   opts.distance     — SimHash near threshold (default 6).
 *   opts.existingNames — Set of taken inbox filenames; mutated as names are assigned.
 *   opts.dedup        — false disables classification (everything accepted).
 *
 * Mutates contentIndex (grows it with each accepted note) and existingNames.
 *
 *   decision (skip):   { candidate, action: 'skip', verdict }
 *   decision (accept): { candidate, action: 'accept', verdict, filename }
 */
export function reconcile(candidates, contentIndex, { distance = 6, existingNames, dedup = true } = {}) {
  const ordered = [...candidates].sort((a, b) => a.slot - b.slot);
  const decisions = [];
  for (const candidate of ordered) {
    let verdict = { verdict: 'unique' };
    if (dedup && candidate.fingerprint) {
      verdict = contentIndex.classify(candidate.fingerprint, { distance });
    }
    if (verdict.verdict === 'exact' || verdict.verdict === 'near') {
      decisions.push({ candidate, action: 'skip', verdict });
      continue;
    }
    // Accepted (unique or flag): assign a collision-free name, grow the index.
    const base = sanitizeFilename(candidate.title);
    const filename = uniqueFilename(base, '.md', (n) => existingNames.has(n));
    existingNames.add(filename);
    if (dedup && candidate.fingerprint) {
      contentIndex.add({
        file: filename,
        titleKey: candidate.fingerprint.titleKey,
        bodyHash: candidate.fingerprint.bodyHash,
        simhash: candidate.fingerprint.simhash,
      });
    }
    decisions.push({ candidate, action: 'accept', verdict, filename });
  }
  return decisions;
}
