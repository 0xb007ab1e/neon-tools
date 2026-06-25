import { describe, expect, it } from 'vitest';
import type {
  JsonObject,
  MigrationStatus,
  TenantMigrationState,
  TenantRecord,
  TenantStatus,
} from '../../src/core/domain.js';
import type { NewTenant, TenantRegistry } from '../../src/ports/tenant-registry.js';
import type { TenantEvent } from '../../src/core/observability.js';
import type { EventSink } from '../../src/ports/event-sink.js';
import type { EvidenceStore } from '../../src/ports/evidence-store.js';
import type { ProvisioningProvider } from '../../src/ports/provisioning-provider.js';
import { createEphemeralEvidenceBundleSigner } from '../../src/adapters/evidence-bundle-signer.js';
import { createInMemoryEvidenceStore } from '../../src/adapters/evidence-store.js';
import { createInMemorySecretStore } from '../../src/adapters/secret-store.js';
import { verifyEvidenceBundle } from '../../src/core/evidence-bundle.js';
import { createTenantForge } from '../../src/app/lib.js';

/** A registry seeded with one active tenant (enough for fleet + per-tenant bundles). */
function registry(): TenantRegistry & { seed(r: TenantRecord): void } {
  const byId = new Map<string, TenantRecord>();
  const clone = (r: TenantRecord): TenantRecord => ({ ...r, metadata: { ...r.metadata } });
  return {
    seed(r) {
      byId.set(r.id, r);
    },
    create(t: NewTenant) {
      const rec: TenantRecord = {
        id: `tenant-${byId.size + 1}`,
        slug: t.slug,
        region: t.region,
        status: 'active',
        neonProjectId: `proj-${byId.size + 1}`,
        metadata: (t.metadata as JsonObject) ?? {},
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
      byId.set(rec.id, rec);
      return Promise.resolve(clone(rec));
    },
    getById: (id) => Promise.resolve(byId.has(id) ? clone(byId.get(id)!) : null),
    getBySlug: (slug) => {
      for (const r of byId.values()) if (r.slug === slug) return Promise.resolve(clone(r));
      return Promise.resolve(null);
    },
    list: (o?: { status?: TenantStatus }) =>
      Promise.resolve(
        [...byId.values()].filter((r) => !o?.status || r.status === o.status).map(clone),
      ),
    attachProject: () => Promise.resolve(),
    setStatus: () => Promise.resolve(),
    updateMetadata: () => Promise.resolve(),
    relocate: () => Promise.resolve(),
    registerMigration: (m: { version: string; checksum: string }) =>
      Promise.resolve({ id: 'm', version: m.version, checksum: m.checksum }),
    listMigrations: () => Promise.resolve([]),
    listTenantMigrationStates: () => Promise.resolve([] as TenantMigrationState[]),
    recordTenantMigration: (_t: string, _m: string, _s: MigrationStatus) => Promise.resolve(),
    migrate: () => Promise.resolve(),
    ping: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

const provisioning: ProvisioningProvider = {
  createTenantProject: () =>
    Promise.resolve({ neonProjectId: 'p', connectionUri: 'postgresql://x@h/d' }),
  deleteTenantProject: () => Promise.resolve(),
  rotateTenantCredential: () => Promise.resolve({ connectionUri: 'postgresql://r@h/d' }),
};

/** An event sink that records every emitted event (to assert the persist webhook event). */
function capturingSink(): EventSink & { events: TenantEvent[] } {
  const events: TenantEvent[] = [];
  return {
    events,
    emit(e: TenantEvent): void {
      events.push(e);
    },
  };
}

const baseTenant = (over: Partial<TenantRecord> = {}): TenantRecord => ({
  id: 't-a',
  slug: 'acme',
  region: 'aws-us-east-1',
  status: 'active',
  neonProjectId: 'proj-a',
  metadata: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

async function makeForge(opts?: { withStore?: boolean; retentionDays?: number; sink?: EventSink }) {
  const reg = registry();
  reg.seed(baseTenant());
  reg.seed(baseTenant({ id: 't-b', slug: 'globex', neonProjectId: 'proj-b' }));
  const signer = await createEphemeralEvidenceBundleSigner();
  const store = opts?.withStore === false ? undefined : createInMemoryEvidenceStore();
  const tf = createTenantForge({
    registry: reg,
    provisioning,
    secretStore: createInMemorySecretStore(),
    defaultRegion: 'aws-us-east-1',
    evidenceBundleSigner: signer,
    ...(store !== undefined ? { evidenceStore: store } : {}),
    ...(opts?.retentionDays !== undefined ? { evidenceRetentionDays: opts.retentionDays } : {}),
    ...(opts?.sink !== undefined ? { eventSink: opts.sink } : {}),
  });
  return { tf, store, signer };
}

describe('evidenceBundle persist-on-generate (ADR-0011 Phase 3a)', () => {
  it('persists the signed bundle and returns its manifest when a store is wired', async () => {
    const { tf, store } = await makeForge();
    const result = await tf.evidenceBundle({ scope: 'fleet' });
    expect(result.jws).toBeDefined();
    expect(result.manifest).toBeDefined();
    expect(result.manifest!.scope).toBe('fleet');
    expect(result.manifest!.signerKid).toBe('tenantforge-evidence-bundle');
    // The persisted body round-trips and still verifies against the published public key.
    const got = await store!.get(result.manifest!.bundleId, null);
    expect(got).not.toBeNull();
    const pub = await tf.evidenceBundlePublicKey();
    await expect(verifyEvidenceBundle(got!.jws, pub!)).resolves.toMatchObject({ scope: 'fleet' });
  });

  it('a per-tenant bundle is persisted under that tenant’s scope (BOLA-ready index)', async () => {
    const { tf, store } = await makeForge();
    const result = await tf.evidenceBundle({ scope: 'tenant', tenantId: 't-a' });
    expect(result.manifest!.tenantId).toBe('t-a');
    // Tenant A can fetch its own; tenant B cannot (store-level scope guard for 3b).
    expect(await store!.get(result.manifest!.bundleId, 't-a')).not.toBeNull();
    expect(await store!.get(result.manifest!.bundleId, 't-b')).toBeNull();
  });

  it('generation still succeeds WITHOUT a store, but does not claim persistence (manifest omitted)', async () => {
    const { tf } = await makeForge({ withStore: false });
    const result = await tf.evidenceBundle({ scope: 'fleet' });
    expect(result.jws).toBeDefined();
    expect(result.manifest).toBeUndefined(); // explicit absence — never a silent "persisted"
  });

  it('fails closed without a signer (no unsigned bundle path)', async () => {
    const reg = registry();
    reg.seed(baseTenant());
    const tf = createTenantForge({
      registry: reg,
      provisioning,
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      evidenceStore: createInMemoryEvidenceStore(),
    });
    await expect(tf.evidenceBundle({ scope: 'fleet' })).rejects.toThrow(
      /no evidence-bundle signer/,
    );
  });

  it('fails the call (fail closed) when the store rejects the persist — no silent unpersisted bundle, no event', async () => {
    const reg = registry();
    reg.seed(baseTenant());
    const signer = await createEphemeralEvidenceBundleSigner();
    const sink = capturingSink();
    // A store whose persist always fails (e.g. the object store is unavailable).
    const failingStore: EvidenceStore = {
      put: () => Promise.reject(new Error('object store unavailable')),
      get: () => Promise.resolve(null),
      list: () => Promise.resolve([]),
      pruneExpired: () => Promise.resolve(0),
    };
    const tf = createTenantForge({
      registry: reg,
      provisioning,
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      evidenceBundleSigner: signer,
      evidenceStore: failingStore,
      eventSink: sink,
    });
    // The persist failure must propagate — generation does NOT succeed-but-lose-the-bundle.
    await expect(tf.evidenceBundle({ scope: 'fleet' })).rejects.toThrow(/object store unavailable/);
    // And no persisted-event may be emitted for a persist that didn't happen.
    expect(sink.events.some((e) => e.event === 'compliance.evidence_bundle_persisted')).toBe(false);
  });
});

describe('evidenceBundle webhook-on-persist (ADR-0011 Phase 3a)', () => {
  it('emits compliance.evidence_bundle_persisted with manifest FACTS ONLY (no body/secrets)', async () => {
    const sink = capturingSink();
    const { tf } = await makeForge({ sink, retentionDays: 30 });
    const result = await tf.evidenceBundle({ scope: 'tenant', tenantId: 't-a' });
    const persisted = sink.events.find((e) => e.event === 'compliance.evidence_bundle_persisted');
    expect(persisted).toBeDefined();
    expect(persisted!.tenantId).toBe('t-a');
    expect(persisted!.context?.['bundleId']).toBe(result.manifest!.bundleId);
    expect(persisted!.context?.['scope']).toBe('tenant');
    expect(persisted!.context?.['retentionUntil']).toBeDefined();
    // The signed JWS body must NEVER appear in the webhook payload.
    expect(JSON.stringify(persisted!.context)).not.toContain(result.jws);
  });

  it('emits no persist event when no store is wired', async () => {
    const sink = capturingSink();
    const { tf } = await makeForge({ sink, withStore: false });
    await tf.evidenceBundle({ scope: 'fleet' });
    expect(sink.events.some((e) => e.event === 'compliance.evidence_bundle_persisted')).toBe(false);
  });
});

describe('evidencePrune retention sweep (ADR-0011 Phase 3a)', () => {
  it('prunes only expired bundles and is idempotent', async () => {
    const { tf, store } = await makeForge({ retentionDays: 30 });
    const r = await tf.evidenceBundle({ scope: 'fleet' });
    // Before the deadline: nothing pruned.
    const before = await tf.evidencePrune({ now: new Date('2026-06-26T00:00:00.000Z') });
    expect(before.pruned).toBe(0);
    // After: the one expired bundle is pruned (and gone from the store).
    const after = await tf.evidencePrune({ now: new Date('2100-01-01T00:00:00.000Z') });
    expect(after.pruned).toBe(1);
    expect(await store!.get(r.manifest!.bundleId, null)).toBeNull();
    // Idempotent: a second sweep removes nothing.
    expect((await tf.evidencePrune({ now: new Date('2100-01-01T00:00:00.000Z') })).pruned).toBe(0);
  });

  it('is a no-op (pruned: 0) when no store is wired', async () => {
    const { tf } = await makeForge({ withStore: false });
    expect((await tf.evidencePrune()).pruned).toBe(0);
  });

  it('indefinite-retention bundles (no retentionDays) are never pruned', async () => {
    const { tf, store } = await makeForge(); // no retentionDays ⇒ indefinite
    const r = await tf.evidenceBundle({ scope: 'fleet' });
    expect((await tf.evidencePrune({ now: new Date('2100-01-01T00:00:00.000Z') })).pruned).toBe(0);
    expect(await store!.get(r.manifest!.bundleId, null)).not.toBeNull();
  });
});

describe('evidenceList / evidenceGet retrieval facade (ADR-0011 Phase 3b)', () => {
  it('lists persisted manifests (facts only) and audits the list (count, no body)', async () => {
    const sink = capturingSink();
    const { tf } = await makeForge({ sink });
    await tf.evidenceBundle({ scope: 'fleet' });
    await tf.evidenceBundle({ scope: 'tenant', tenantId: 't-a' });
    const manifests = await tf.evidenceList();
    expect(manifests).toHaveLength(2);
    // Manifests carry FACTS ONLY — never the signed JWS body.
    for (const m of manifests) expect(m).not.toHaveProperty('jws');
    expect(JSON.stringify(manifests)).not.toContain('eyJ'); // no base64url JWS header anywhere
    const listed = sink.events.find((e) => e.event === 'compliance.evidence_list');
    expect(listed).toBeDefined();
    expect(listed!.context?.['count']).toBe(2);
  });

  it('a scope filter restricts the listing (server-derived; no client tenant id)', async () => {
    const { tf } = await makeForge();
    await tf.evidenceBundle({ scope: 'fleet' });
    await tf.evidenceBundle({ scope: 'tenant', tenantId: 't-a' });
    const fleet = await tf.evidenceList({ scope: 'fleet' });
    expect(fleet.every((m) => m.scope === 'fleet')).toBe(true);
    expect(fleet).toHaveLength(1);
  });

  it('evidenceGet returns a stored bundle under operator (fleet) scope and audits the fetch', async () => {
    const sink = capturingSink();
    const { tf } = await makeForge({ sink });
    const r = await tf.evidenceBundle({ scope: 'fleet' });
    const got = await tf.evidenceGet(r.manifest!.bundleId, null);
    expect(got).not.toBeNull();
    const pub = await tf.evidenceBundlePublicKey();
    await expect(verifyEvidenceBundle(got!.jws, pub!)).resolves.toMatchObject({ scope: 'fleet' });
    const fetched = sink.events.find((e) => e.event === 'compliance.evidence_fetch');
    expect(fetched).toBeDefined();
    expect(fetched!.context?.['bundleId']).toBe(r.manifest!.bundleId);
    expect(fetched!.context?.['found']).toBe(true);
    // The audit event never leaks the bundle body.
    expect(JSON.stringify(fetched!.context)).not.toContain(got!.jws);
  });

  it('evidenceGet honors the server-derived tenant scope (cross-tenant fetch returns null — BOLA)', async () => {
    const { tf } = await makeForge();
    const r = await tf.evidenceBundle({ scope: 'tenant', tenantId: 't-a' });
    // Tenant A's own scope returns it; tenant B's scope must NOT (store-level BOLA defense).
    expect(await tf.evidenceGet(r.manifest!.bundleId, 't-a')).not.toBeNull();
    expect(await tf.evidenceGet(r.manifest!.bundleId, 't-b')).toBeNull();
  });

  it('evidenceGet audits found:false for an unknown id (still ok outcome — a clean miss)', async () => {
    const sink = capturingSink();
    const { tf } = await makeForge({ sink });
    expect(await tf.evidenceGet('deadbeef', null)).toBeNull();
    const fetched = sink.events.find((e) => e.event === 'compliance.evidence_fetch');
    expect(fetched!.outcome).toBe('ok');
    expect(fetched!.context?.['found']).toBe(false);
  });

  it('fail soft when no store is wired (list → [], get → null)', async () => {
    const { tf } = await makeForge({ withStore: false });
    expect(await tf.evidenceList()).toEqual([]);
    expect(await tf.evidenceGet('x', null)).toBeNull();
  });
});
