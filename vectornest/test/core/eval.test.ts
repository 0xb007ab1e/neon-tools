import { describe, expect, it } from 'vitest';
import { aggregate, meetsThresholds, scoreRanking } from '../../src/core/eval.js';

describe('scoreRanking', () => {
  it('matches the first relevant result by substring and returns its reciprocal rank', () => {
    expect(scoreRanking(['/a/pasta.md', '/a/neon.md'], ['neon.md'])).toEqual({
      matched: true,
      reciprocalRank: 1 / 2,
    });
    expect(scoreRanking(['/a/neon.md'], ['neon'])).toEqual({ matched: true, reciprocalRank: 1 });
  });

  it('returns no match when nothing relevant is ranked', () => {
    expect(scoreRanking(['/a/pasta.md'], ['neon.md'])).toEqual({
      matched: false,
      reciprocalRank: 0,
    });
    expect(scoreRanking([], ['neon.md'])).toEqual({ matched: false, reciprocalRank: 0 });
  });
});

describe('aggregate', () => {
  it('computes recall@k and MRR', () => {
    const report = aggregate(
      [
        { matched: true, reciprocalRank: 1 },
        { matched: true, reciprocalRank: 0.5 },
        { matched: false, reciprocalRank: 0 },
      ],
      5,
    );
    expect(report.cases).toBe(3);
    expect(report.recallAtK).toBeCloseTo(2 / 3, 10);
    expect(report.mrr).toBeCloseTo(0.5, 10);
    expect(report.k).toBe(5);
  });

  it('returns zeros for an empty set', () => {
    expect(aggregate([], 3)).toEqual({ cases: 0, recallAtK: 0, mrr: 0, k: 3 });
  });
});

describe('meetsThresholds', () => {
  const report = { cases: 10, recallAtK: 0.8, mrr: 0.6, k: 5 };

  it('passes when no thresholds are set', () => {
    expect(meetsThresholds(report, {})).toBe(true);
  });

  it('enforces minRecall and minMrr independently', () => {
    expect(meetsThresholds(report, { minRecall: 0.8 })).toBe(true);
    expect(meetsThresholds(report, { minRecall: 0.81 })).toBe(false);
    expect(meetsThresholds(report, { minMrr: 0.6 })).toBe(true);
    expect(meetsThresholds(report, { minMrr: 0.7 })).toBe(false);
  });
});
