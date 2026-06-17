import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvalCase } from '../../src/core/index.js';
import { buildPoolConfig } from '../../src/adapters/neon-pg/connection.js';
import { loadConfig } from '../../src/app/config.js';
import { type VectorNest, vectorNestFromConfig } from '../../src/app/lib.js';

const evalSet = JSON.parse(
  readFileSync(fileURLToPath(new URL('./eval.json', import.meta.url)), 'utf8'),
) as EvalCase[];

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

  it('re-embeds under a larger model, swaps activation, and rolls back (zero-downtime)', async () => {
    const BASE = '@cf/baai/bge-base-en-v1.5';
    const LARGE = '@cf/baai/bge-large-en-v1.5';
    const query = 'How does Neon make idle databases cost nothing?';

    const activeName = async () => (await vn.models()).find((m) => m.isActive)?.name;
    expect(await activeName()).toBe(BASE);
    const total = (await vn.models()).find((m) => m.isActive)?.total ?? 0;
    expect(total).toBeGreaterThan(0);

    // Re-embed under the large model WITHOUT activating: vectors land alongside the live model.
    const summary = await vn.reembed(LARGE, { activate: false });
    expect(summary.coverage).toBe(total);
    expect(summary.activated).toBe(false);
    // The active model is unchanged and queries still work (served by base) — no downtime.
    expect(await activeName()).toBe(BASE);
    expect((await vn.query(query, { collection, k: 1 })).length).toBe(1);

    // Swap: activate the large model. Queries now target it.
    await vn.activateModel(LARGE);
    expect(await activeName()).toBe(LARGE);
    expect((await vn.query(query, { collection, k: 3 }))[0]?.sourceUri).toContain('neon');

    // Roll back instantly — the base model's vectors were never removed.
    await vn.activateModel(BASE);
    expect(await activeName()).toBe(BASE);

    // Cleanup: drop the (now inactive) large model's embeddings.
    expect(await vn.dropModel(LARGE)).toBe(total);
  });

  it('evaluates a model against a labeled query set (recall@k / MRR)', async () => {
    const result = await vn.evaluate('@cf/baai/bge-base-en-v1.5', evalSet, {
      k: 3,
      thresholds: { minRecall: 1 },
    });
    expect(result.report.cases).toBe(3);
    expect(result.report.recallAtK).toBe(1); // each distinct doc is the top hit for its query
    expect(result.report.mrr).toBeGreaterThan(0);
    expect(result.passed).toBe(true);
  });
});
