/** A pending one-time step-up code for a tenant + action (only its **hash** is stored). */
export interface OneTimeCodeRecord {
  /** The tenant the code authorizes (server-derived; never client-supplied). */
  tenantId: string;
  /**
   * The action the code is bound to (e.g. `cancel`, `erasure`). A code minted for one action MUST
   * NOT verify another — binding the factor to the action prevents a cancel code authorizing erasure.
   */
  action: string;
  /** SHA-256 hex of the code — never the code itself (it is single-use and short-lived). */
  codeHash: string;
  /** Epoch-ms expiry; a code at/after this instant is invalid (fail closed). */
  expiresAtMs: number;
  /** Verification attempts so far (lock out brute force). */
  attempts: number;
}

/** The outcome of verifying a presented step-up code. */
export type OneTimeCodeVerification =
  | { outcome: 'ok' } // matched, unexpired, consumed (single-use)
  | { outcome: 'not_found' } // no pending code for this tenant+action
  | { outcome: 'expired' } // a code existed but is past its TTL
  | { outcome: 'locked' } // too many failed attempts
  | { outcome: 'mismatch' }; // wrong code (attempt counted)

/**
 * Port: a store for **control-plane second-factor** (step-up) one-time codes, used to gate the two
 * destructive self-serve portal actions (cancel, erasure). The code is delivered out-of-band (email /
 * TOTP) and verified server-side — it is deliberately **independent of the OIDC token** (a standard
 * IdP can mint a "fresh" token via silent refresh with no human present — threat-model B8w / red-team
 * F1). Codes are single-use, short-TTL, and bound to a `(tenantId, action)` pair; only the **hash**
 * is persisted (master §5). The default adapter is in-memory (per-instance); a Postgres-backed
 * adapter would share it across replicas.
 */
export interface OneTimeCodeStore {
  /**
   * Mint (and persist the hash of) a one-time code for `tenantId`+`action`, replacing any pending
   * code for the same pair (a re-request invalidates the prior code). Atomic per pair.
   *
   * @param record - The tenant, action, code hash, expiry, and initial attempt count (0).
   */
  put(record: OneTimeCodeRecord): Promise<void>;

  /**
   * Atomically verify a presented `codeHash` for `tenantId`+`action` and, on a match, **consume** it
   * (single-use). A mismatch increments the attempt counter; exceeding `maxAttempts` locks the code.
   *
   * @param tenantId - The tenant (server-derived from the session).
   * @param action - The action the code must be bound to.
   * @param codeHash - SHA-256 hex of the presented code.
   * @param maxAttempts - Lockout threshold (failed attempts).
   * @param nowMs - Current epoch ms (injected for determinism).
   * @returns The verification outcome.
   */
  verify(
    tenantId: string,
    action: string,
    codeHash: string,
    maxAttempts: number,
    nowMs: number,
  ): Promise<OneTimeCodeVerification>;
}
