import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from '../../src/core/ranking.js';

describe('reciprocalRankFusion', () => {
  it('ranks an id appearing high in both lists above singletons', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['b', 'd'],
    ]);
    // b is in both (ranks 2 and 1) -> highest fused score.
    expect(fused[0]?.id).toBe('b');
    expect(fused.map((f) => f.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('sums contributions across lists with the rrfK damping', () => {
    const fused = reciprocalRankFusion([['x'], ['x']], 60);
    // x at rank 1 in both: 2 * 1/(60+1)
    expect(fused[0]).toEqual({ id: 'x', score: 2 / 61 });
  });

  it('handles a single list and empty input', () => {
    expect(reciprocalRankFusion([['only']]).map((f) => f.id)).toEqual(['only']);
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  it('rejects a non-positive rrfK', () => {
    expect(() => reciprocalRankFusion([['a']], 0)).toThrow(RangeError);
    expect(() => reciprocalRankFusion([['a']], -1)).toThrow(/positive number/);
  });
});
