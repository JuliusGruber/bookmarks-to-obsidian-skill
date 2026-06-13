import { describe, it, expect } from 'vitest';
import { buildReport } from '../scripts/src/report.mjs';

describe('buildReport', () => {
  it('aggregates per-status counts and echoes the items', () => {
    const items = [
      { url: 'https://a', status: 'imported', file: 'A.md' },
      { url: 'https://b', status: 'imported', file: 'B.md' },
      { url: 'https://c', status: 'skipped-existing' },
      { url: 'https://d', status: 'skipped-thin', reason: 'wordCount 12 < 200' },
      { url: 'https://e', status: 'skipped-binary', reason: 'application/pdf' },
      { url: 'https://f', status: 'failed', reason: 'HTTP 404' },
    ];
    const report = buildReport(items);
    expect(report.summary).toEqual({
      total: 6,
      imported: 2,
      'skipped-existing': 1,
      'skipped-thin': 1,
      'skipped-binary': 1,
      failed: 1,
    });
    expect(report.items).toHaveLength(6);
  });

  it('always reports the full set of status buckets, even at zero', () => {
    const report = buildReport([{ url: 'https://a', status: 'imported', file: 'A.md' }]);
    expect(report.summary).toEqual({
      total: 1,
      imported: 1,
      'skipped-existing': 0,
      'skipped-thin': 0,
      'skipped-binary': 0,
      failed: 0,
    });
  });

  it('handles an empty run', () => {
    const report = buildReport([]);
    expect(report.summary.total).toBe(0);
    expect(report.items).toEqual([]);
  });
});
