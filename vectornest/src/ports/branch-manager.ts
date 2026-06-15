/**
 * Port: manages ephemeral Neon branches for re-embed rehearsal.
 *
 * Defined in v1 but exercised by the Month-1 re-embed flow: a branch is a cheap copy-on-write
 * sandbox to re-embed + evaluate a new model without touching production. Neon branches do not
 * merge data back, so the branch is a rehearsal/eval sandbox only — the production swap relies on
 * the model-versioned embeddings table, not a branch merge (ARCHITECTURE §5).
 */
export interface BranchManager {
  /**
   * Create a branch and return how to connect to it.
   *
   * @param name - A human-readable branch name.
   * @returns The new branch id and a connection URI for it.
   */
  createBranch(name: string): Promise<{ branchId: string; connectionUri: string }>;

  /**
   * Delete a branch.
   *
   * @param branchId - The branch to delete.
   */
  deleteBranch(branchId: string): Promise<void>;
}
