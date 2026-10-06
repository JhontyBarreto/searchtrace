// Index-state transitions between consecutive inspections become EXTRACTED findings (5.10).
import { describe, expect, it } from 'vitest';
import type { InspectionRecord } from '../../src/core/types.js';
import { analyzeIndexStates, canonicalAgrees, changedFields } from '../../src/analyze/index-state.js';

const URL_A = 'https://example.com/a';
const rec = (inspectedAt: string, over: Partial<InspectionRecord> = {}): InspectionRecord => ({
  url: URL_A,
  inspectedAt,
  reason: 'traffic',
  verdict: 'PASS',
  coverageState: 'Submitted and indexed',
  indexingState: 'INDEXING_ALLOWED',
  robotsTxtState: 'ALLOWED',
  googleCanonical: URL_A,
  userCanonical: URL_A,
  ...over,
});

describe('analyzeIndexStates', () => {
  it('reports a coverage change as an index_change fact', () => {
    const findings = analyzeIndexStates({
      inspections: [
        rec('2026-09-01T12:00:00Z'),
        rec('2026-09-10T12:00:00Z'),
        rec('2026-09-20T03:00:00Z', { verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed' }),
      ],
      dataThrough: '2026-10-03',
    });
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f).toMatchObject({
      kind: 'index_transition',
      metric: 'index_state',
      real: 'signal',
      reason: 'fact',
      cause: 'index_state',
      causeConfidence: 'EXTRACTED',
      template: 'index_change',
      date: '2026-09-19',
      dateWindow: ['2026-09-10', '2026-09-19'],
      unit: { level: 'page', key: URL_A, label: '/a' },
    });
    expect(f.slots).toMatchObject({ url: URL_A, before: 'Submitted and indexed', after: 'Crawled - currently not indexed', date: '2026-09-19' });
    expect(f.evidence[0]).toMatchObject({ type: 'inspection', confidence: 'EXTRACTED' });
    expect(f.id).toMatch(/^f[a-z2-7]{16}$/);
  });

  it('notices canonical disagreement and robots changes, and ignores fields missing on one side', () => {
    const before = rec('2026-09-01T00:00:00Z');
    const moved = rec('2026-09-08T00:00:00Z', { googleCanonical: 'https://example.com/b' });
    expect(canonicalAgrees(before)).toBe(true);
    expect(canonicalAgrees(moved)).toBe(false);
    expect(changedFields(before, moved)).toEqual(['canonical']);
    expect(changedFields(before, rec('2026-09-08T00:00:00Z', { robotsTxtState: 'DISALLOWED' }))).toEqual(['robotsTxtState']);
    expect(changedFields(before, rec('2026-09-08T00:00:00Z', { coverageState: undefined }))).toEqual([]);
    const [f] = analyzeIndexStates({ inspections: [before, moved], dataThrough: '2026-10-03' });
    expect(f.slots.after).toContain('https://example.com/b');
  });

  it('is empty for one inspection or no change, and deterministic', () => {
    expect(analyzeIndexStates({ inspections: [rec('2026-09-01T00:00:00Z')], dataThrough: '2026-10-03' })).toEqual([]);
    expect(analyzeIndexStates({ inspections: [rec('2026-09-01T00:00:00Z'), rec('2026-09-02T00:00:00Z')], dataThrough: '2026-10-03' })).toEqual([]);
    const input = [rec('2026-09-01T00:00:00Z'), rec('2026-09-05T00:00:00Z', { indexingState: 'BLOCKED_BY_META_TAG' })];
    expect(analyzeIndexStates({ inspections: [...input].reverse(), dataThrough: '2026-10-03' })).toEqual(analyzeIndexStates({ inspections: input, dataThrough: '2026-10-03' }));
  });
});
