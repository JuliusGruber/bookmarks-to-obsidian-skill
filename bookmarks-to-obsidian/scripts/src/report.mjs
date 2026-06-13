// Aggregate per-item results into a structured JSON report.

export const STATUSES = [
  'imported',
  'skipped-existing',
  'skipped-thin',
  'skipped-binary',
  'failed',
];

/**
 * Summarize import items into { summary, items }. The summary always carries
 * every status bucket (zero when unused) plus a total, so downstream parsing
 * never has to guard for missing keys.
 */
export function buildReport(items) {
  const summary = { total: items.length };
  for (const s of STATUSES) summary[s] = 0;
  for (const it of items) {
    summary[it.status] = (summary[it.status] || 0) + 1;
  }
  return { summary, items };
}
