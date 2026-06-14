import { describe, it, expect } from 'vitest';
import { reconcile } from '../bookmarks-to-obsidian/scripts/src/reconcile.mjs';
import { createContentIndex } from '../bookmarks-to-obsidian/scripts/src/content-index.mjs';
import { fingerprint } from '../bookmarks-to-obsidian/scripts/src/fingerprint.mjs';

const ARTICLE = `
Loop engineering is the practice of designing feedback loops that keep an agent on task.
A good loop has three parts: a goal, an observation step, and a correction step.
When the agent drifts away from the plan, the correction step nudges it back toward the goal.
The art is choosing how tight the loop should be. Too tight and the agent thrashes on noise.
Too loose and it wanders off for many steps before anyone notices the problem.
Most production systems settle somewhere in the middle, trimming the loop over time
as they learn which signals actually predict drift and which are just random noise.
`;
const ARTICLE_REPOST = `Subscribe to my newsletter for a weekly post like this one.\n${ARTICLE}`;
const DIFFERENT = `
Yesterday I went hiking in the mountains and saw three deer near the rocky ridge.
The weather was cold but clear, and the narrow trail was covered in fresh white snow.
We packed sandwiches and a thermos of coffee and stopped at the summit for a long lunch.
`;

function cand(slot, title, markdown) {
  return { slot, title, bm: { id: `b${slot}`, url: `https://x/${slot}` }, norm: `n${slot}`, fingerprint: fingerprint(title, markdown) };
}

describe('reconcile', () => {
  it('keeps the lowest-slot note and skips the rest of a real duplicate cluster', () => {
    const idx = createContentIndex();
    const existingNames = new Set();
    // Permalink twin (exact body) + cross-domain repost (near), all same title.
    const cands = [
      cand(0, 'Loop Engineering', ARTICLE),
      cand(1, 'Loop Engineering', ARTICLE),         // permalink twin → exact
      cand(2, 'Loop Engineering', ARTICLE_REPOST),  // repost → near
    ];
    const decisions = reconcile(cands, idx, { distance: 6, existingNames, dedup: true });

    expect(decisions[0]).toMatchObject({ action: 'accept', filename: 'Loop Engineering.md' });
    expect(decisions[1]).toMatchObject({ action: 'skip' });
    expect(decisions[1].verdict).toMatchObject({ verdict: 'exact', duplicateOf: 'Loop Engineering.md' });
    expect(decisions[2]).toMatchObject({ action: 'skip' });
    expect(decisions[2].verdict).toMatchObject({ verdict: 'near', duplicateOf: 'Loop Engineering.md' });
  });

  it('is slot-ordered regardless of input order (lowest slot is canonical)', () => {
    const idx = createContentIndex();
    const existingNames = new Set();
    const cands = [cand(2, 'Loop Engineering', ARTICLE), cand(0, 'Loop Engineering', ARTICLE)];
    const decisions = reconcile(cands, idx, { distance: 6, existingNames, dedup: true });
    const bySlot = Object.fromEntries(decisions.map((d) => [d.candidate.slot, d]));
    expect(bySlot[0].action).toBe('accept');
    expect(bySlot[2].action).toBe('skip');
  });

  it('imports a distinct same-titled article and flags it', () => {
    const idx = createContentIndex();
    const existingNames = new Set();
    const cands = [
      cand(0, 'Year in Review 2025', ARTICLE),
      cand(1, 'Year in Review 2025', DIFFERENT),
    ];
    const decisions = reconcile(cands, idx, { distance: 6, existingNames, dedup: true });
    expect(decisions[0]).toMatchObject({ action: 'accept', filename: 'Year in Review 2025.md' });
    expect(decisions[1]).toMatchObject({ action: 'accept', filename: 'Year in Review 2025 (2).md' });
    expect(decisions[1].verdict).toMatchObject({ verdict: 'flag', possibleDuplicateOf: ['Year in Review 2025.md'] });
  });

  it('accepts everything when dedup is disabled', () => {
    const idx = createContentIndex();
    const existingNames = new Set();
    const cands = [cand(0, 'Loop Engineering', ARTICLE), cand(1, 'Loop Engineering', ARTICLE)];
    const decisions = reconcile(cands, idx, { distance: 6, existingNames, dedup: false });
    expect(decisions.map((d) => d.action)).toEqual(['accept', 'accept']);
    expect(decisions.map((d) => d.filename)).toEqual(['Loop Engineering.md', 'Loop Engineering (2).md']);
  });

  it('respects already-taken filenames from the inbox', () => {
    const idx = createContentIndex();
    const existingNames = new Set(['Loop Engineering.md']);
    const decisions = reconcile([cand(0, 'Loop Engineering', DIFFERENT)], idx, { distance: 6, existingNames, dedup: true });
    expect(decisions[0]).toMatchObject({ action: 'accept', filename: 'Loop Engineering (2).md' });
  });
});
