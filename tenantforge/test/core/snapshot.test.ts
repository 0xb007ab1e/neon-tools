import { describe, expect, it } from 'vitest';
import { planSnapshotPrune, type RetainableSnapshot } from '../../src/core/snapshot.js';

const at = (ms: number, id: string): RetainableSnapshot => ({ id, createdAt: new Date(ms) });

describe('planSnapshotPrune', () => {
  it('keeps everything under an empty policy', () => {
    const snaps = [at(1, 'a'), at(2, 'b'), at(3, 'c')];
    const plan = planSnapshotPrune(snaps, {}, 100);
    expect(plan.keep).toHaveLength(3);
    expect(plan.prune).toHaveLength(0);
  });

  it('keeps the newest maxCount and prunes the rest', () => {
    const snaps = [at(10, 'a'), at(30, 'c'), at(20, 'b'), at(40, 'd')];
    const plan = planSnapshotPrune(snaps, { maxCount: 2 }, 100);
    expect(plan.keep.map((s) => s.id)).toEqual(['d', 'c']); // newest first
    expect(plan.prune.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('prunes snapshots older than maxAgeMs', () => {
    const snaps = [at(1000, 'old'), at(9500, 'fresh')];
    const plan = planSnapshotPrune(snaps, { maxAgeMs: 1000 }, 10_000);
    expect(plan.keep.map((s) => s.id)).toEqual(['fresh']); // 500ms old ≤ 1000
    expect(plan.prune.map((s) => s.id)).toEqual(['old']); // 9000ms old > 1000
  });

  it('prunes when either age OR count rule fires', () => {
    const snaps = [at(100, 'a'), at(200, 'b'), at(9000, 'c'), at(9500, 'd')];
    // keep 3 newest AND ≤ 1000ms old → only c (1000 old, within count) + d survive; a/b too old AND over count
    const plan = planSnapshotPrune(snaps, { maxCount: 3, maxAgeMs: 1000 }, 10_000);
    expect(plan.keep.map((s) => s.id).sort()).toEqual(['c', 'd']);
    expect(plan.prune.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('handles an empty list', () => {
    expect(planSnapshotPrune([], { maxCount: 5 }, 0)).toEqual({ keep: [], prune: [] });
  });

  it('breaks createdAt ties by id for a stable order', () => {
    const snaps = [at(5, 'b'), at(5, 'a'), at(5, 'c')];
    const plan = planSnapshotPrune(snaps, { maxCount: 1 }, 100);
    expect(plan.keep.map((s) => s.id)).toEqual(['a']); // tie → id asc, newest-equal kept first
  });
});
