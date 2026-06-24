import type { EmailVerificationRecord } from '../core/index.js';

/**
 * Port: persistence for one-time **email-verification codes**. Stores only the code **hash** (the raw
 * code is emailed once, never persisted — master §5). One active record per email: issuing a fresh
 * code supersedes any prior one (resetting attempts). Single-use verify with a bounded attempt count.
 */
export interface EmailVerificationStore {
  /**
   * Create or replace the active verification record for an email (re-issuing supersedes + resets).
   *
   * @param record - The record (email + code hash + expiry; `attempts` should start at 0).
   */
  put(record: EmailVerificationRecord): Promise<void>;

  /**
   * Look up the active record for an email.
   *
   * @param email - The email to find.
   * @returns The record, or `null` when none is active.
   */
  get(email: string): Promise<EmailVerificationRecord | null>;

  /**
   * Atomically increment the failed-attempt counter (anti-brute-force) and return the new count.
   *
   * @param email - The email whose record to increment.
   * @returns The updated attempt count (0 if no active record).
   */
  recordFailedAttempt(email: string): Promise<number>;

  /**
   * Mark the email's code verified (single-use).
   *
   * @param email - The verified email.
   * @param verifiedAt - When it was verified (ISO-8601 UTC).
   */
  markVerified(email: string, verifiedAt: string): Promise<void>;
}
