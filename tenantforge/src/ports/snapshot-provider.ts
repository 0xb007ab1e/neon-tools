/** A point-in-time snapshot of a tenant's database (realized as a Neon branch). */
export interface ProjectSnapshot {
  /** The snapshot id (the Neon branch id). */
  id: string;
  /** The snapshot name (our `snapshot-<ms>` convention). */
  name: string;
  /** When the snapshot was taken. */
  createdAt: Date;
}

/**
 * Port: create / list / delete / restore point-in-time snapshots of a tenant's database. The Neon
 * adapter realizes a snapshot as a **branch** (copy-on-write — instant, cheap), the Neon-native
 * mechanism for restore points. Snapshots live inside the project, so they protect against bad
 * migrations / corruption, not project deletion; for off-Neon durability use the archive exporter.
 */
export interface SnapshotProvider {
  /**
   * Take a snapshot of the project's current state (create a branch from its default head).
   *
   * @param neonProjectId - The tenant's Neon project id.
   * @param name - The snapshot name (caller supplies the `snapshot-<ms>` convention).
   * @returns The created snapshot.
   */
  createSnapshot(neonProjectId: string, name: string): Promise<ProjectSnapshot>;

  /**
   * List the snapshots of a project (the branches matching the `snapshot-` naming convention; the
   * project's default branch is excluded).
   *
   * @param neonProjectId - The tenant's Neon project id.
   * @returns The project's snapshots.
   */
  listSnapshots(neonProjectId: string): Promise<ProjectSnapshot[]>;

  /**
   * Delete a snapshot (drop the branch) — used by the retention sweep.
   *
   * @param neonProjectId - The tenant's Neon project id.
   * @param snapshotId - The snapshot (branch) id to delete.
   */
  deleteSnapshot(neonProjectId: string, snapshotId: string): Promise<void>;

  /**
   * Restore the project's default branch to a snapshot's state (destructive recovery — overwrites
   * live data with the snapshot). Operator/runbook-invoked.
   *
   * @param neonProjectId - The tenant's Neon project id.
   * @param snapshotId - The snapshot (branch) id to restore from.
   */
  restoreSnapshot(neonProjectId: string, snapshotId: string): Promise<void>;
}
