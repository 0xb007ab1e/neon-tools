import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPoolConfig } from '../../src/adapters/neon-pg/connection.js';
import { loadConfig } from '../../src/app/config.js';
import { type VectorNest, vectorNestFromConfig } from '../../src/app/lib.js';

const hasCreds = Boolean(process.env.DATABASE_URL) && Boolean(process.env.EMBEDDINGS_BASE_URL);
const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));
// Unique per run so concurrent/repeat runs don't collide; cleaned up in afterAll.
const collection = `it_${process.pid}_${Date.now()}`;

describe.skipIf(!hasCreds)('VectorNest integration (live Neon + embeddings endpoint)', () => {
  let vn: VectorNest;

  beforeAll(async () => {
    vn = vectorNestFromConfig(loadConfig());
    await vn.migrate();
  });

  afterAll(async () => {
    if (vn) await vn.close();
    if (hasCreds) {
      const pool = new pg.Pool(buildPoolConfig(process.env.DATABASE_URL ?? ''));
      try {
        await pool.query('DELETE FROM vn_collections WHERE name = $1', [collection]);
      } finally {
        await pool.end();
      }
    }
  });

  it('ingests a folder and answers a semantic query', async () => {
    const summary = await vn.ingest(fixturesDir, { collection });
    expect(summary.documents).toBe(3);
    expect(summary.chunks).toBeGreaterThanOrEqual(3);
    expect(summary.skipped).toBe(0);

    const hits = await vn.query('How does Neon make idle databases cost nothing?', {
      collection,
      k: 3,
    });
    expect(hits.length).toBeGreaterThan(0);
    // The Neon doc should be the closest match, ahead of the unrelated pasta doc.
    expect(hits[0]?.sourceUri).toContain('neon');
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it('is idempotent on re-ingest (skips unchanged documents)', async () => {
    const summary = await vn.ingest(fixturesDir, { collection });
    expect(summary.skipped).toBe(3);
    expect(summary.documents).toBe(0);
  });
});
