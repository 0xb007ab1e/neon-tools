import type { EmailVerificationRecord } from '../core/index.js';
import type { EmailVerificationStore } from '../ports/email-verification-store.js';

/** An in-memory {@link EmailVerificationStore} (default / tests), plus a `clear` test helper. */
export interface InMemoryEmailVerificationStore extends EmailVerificationStore {
  /** Drop all stored records (test helper). */
  clear(): void;
}

/**
 * Create an in-memory {@link EmailVerificationStore} — process-local, for dev / single-instance /
 * tests. Use {@link import('./neon-pg/email-verification-store.js').createPgEmailVerificationStore}
 * for durable, cross-instance storage. Keyed by email (one active record each); re-issuing supersedes.
 *
 * @returns The in-memory store.
 */
export function createInMemoryEmailVerificationStore(): InMemoryEmailVerificationStore {
  const byEmail = new Map<string, EmailVerificationRecord>();
  return {
    put(record: EmailVerificationRecord): Promise<void> {
      byEmail.set(record.email, { ...record });
      return Promise.resolve();
    },
    get(email: string): Promise<EmailVerificationRecord | null> {
      const r = byEmail.get(email);
      return Promise.resolve(r ? { ...r } : null);
    },
    recordFailedAttempt(email: string): Promise<number> {
      const r = byEmail.get(email);
      if (r === undefined) return Promise.resolve(0);
      const attempts = r.attempts + 1;
      byEmail.set(email, { ...r, attempts });
      return Promise.resolve(attempts);
    },
    markVerified(email: string, verifiedAt: string): Promise<void> {
      const r = byEmail.get(email);
      if (r) byEmail.set(email, { ...r, verifiedAt });
      return Promise.resolve();
    },
    clear(): void {
      byEmail.clear();
    },
  };
}
