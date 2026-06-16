import { describe, expect, it } from 'vitest';
import { cosineDistanceToScore, rankByScore } from '../../src/core/ranking.js';

describe('cosineDistanceToScore', () => {
  it('maps distance 0 to similarity 1 and distance 1 to 0', () => {
    expect(cosineDistanceToScore(0)).toBe(1);
    expect(cosineDistanceToScore(1)).toBe(0);
    expect(cosineDistanceToScore(0.25)).toBeCloseTo(0.75, 10);
  });

  it('clamps out-of-range distances to [0, 1]', () => {
    expect(cosineDistanceToScore(2)).toBe(0); // similarity -1 -> clamp to 0
    expect(cosineDistanceToScore(-0.5)).toBe(1); // similarity 1.5 -> clamp to 1
  });
});

describe('rankByScore', () => {
  it('sorts by descending score and limits to k', () => {
    const items = [{ score: 0.1 }, { score: 0.9 }, { score: 0.5 }];
    expect(rankByScore(items, 2)).toEqual([{ score: 0.9 }, { score: 0.5 }]);
  });

  it('does not mutate the input array', () => {
    const items = [{ score: 0.1 }, { score: 0.9 }];
    rankByScore(items, 2);
    expect(items).toEqual([{ score: 0.1 }, { score: 0.9 }]);
  });

  it('returns an empty array for k = 0', () => {
    expect(rankByScore([{ score: 1 }], 0)).toEqual([]);
  });

  it('rejects negative or non-integer k', () => {
    expect(() => rankByScore([], -1)).toThrow(RangeError);
    expect(() => rankByScore([], 1.5)).toThrow(/non-negative integer/);
  });
});
