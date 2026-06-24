/**
 * A persisted email-verification record (the **hash** of the one-time code, plus its state). The raw
 * code is never stored — only `codeHash` — and is delivered out-of-band to the address being proven
 * (master §5). This gates the public self-serve signup so an attacker cannot proceed with an address
 * they do not control.
 */
export interface EmailVerificationRecord {
  /** The email being verified (PII — never logged; the lookup key). */
  email: string;
  /** SHA-256 (hex) of the one-time code. The raw code is emailed once, never persisted. */
  codeHash: string;
  /** Expiry instant (ISO-8601 UTC) — short-lived (e.g. 15 minutes). */
  expiresAt: string;
  /** Failed-attempt counter; at/above {@link MAX_ATTEMPTS} the record is `locked` (anti-brute-force). */
  attempts: number;
  /** When the code was successfully verified (ISO-8601 UTC); absent ⇒ not yet verified. */
  verifiedAt?: string;
  /** When the code was issued (ISO-8601 UTC). */
  createdAt: string;
}

/** The lifecycle state of an email-verification code. */
export type EmailVerificationStatus = 'pending' | 'verified' | 'expired' | 'locked';

/** Max failed code entries before the record locks (anti-brute-force); a new code resets it. */
export const MAX_ATTEMPTS = 5;

/**
 * Derive a code's status at instant `now`. Precedence (fail-safe): `verified` (already proven) wins,
 * then `locked` (too many failed attempts), then `expired` (past `expiresAt`), else `pending`. Pure
 * and deterministic.
 *
 * @param record - The verification record.
 * @param now - The instant to evaluate against (ISO-8601 UTC).
 * @returns The status.
 */
export function emailVerificationStatus(
  record: EmailVerificationRecord,
  now: string,
): EmailVerificationStatus {
  if (record.verifiedAt !== undefined) return 'verified';
  if (record.attempts >= MAX_ATTEMPTS) return 'locked';
  if (now >= record.expiresAt) return 'expired';
  return 'pending';
}

/**
 * Assert a code may still be checked at `now` — it must be `pending` (unverified, unexpired, not
 * locked). Fails closed: a verified, expired, or locked record throws rather than allowing another
 * guess or a double-verify.
 *
 * @param record - The verification record.
 * @param now - The instant to evaluate against (ISO-8601 UTC).
 * @throws Error if the code is already verified, expired, or locked.
 */
export function assertVerifiable(record: EmailVerificationRecord, now: string): void {
  const status = emailVerificationStatus(record, now);
  if (status === 'verified') throw new Error('email already verified');
  if (status === 'expired') throw new Error('verification code expired');
  if (status === 'locked') throw new Error('too many attempts; request a new code');
}
