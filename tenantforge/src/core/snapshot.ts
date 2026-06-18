/** A point-in-time snapshot of a tenant's database (a Neon branch), for retention planning. */
export interface RetainableSnapshot {
  /** The snapshot's id (the Neon branch id). */
  id: string;
  /** When the snapshot was taken. */
  createdAt: Date;
}

/** A snapshot retention policy. An empty policy keeps everything. */
export interface RetentionPolicy {
  /** Keep at most this many of the newest snapshots (older ones are pruned). */
  maxCount?: number;
  /** Prune snapshots older than this age in ms. */
  maxAgeMs?: number;
}

/** The result of planning a prune: which snapshots to keep vs. delete. */
export interface SnapshotPrunePlan<T extends RetainableSnapshot> {
  /** Snapshots retained under the policy. */
  keep: T[];
  /** Snapshots to delete (older than `maxAgeMs` or beyond the `maxCount` newest). */
  prune: T[];
}

/**
 * Decide which snapshots to prune under a retention policy. Pure and deterministic: a snapshot is
 * pruned if it is older than `maxAgeMs` (when set) **or** falls outside the `maxCount` newest (when
 * set); newest are kept. An empty policy keeps everything. Ties broken by id for a stable order.
 *
 * @param snapshots - The candidate snapshots (any order).
 * @param policy - The retention policy.
 * @param nowMs - Current time in epoch ms (injected for determinism/testing).
 * @returns The keep/prune partition.
 */
export function planSnapshotPrune<T extends RetainableSnapshot>(
  snapshots: readonly T[],
  policy: RetentionPolicy,
  nowMs: number,
): SnapshotPrunePlan<T> {
  // Newest first; id as a stable tiebreaker for equal timestamps.
  const ordered = [...snapshots].sort((a, b) => {
    const diff = b.createdAt.getTime() - a.createdAt.getTime();
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
  const keep: T[] = [];
  const prune: T[] = [];
  ordered.forEach((snapshot, index) => {
    const tooOld =
      policy.maxAgeMs !== undefined && nowMs - snapshot.createdAt.getTime() > policy.maxAgeMs;
    const overCount = policy.maxCount !== undefined && index >= policy.maxCount;
    if (tooOld || overCount) prune.push(snapshot);
    else keep.push(snapshot);
  });
  return { keep, prune };
}
