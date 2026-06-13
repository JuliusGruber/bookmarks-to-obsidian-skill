// Interpret the gateway's GET /syncz response. Pure — the network call lives in
// bootstrap.mjs; this only maps (status, body) to a verdict the orchestrator
// and SKILL.md branch on.
//   200            -> ready       (gateway up, Chrome signed into Google sync)
//   503            -> not-synced  (gateway up, sign-in/sync not done yet)
//   0 / anything   -> down        (unreachable or unexpected)
export function interpretSyncz(status, body) {
  if (status === 200) {
    return body && body.ok === false ? 'not-synced' : 'ready';
  }
  if (status === 503) return 'not-synced';
  return 'down';
}
