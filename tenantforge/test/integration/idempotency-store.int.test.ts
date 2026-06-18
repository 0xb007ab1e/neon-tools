import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgTenantRegistry } from '../../src/adapters/neon-pg/registry.js';
import { createPgIdempotencyStore } from '../../src/adapters/neon-pg/idempotency-store.js';

// Non-hermetic: needs a live control-plane Postgres (no Neon API). Self-skips without DATABASE_URL.
const databaseUrl = process.env.DATABASE_URL;
const ready = Boolean(databaseUrl);

const response = { status: 201, body: '{"ok":true}', contentType: 'application/json' };

describe.skipIf(!ready)('pg idempotency store (live Postgres)', () => {
  const registry = createPgTenantRegistry({ connectionString: databaseUrl! });
  const store = createPgIdempotencyStore({ connectionString: databaseUrl! });
  const cleanup = new Pool({ connectionString: databaseUrl! });
  const tag = Date.now().toString(36);

  beforeAll(async () => {
    await registry.migrate(); // ensures tf_idempotency_keys (migration 0005)
    await cleanup.query('DELETE FROM tf_idempotency_keys WHERE key LIKE $1', ['idem-%']);
  });

  afterAll(async () => {
    await cleanup.query('DELETE FROM tf_idempotency_keys WHERE key LIKE $1', ['idem-%']);
    await cleanup.end();
    await store.close();
    await registry.close();
  });

  it('reserves, reports in-flight, then replays the stored response', async () => {
    const key = `idem-${tag}-1`;
    expect(await store.begin(key, 'fp', 1000)).toEqual({ outcome: 'new' });
    expect(await store.begin(key, 'fp', 1001)).toEqual({ outcome: 'in_flight' });
    await store.complete(key, response, 1002);
    expect(await store.begin(key, 'fp', 1003)).toEqual({ outcome: 'replay', response });
  });

  it('flags a fingerprint mismatch and de-duplicates across instances', async () => {
    const key = `idem-${tag}-2`;
    const a = createPgIdempotencyStore({ connectionString: databaseUrl! });
    const b = createPgIdempotencyStore({ connectionString: databaseUrl! });
    try {
      expect((await a.begin(key, 'fp-a', 0)).outcome).toBe('new');
      // A separate instance sees the in-flight reservation via the shared DB.
      expect((await b.begin(key, 'fp-a', 1)).outcome).toBe('in_flight');
      // Reuse with a different request body is rejected.
      expect((await b.begin(key, 'fp-b', 2)).outcome).toBe('mismatch');
    } finally {
      await a.close();
      await b.close();
    }
  });
});
