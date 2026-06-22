/**
 * A persisted signup/invite token record (the **hash** of the token, plus its scope + state). The
 * raw token is never stored — only `tokenHash`. This models the "signup" lifecycle stage Neon
 * leaves to the builder (provisioning a tenant for a new principal).
 */
export interface SignupTokenRecord {
  /** SHA-256 (hex) of the raw token; the lookup key. */
  tokenHash: string;
  /** Desired tenant slug to provision on redemption. */
  slug: string;
  /** Optional region override for the provisioned tenant. */
  region?: string;
  /** Optional plan id to record on the provisioned tenant. */
  planId?: string;
  /** Expiry instant (ISO-8601 UTC). */
  expiresAt: string;
  /** When the token was redeemed (ISO-8601 UTC); absent ⇒ still pending. */
  redeemedAt?: string;
  /** The tenant provisioned on redemption. */
  redeemedTenantId?: string;
  /** When the token was issued (ISO-8601 UTC). */
  createdAt: string;
}

/** The lifecycle state of a signup token. */
export type SignupTokenStatus = 'pending' | 'redeemed' | 'expired';

/**
 * Derive a token's status at instant `now`: `redeemed` (already consumed) wins, then `expired`
 * (past `expiresAt`), else `pending`. Pure and deterministic.
 *
 * @param record - The token record.
 * @param now - The instant to evaluate against (ISO-8601 UTC).
 * @returns The status.
 */
export function signupTokenStatus(record: SignupTokenRecord, now: string): SignupTokenStatus {
  if (record.redeemedAt !== undefined) return 'redeemed';
  if (now >= record.expiresAt) return 'expired';
  return 'pending';
}

/**
 * Assert a signup token may be redeemed at `now` — it must be `pending` (single-use, unexpired).
 * Fails closed: already-redeemed or expired tokens throw rather than provisioning twice.
 *
 * @param record - The token record.
 * @param now - The instant to evaluate against (ISO-8601 UTC).
 * @throws Error if the token is already redeemed or expired.
 */
export function assertRedeemable(record: SignupTokenRecord, now: string): void {
  const status = signupTokenStatus(record, now);
  if (status === 'redeemed') throw new Error('signup token already redeemed');
  if (status === 'expired') throw new Error('signup token expired');
}
