import type { SignupTokenRecord } from '../core/index.js';

/**
 * Port: persistence for one-time tenant **signup/invite tokens**. Stores only the token **hash**
 * (the raw token is shown once at issue, never persisted — master §5). Append + single-use redeem.
 */
export interface SignupTokenStore {
  /**
   * Persist a newly-issued token record (by its hash).
   *
   * @param record - The token record (hash + scope + expiry).
   */
  create(record: SignupTokenRecord): Promise<void>;

  /**
   * Look up a token by its SHA-256 hash.
   *
   * @param tokenHash - The hash to find.
   * @returns The record, or `null` when unknown.
   */
  findByHash(tokenHash: string): Promise<SignupTokenRecord | null>;

  /**
   * Mark a token redeemed (single-use) — records the provisioned tenant + instant.
   *
   * @param tokenHash - The token's hash.
   * @param tenantId - The provisioned tenant id.
   * @param redeemedAt - When it was redeemed (ISO-8601 UTC).
   */
  markRedeemed(tokenHash: string, tenantId: string, redeemedAt: string): Promise<void>;

  /**
   * List token records, newest-first, capped at `limit`.
   *
   * @param limit - Max rows.
   * @returns The records (most-recent first).
   */
  list(limit: number): Promise<SignupTokenRecord[]>;
}
