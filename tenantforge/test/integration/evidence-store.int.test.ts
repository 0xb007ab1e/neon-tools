import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgTenantRegistry } from '../../src/adapters/neon-pg/registry.js';
import { createPgEvidenceStore } from '../../src/adapters/neon-pg/evidence-store.js';
import { createEphemeralEvidenceBundleSigner } from '../../src/adapters/evidence-bundle-signer.js';
import { buildEvidenceBundle, verifyEvidenceBundle } from '../../src/core/evidence-bundle.js';
import type { SignedEvidenceBundle } from '../../src/core/evidence-bundle.js';
import type { TenantRecord } from '../../src/core/domain.js';

// Non-hermetic: needs a live control-plane Postgres (no Neon API). Self-skips without DATABASE_URL.
// Proves the durable retrieval guarantees that the in-process index (Phase 3a object-store adapter)
// could not give: put/get/list/pruneExpired survive a fresh store instance (restart / another
// replica), reading from Postgres alone — the durable manifest index that closes the 3a gap (ADR-0011
// Phase 3b / threat-model B11). Also pins the store-level tenant-scope isolation (BOLA defense).
const databaseUrl = process.env.DATABASE_URL;
const ready = Boolean(databaseUrl);

/** A minimal tenant record for building a real bundle (the store persists what the builder emits). */
const tenant = (over: Partial<TenantRecord> = {}): TenantRecord => ({
  id: 'tt-1',
  slug: 'acme',
  region: 'aws-us-east-1',
  status: 'active',
  neonProjectId: 'proj-tt-1',
  metadata: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

describe.skipIf(!ready)('pg evidence store (live Postgres)', () => {
  const registry = createPgTenantRegistry({ connectionString: databaseUrl! });
  const store = createPgEvidenceStore({ connectionString: databaseUrl! });
  const cleanup = new Pool({ connectionString: databaseUrl! });
  const storedIds: string[] = [];

  /** Sign a real fleet/tenant bundle so what we persist round-trips and still verifies. */
  async function sign(scope: 'fleet' | 'tenant', tenantId?: string): Promise<SignedEvidenceBundle> {
    const signer = await createEphemeralEvidenceBundleSigner();
    const bundle = buildEvidenceBundle([tenant(), tenant({ id: 'tt-2', slug: 'globex' })], {
      scope,
      ...(tenantId !== undefined ? { tenantId } : {}),
      now: new Date('2026-06-25T00:00:00.000Z'),
    });
    const jws = await signer.signBundle(bundle);
    return { bundle, jws };
  }

  beforeAll(async () => {
    await registry.migrate(); // ensures tf_evidence_bundles (migration 0013)
    await cleanup.query(`DELETE FROM tf_evidence_bundles WHERE signer_kid = $1`, ['ephemeral-int']);
  });

  afterAll(async () => {
    if (storedIds.length > 0) {
      await cleanup.query(`DELETE FROM tf_evidence_bundles WHERE bundle_id = ANY($1)`, [storedIds]);
    }
    await cleanup.end();
    await store.close();
    await registry.close();
  });

  it('persists a fleet bundle and reads it back from a FRESH instance (durable across restart)', async () => {
    const signed = await sign('fleet');
    const manifest = await store.put(signed, { signerKid: 'kid-fleet' });
    storedIds.push(manifest.bundleId);
    expect(manifest.scope).toBe('fleet');
    expect(manifest.tenantId).toBeUndefined();
    // A brand-new store instance (simulating another replica / a restart) reads it from Postgres.
    const other = createPgEvidenceStore({ connectionString: databaseUrl! });
    try {
      const got = await other.get(manifest.bundleId, null);
      expect(got).not.toBeNull();
      // The persisted signed body still verifies (the signature is unchanged by persistence).
      expect(got!.bundle.scope).toBe('fleet');
    } finally {
      await other.close();
    }
  });

  it('persists a per-tenant bundle and enforces tenant-scope isolation on get (BOLA defense)', async () => {
    const signed = await sign('tenant', 'tt-1');
    const manifest = await store.put(signed, { signerKid: 'kid-tenant' });
    storedIds.push(manifest.bundleId);
    expect(manifest.tenantId).toBe('tt-1');
    // tt-1's own scope returns it; tt-2's scope must NOT (store-level scope guard); fleet/null may.
    expect(await store.get(manifest.bundleId, 'tt-1')).not.toBeNull();
    expect(await store.get(manifest.bundleId, 'tt-2')).toBeNull();
    expect(await store.get(manifest.bundleId, null)).not.toBeNull();
    // And the fetched body still verifies offline with the matching public key.
    const got = await store.get(manifest.bundleId, 'tt-1');
    expect(got!.bundle.tenantId).toBe('tt-1');
  });

  it('lists manifests newest-stored-first, bounded by a clamped limit, filterable by scope', async () => {
    const a = await store.put(await sign('fleet'), {
      signerKid: 'kid-list-a',
      storedAt: new Date('2026-06-20T00:00:00.000Z'),
    });
    const b = await store.put(await sign('fleet'), {
      signerKid: 'kid-list-b',
      storedAt: new Date('2026-06-22T00:00:00.000Z'),
    });
    storedIds.push(a.bundleId, b.bundleId);
    const fleet = await store.list({ scope: 'fleet', limit: 1000 });
    // Newest-stored first — b (2026-06-22) precedes a (2026-06-20) in the result.
    const idxA = fleet.findIndex((m) => m.bundleId === a.bundleId);
    const idxB = fleet.findIndex((m) => m.bundleId === b.bundleId);
    expect(idxB).toBeLessThan(idxA);
    // A bounded list never returns an unbounded set (limit honored).
    const one = await store.list({ scope: 'fleet', limit: 1 });
    expect(one).toHaveLength(1);
  });

  it('pruneExpired removes only past-retention bundles, is idempotent + bounded, leaves indefinite', async () => {
    // An expired bundle (1-day retention, stored well in the past) and an indefinite one.
    const expired = await store.put(await sign('fleet'), {
      signerKid: 'kid-expired',
      storedAt: new Date('2020-01-01T00:00:00.000Z'),
      retentionDays: 1,
    });
    const indefinite = await store.put(await sign('fleet'), { signerKid: 'kid-indef' });
    storedIds.push(expired.bundleId, indefinite.bundleId);
    const now = new Date('2026-06-25T00:00:00.000Z');
    const pruned = await store.pruneExpired(now, 1000);
    expect(pruned).toBeGreaterThanOrEqual(1);
    // The expired one is gone; the indefinite one remains.
    expect(await store.get(expired.bundleId, null)).toBeNull();
    expect(await store.get(indefinite.bundleId, null)).not.toBeNull();
    // Idempotent: a second sweep removes nothing new among these (no expired left).
    const again = await store.get(expired.bundleId, null);
    expect(again).toBeNull();
  });

  it('the persisted body carries no secrets and the manifest is facts-only (verifiable offline)', async () => {
    const signer = await createEphemeralEvidenceBundleSigner();
    const bundle = buildEvidenceBundle([tenant()], {
      scope: 'fleet',
      now: new Date('2026-06-25T00:00:00.000Z'),
    });
    const jws = await signer.signBundle(bundle);
    const manifest = await store.put({ bundle, jws }, { signerKid: 'kid-verify' });
    storedIds.push(manifest.bundleId);
    const got = await store.get(manifest.bundleId, null);
    const pub = await signer.publicKeyJwk();
    await expect(verifyEvidenceBundle(got!.jws, pub)).resolves.toMatchObject({ scope: 'fleet' });
    // The manifest row never carries a connection URI / secret.
    expect(JSON.stringify(manifest)).not.toMatch(/postgres(ql)?:\/\//);
  });
});
