import type { SignupRequestRecord } from '../core/index.js';
import type { SignupRequestPatch, SignupRequestStore } from '../ports/signup-request-store.js';

/** An in-memory {@link SignupRequestStore} (default / tests), plus a `clear` test helper. */
export interface InMemorySignupRequestStore extends SignupRequestStore {
  /** Drop all stored requests (test helper). */
  clear(): void;
}

/**
 * Create an in-memory {@link SignupRequestStore} — process-local, for dev / single-instance / tests.
 * Use {@link import('./neon-pg/signup-request-store.js').createPgSignupRequestStore} for durable,
 * cross-instance storage.
 *
 * @returns The in-memory store.
 */
export function createInMemorySignupRequestStore(): InMemorySignupRequestStore {
  const byId = new Map<string, SignupRequestRecord>();
  return {
    create(record: SignupRequestRecord): Promise<void> {
      byId.set(record.id, { ...record });
      return Promise.resolve();
    },
    get(id: string): Promise<SignupRequestRecord | null> {
      const r = byId.get(id);
      return Promise.resolve(r ? { ...r } : null);
    },
    update(id: string, patch: SignupRequestPatch): Promise<void> {
      const r = byId.get(id);
      if (r) byId.set(id, { ...r, ...patch });
      return Promise.resolve();
    },
    list(limit: number): Promise<SignupRequestRecord[]> {
      const rows = [...byId.values()]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, limit)
        .map((r) => ({ ...r }));
      return Promise.resolve(rows);
    },
    clear(): void {
      byId.clear();
    },
  };
}
