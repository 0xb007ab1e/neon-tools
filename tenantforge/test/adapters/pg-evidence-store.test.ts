import { describe, expect, it } from 'vitest';
import { createPgEvidenceStore } from '../../src/adapters/neon-pg/evidence-store.js';

// Hermetic unit tests for the Postgres evidence-store adapter (ADR-0011 Phase 3b) that need NO live
// DB: they assert the fail-closed transport-security guard at construction time. The full behavioral
// contract (durable put/get/list/pruneExpired, tenant-scope isolation, restart survival) is proven by
// the integration suite against an ephemeral Neon branch — `test/integration/evidence-store.int.test.ts`
// — because it requires real SQL execution. (This adapter file is the imperative shell, excluded from
// the unit coverage denominator like the other neon-pg adapters.)
describe('createPgEvidenceStore (construction guards)', () => {
  it('fails closed on a non-TLS connection string (no sslmode)', () => {
    expect(() => createPgEvidenceStore({ connectionString: 'postgres://u:p@host/db' })).toThrow(
      /must enforce TLS/,
    );
  });

  it('fails closed when sslmode disables TLS', () => {
    expect(() =>
      createPgEvidenceStore({ connectionString: 'postgres://u:p@host/db?sslmode=disable' }),
    ).toThrow(/must enforce TLS/);
  });

  it('accepts a TLS-enforcing connection string (sslmode=require)', () => {
    // No query runs at construction time, so this does not open a real connection.
    const store = createPgEvidenceStore({
      connectionString: 'postgres://u:p@host/db?sslmode=require',
    });
    expect(typeof store.get).toBe('function');
    expect(typeof store.list).toBe('function');
    expect(typeof store.pruneExpired).toBe('function');
    expect(typeof store.close).toBe('function');
  });

  it('permits a non-TLS connection only with the explicit allowInsecure opt-out (local dev)', () => {
    expect(() =>
      createPgEvidenceStore({ connectionString: 'postgres://u:p@host/db', allowInsecure: true }),
    ).not.toThrow();
  });
});
