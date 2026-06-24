import type { SignupRequestRecord } from '../core/index.js';

/** Fields of a {@link SignupRequestRecord} that advance as the funnel progresses. */
export type SignupRequestPatch = Partial<
  Pick<
    SignupRequestRecord,
    | 'status'
    | 'customerRef'
    | 'setupIntentId'
    | 'slug'
    | 'region'
    | 'planId'
    | 'tenantId'
    | 'connectionRevealedAt'
    | 'updatedAt'
  >
>;

/**
 * Port: persistence for self-serve **signup requests** (the public-signup funnel). Holds no secrets —
 * only references (master §5). Created at signup start, patched as the funnel advances, and listed for
 * the operator funnel panel.
 */
export interface SignupRequestStore {
  /**
   * Persist a newly-started signup request.
   *
   * @param record - The initial record (`started`).
   */
  create(record: SignupRequestRecord): Promise<void>;

  /**
   * Look up a signup request by its (session) id.
   *
   * @param id - The signup-request id.
   * @returns The record, or `null` when unknown.
   */
  get(id: string): Promise<SignupRequestRecord | null>;

  /**
   * Apply a patch to a signup request (advance the funnel). No-op if the id is unknown.
   *
   * @param id - The signup-request id.
   * @param patch - The fields to update (callers should set `updatedAt`).
   */
  update(id: string, patch: SignupRequestPatch): Promise<void>;

  /**
   * List signup requests, newest-first, capped at `limit` (operator funnel view).
   *
   * @param limit - Max rows.
   * @returns The records (most-recent first).
   */
  list(limit: number): Promise<SignupRequestRecord[]>;
}
