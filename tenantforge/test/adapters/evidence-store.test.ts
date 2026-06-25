import { describe, expect, it } from 'vitest';
import type { SignedEvidenceBundle, EvidenceBundle } from '../../src/core/evidence-bundle.js';
import type { ObjectStore, PutResult } from '../../src/ports/object-store.js';
import type { EvidenceStore } from '../../src/ports/evidence-store.js';
import {
  createInMemoryEvidenceStore,
  mintEvidenceBundleId,
} from '../../src/adapters/evidence-store.js';
import { createObjectStoreEvidenceStore } from '../../src/adapters/object-store-evidence-store.js';

/** A minimal bundle (the artifact details don't matter to the store — it persists opaque facts). */
function bundle(over: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    scope: 'fleet',
    generatedAt: '2026-06-25T00:00:00.000Z',
    artifacts: {
      inventory: { total: 0, byStatus: {} as EvidenceBundle['artifacts']['inventory']['byStatus'] },
      isolation: { compliant: true, missingProject: [], sharedProjects: [] },
      residency: { compliant: true, allowedRegions: [], byJurisdiction: {}, violations: [] },
      auditExcerpt: [],
      erasureCertificates: [],
    },
    contentHashes: {
      inventory: 'i',
      isolation: 'is',
      residency: 'r',
      auditExcerpt: 'a',
      erasureCertificates: 'e',
    },
    ...over,
  };
}

/** A signed bundle (`jws` is opaque to the store). */
function signed(over: Partial<EvidenceBundle> = {}): SignedEvidenceBundle {
  return { bundle: bundle(over), jws: 'header.payload.sig' };
}

/** An in-memory fake of the (write-only) ObjectStore port that records every `put`. */
function fakeObjectStore(): ObjectStore & { puts: { key: string; bytes: number }[] } {
  const puts: { key: string; bytes: number }[] = [];
  return {
    puts,
    put(key: string, body: Buffer): Promise<PutResult> {
      puts.push({ key, bytes: body.byteLength });
      return Promise.resolve({ location: `mem://${key}`, bytes: body.byteLength });
    },
  };
}

/**
 * The store contract every {@link EvidenceStore} adapter must satisfy. Run against the in-memory
 * adapter and the object-store-backed adapter (built on a fake ObjectStore) so both honor the same
 * put→get round-trip, tenant-scope isolation, listing/filtering, retention prune, and non-guessable
 * ids.
 */
function contract(name: string, makeStore: () => EvidenceStore): void {
  describe(name, () => {
    it('put → get round-trips the signed bundle (operator/fleet scope)', async () => {
      const store = makeStore();
      const m = await store.put(signed(), { signerKid: 'kid-1' });
      const got = await store.get(m.bundleId, null);
      expect(got?.jws).toBe('header.payload.sig');
      expect(got?.bundle.scope).toBe('fleet');
    });

    it('put returns a manifest of facts only (no jws body, no secrets)', async () => {
      const store = makeStore();
      const m = await store.put(signed(), { signerKid: 'kid-1' });
      const json = JSON.stringify(m);
      expect(json).not.toContain('header.payload.sig'); // no JWS body in the index record
      expect(m.scope).toBe('fleet');
      expect(m.signerKid).toBe('kid-1');
      expect(m.generatedAt).toBe('2026-06-25T00:00:00.000Z');
      expect(typeof m.storedAt).toBe('string');
    });

    it('mints non-guessable, unique ids (not sequential)', async () => {
      const store = makeStore();
      const a = await store.put(signed(), { signerKid: 'k' });
      const b = await store.put(signed(), { signerKid: 'k' });
      expect(a.bundleId).not.toBe(b.bundleId);
      // 16 random bytes → 32 hex chars; not a small sequential integer.
      expect(a.bundleId).toMatch(/^[0-9a-f]{32}$/);
      expect(Number(a.bundleId)).not.toBe(0);
    });

    it('get returns null for an unknown id', async () => {
      const store = makeStore();
      expect(await store.get('does-not-exist', null)).toBeNull();
    });

    it('TENANT-SCOPE ISOLATION: a tenant fetch never returns another tenant’s (or a fleet) bundle', async () => {
      const store = makeStore();
      const a = await store.put(signed({ scope: 'tenant', tenantId: 't-a' }), { signerKid: 'k' });
      const fleet = await store.put(signed({ scope: 'fleet' }), { signerKid: 'k' });
      // Tenant A may fetch its own…
      expect(await store.get(a.bundleId, 't-a')).not.toBeNull();
      // …but tenant B may NOT fetch A's bundle (BOLA at the store level)…
      expect(await store.get(a.bundleId, 't-b')).toBeNull();
      // …nor may a tenant scope fetch a fleet bundle.
      expect(await store.get(fleet.bundleId, 't-a')).toBeNull();
      // The operator (null) scope may fetch either.
      expect(await store.get(a.bundleId, null)).not.toBeNull();
      expect(await store.get(fleet.bundleId, null)).not.toBeNull();
    });

    it('list returns manifests newest-stored first and filters by scope/tenant', async () => {
      const store = makeStore();
      await store.put(signed({ scope: 'fleet' }), {
        signerKid: 'k',
        storedAt: new Date('2026-06-25T00:00:00.000Z'),
      });
      await store.put(signed({ scope: 'tenant', tenantId: 't-a' }), {
        signerKid: 'k',
        storedAt: new Date('2026-06-26T00:00:00.000Z'),
      });
      const all = await store.list();
      expect(all).toHaveLength(2);
      expect(all[0]?.storedAt).toBe('2026-06-26T00:00:00.000Z'); // newest first
      expect(await store.list({ scope: 'fleet' })).toHaveLength(1);
      expect((await store.list({ tenantId: 't-a' }))[0]?.tenantId).toBe('t-a');
      expect(await store.list({ tenantId: 't-zzz' })).toHaveLength(0);
    });

    it('list clamps the limit (no unbounded scan) and respects a small limit', async () => {
      const store = makeStore();
      for (let i = 0; i < 5; i++) await store.put(signed(), { signerKid: 'k' });
      expect(await store.list({ limit: 2 })).toHaveLength(2);
      // A bogus limit falls back to the default (still returns all 5 here, not zero/negative).
      expect(await store.list({ limit: -1 })).toHaveLength(5);
    });

    it('pruneExpired removes ONLY expired bundles; indefinite ones survive', async () => {
      const store = makeStore();
      const expiring = await store.put(signed(), {
        signerKid: 'k',
        storedAt: new Date('2026-06-25T00:00:00.000Z'),
        retentionDays: 30, // expires 2026-07-25
      });
      const indefinite = await store.put(signed(), { signerKid: 'k', retentionDays: 0 });
      // Before the deadline: nothing pruned.
      expect(await store.pruneExpired(new Date('2026-07-01T00:00:00.000Z'))).toBe(0);
      // After: exactly the expiring one is removed.
      expect(await store.pruneExpired(new Date('2026-08-01T00:00:00.000Z'))).toBe(1);
      expect(await store.get(expiring.bundleId, null)).toBeNull();
      expect(await store.get(indefinite.bundleId, null)).not.toBeNull();
      // Idempotent: a second sweep removes nothing new.
      expect(await store.pruneExpired(new Date('2026-08-01T00:00:00.000Z'))).toBe(0);
    });
  });
}

contract('createInMemoryEvidenceStore', () => createInMemoryEvidenceStore());
contract('createObjectStoreEvidenceStore', () =>
  createObjectStoreEvidenceStore({ objectStore: fakeObjectStore() }),
);

describe('createInMemoryEvidenceStore — clear()', () => {
  it('clear() empties the store', async () => {
    const store = createInMemoryEvidenceStore();
    await store.put(signed(), { signerKid: 'k' });
    store.clear();
    expect(await store.list()).toHaveLength(0);
  });
});

describe('createObjectStoreEvidenceStore — at-rest write', () => {
  it('writes the signed body to the object store under a non-guessable, tenant-scoped key', async () => {
    const os = fakeObjectStore();
    const store = createObjectStoreEvidenceStore({ objectStore: os });
    const m = await store.put(signed({ scope: 'tenant', tenantId: 't-a' }), { signerKid: 'k' });
    expect(os.puts).toHaveLength(1);
    // Key layout: evidence/{tenant|fleet}/{bundleId}.jws.json — tenant-scoped + non-guessable id.
    expect(os.puts[0]?.key).toBe(`evidence/t-a/${m.bundleId}.jws.json`);
    expect(os.puts[0]?.bytes).toBeGreaterThan(0);
  });

  it('a fleet bundle is written under the `fleet/` scope segment', async () => {
    const os = fakeObjectStore();
    const store = createObjectStoreEvidenceStore({ objectStore: os });
    const m = await store.put(signed({ scope: 'fleet' }), { signerKid: 'k' });
    expect(os.puts[0]?.key).toBe(`evidence/fleet/${m.bundleId}.jws.json`);
  });

  it('a custom keyPrefix namespaces the at-rest objects', async () => {
    const os = fakeObjectStore();
    const store = createObjectStoreEvidenceStore({ objectStore: os, keyPrefix: '/custom/' });
    const m = await store.put(signed(), { signerKid: 'k' });
    expect(os.puts[0]?.key).toBe(`custom/fleet/${m.bundleId}.jws.json`);
  });
});

describe('mintEvidenceBundleId', () => {
  it('produces a 32-hex-char (128-bit) id and is unique across calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => mintEvidenceBundleId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});
