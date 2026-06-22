import type { SignupTokenRecord } from '../core/index.js';
import type { SignupTokenStore } from '../ports/signup-token-store.js';

/** An in-memory {@link SignupTokenStore} (default / tests), plus a `clear` test helper. */
export interface InMemorySignupTokenStore extends SignupTokenStore {
  /** Drop all stored tokens (test helper). */
  clear(): void;
}

/**
 * Create an in-memory {@link SignupTokenStore} — process-local, for dev / single-instance / tests.
 * Use {@link import('./neon-pg/signup-token-store.js').createPgSignupTokenStore} for durable storage.
 *
 * @returns The in-memory store.
 */
export function createInMemorySignupTokenStore(): InMemorySignupTokenStore {
  const byHash = new Map<string, SignupTokenRecord>();
  return {
    create(record: SignupTokenRecord): Promise<void> {
      byHash.set(record.tokenHash, { ...record });
      return Promise.resolve();
    },
    findByHash(tokenHash: string): Promise<SignupTokenRecord | null> {
      const r = byHash.get(tokenHash);
      return Promise.resolve(r ? { ...r } : null);
    },
    markRedeemed(tokenHash: string, tenantId: string, redeemedAt: string): Promise<void> {
      const r = byHash.get(tokenHash);
      if (r) byHash.set(tokenHash, { ...r, redeemedAt, redeemedTenantId: tenantId });
      return Promise.resolve();
    },
    list(limit: number): Promise<SignupTokenRecord[]> {
      const rows = [...byHash.values()]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, limit)
        .map((r) => ({ ...r }));
      return Promise.resolve(rows);
    },
    clear(): void {
      byHash.clear();
    },
  };
}
