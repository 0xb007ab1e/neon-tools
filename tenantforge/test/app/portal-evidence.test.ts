import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPortal } from '../../src/app/portal.js';
import type { TenantForge } from '../../src/app/lib.js';
import type { TenantAuthenticator } from '../../src/ports/tenant-authenticator.js';
import {
  createInMemoryEvidenceStore,
  type InMemoryEvidenceStore,
} from '../../src/adapters/evidence-store.js';
import type { SignedEvidenceBundle } from '../../src/core/evidence-bundle.js';
import type { EvidenceManifestFilter } from '../../src/core/evidence-manifest.js';

const SECRET = 'portal-session-secret';
const NOW = 1_700_000_000_000;
const TTL_MS = 60 * 60 * 1000; // portal default
const SESSION_EXP = NOW + TTL_MS;

/** A minimal, well-formed signed bundle for a tenant (the body is opaque to the portal). */
function tenantBundle(tenantId: string): SignedEvidenceBundle {
  return {
    bundle: {
      scope: 'tenant',
      tenantId,
      generatedAt: '2026-06-25T00:00:00.000Z',
      artifacts: {
        inventory: {
          total: 1,
          byStatus: { provisioning: 0, active: 1, suspended: 0, offboarding: 0, deleted: 0 },
        },
        isolation: { compliant: true, missingProject: [], sharedProjects: [] },
        residency: { compliant: true, allowedRegions: [], byJurisdiction: {}, violations: [] },
        auditExcerpt: [],
        erasureCertificates: [],
      },
      contentHashes: {
        inventory: 'h-inv',
        isolation: 'h-iso',
        residency: 'h-res',
        auditExcerpt: 'h-aud',
        erasureCertificates: 'h-cert',
      },
    },
    jws: `jws-for-${tenantId}`,
  };
}

/** A public Ed25519 JWK — public material only (no private `d`). */
const PUBLIC_JWK = { kty: 'OKP', crv: 'Ed25519', x: 'abc123', kid: 'tenantforge-evidence-bundle' };

/**
 * A fake TenantForge whose evidence methods delegate to the REAL in-memory `EvidenceStore`, so the
 * store-level tenant-scope (BOLA) guard exercised by the abuse test is the genuine one — not a
 * hand-rolled stub. `generate` self-scopes to the passed tenant id, like the facade. The public-key
 * method returns a fixed public JWK (or null to simulate no signer).
 */
function fakeTf(store: InMemoryEvidenceStore, opts: { signer?: boolean } = {}): TenantForge {
  const signer = opts.signer ?? true;
  return {
    evidenceList: (filter?: EvidenceManifestFilter) => store.list(filter),
    evidenceGet: (bundleId: string, tenantScope: string | null) => store.get(bundleId, tenantScope),
    evidenceBundlePublicKey: () => Promise.resolve(signer ? PUBLIC_JWK : null),
    evidenceBundle: async (options: { scope: 'fleet' | 'tenant'; tenantId?: string }) => {
      if (!signer) throw new Error('evidenceBundle: no evidence-bundle signer configured');
      // Self-scoped assembly: the server-derived tenant id is honored; persist + return the manifest.
      const tenantId = options.tenantId!;
      const signed = tenantBundle(tenantId);
      const manifest = await store.put(signed, { signerKid: 'tenantforge-evidence-bundle' });
      return { ...signed, manifest };
    },
  } as unknown as TenantForge;
}

const auth: TenantAuthenticator = {
  authenticate: (token: string) =>
    Promise.resolve(
      token === 'tok-a' ? { tenantId: 't-a' } : token === 'tok-b' ? { tenantId: 't-b' } : null,
    ),
};

const portal = (
  store: InMemoryEvidenceStore,
  opts: { evidence?: boolean; signer?: boolean } = {},
): ReturnType<typeof createPortal> =>
  createPortal({
    tf: fakeTf(store, { ...(opts.signer !== undefined ? { signer: opts.signer } : {}) }),
    authenticator: auth,
    sessionSecret: SECRET,
    enableEvidence: opts.evidence ?? true,
    now: () => NOW,
  });

async function login(app: ReturnType<typeof createPortal>, token: string): Promise<string> {
  const res = await app.request('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

/** The session-bound CSRF token a client reads from `/api/csrf`: `tenantId.HMAC(csrf:{tenantId}:{exp})`. */
function csrfFor(tenantId: string, exp: number = SESSION_EXP): string {
  const sig = createHmac('sha256', SECRET).update(`csrf:${tenantId}:${exp}`).digest('base64url');
  return `${tenantId}.${sig}`;
}

/** Seed the store with one bundle per tenant; returns the minted bundle ids. */
async function seed(store: InMemoryEvidenceStore): Promise<{ a: string; b: string }> {
  const a = await store.put(tenantBundle('t-a'), { signerKid: 'k' });
  const b = await store.put(tenantBundle('t-b'), { signerKid: 'k' });
  return { a: a.bundleId, b: b.bundleId };
}

describe('portal self-serve evidence — auth (B8e)', () => {
  it('every evidence route requires a session (401 unauthenticated)', async () => {
    const store = createInMemoryEvidenceStore();
    const app = portal(store);
    expect((await app.request('/api/evidence')).status).toBe(401);
    expect((await app.request('/api/evidence/anything')).status).toBe(401);
    expect((await app.request('/api/evidence/public-key')).status).toBe(401);
    const gen = await app.request('/api/evidence/generate', { method: 'POST' });
    expect(gen.status).toBe(401);
  });

  it('a tampered session cookie is rejected (fail closed)', async () => {
    const store = createInMemoryEvidenceStore();
    const app = portal(store);
    const cookie = await login(app, 'tok-a');
    const tampered = `${cookie.split('.')[0]}.deadbeef`;
    expect((await app.request('/api/evidence', { headers: { cookie: tampered } })).status).toBe(
      401,
    );
  });

  it('the routes do not exist when the evidence flag is OFF (404), and are not advertised', async () => {
    const store = createInMemoryEvidenceStore();
    const app = portal(store, { evidence: false });
    const cookie = await login(app, 'tok-a');
    expect((await app.request('/api/evidence', { headers: { cookie } })).status).toBe(404);
    // The capability is advertised as false (so the SPA hides the section).
    const cfg = (await (await app.request('/api/config')).json()) as {
      features: { evidence: boolean; destructiveActions: boolean };
    };
    expect(cfg.features.evidence).toBe(false);
  });

  it('advertises evidence:true independently of destructiveActions', async () => {
    const store = createInMemoryEvidenceStore();
    const app = portal(store, { evidence: true }); // destructive defaults OFF
    const cfg = (await (await app.request('/api/config')).json()) as {
      features: { evidence: boolean; destructiveActions: boolean };
    };
    expect(cfg.features).toEqual({ evidence: true, destructiveActions: false });
  });
});

describe('portal self-serve evidence — own-scope reads', () => {
  it('lists ONLY my own manifests (server-derived tenant scope)', async () => {
    const store = createInMemoryEvidenceStore();
    await seed(store);
    const app = portal(store);
    const cookie = await login(app, 'tok-a');
    const res = await app.request('/api/evidence', { headers: { cookie } });
    expect(res.status).toBe(200);
    const { manifests } = (await res.json()) as { manifests: { tenantId?: string }[] };
    expect(manifests).toHaveLength(1);
    expect(manifests.every((m) => m.tenantId === 't-a')).toBe(true);
  });

  it('downloads my OWN signed bundle (the body + jws)', async () => {
    const store = createInMemoryEvidenceStore();
    const ids = await seed(store);
    const app = portal(store);
    const cookie = await login(app, 'tok-a');
    const res = await app.request(`/api/evidence/${ids.a}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SignedEvidenceBundle;
    expect(body.bundle.tenantId).toBe('t-a');
    expect(body.jws).toBe('jws-for-t-a');
  });

  it('serves ONLY the public JWK on the public-key route (never a private `d`)', async () => {
    const store = createInMemoryEvidenceStore();
    const app = portal(store);
    const cookie = await login(app, 'tok-a');
    const res = await app.request('/api/evidence/public-key', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { publicKey: Record<string, unknown> };
    expect(body.publicKey).not.toHaveProperty('d');
    expect(body.publicKey).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
    // The raw response never contains a private-key parameter.
    expect(JSON.stringify(body)).not.toMatch(/"d"\s*:/);
  });

  it('self-generates a bundle scoped to MY session tenant (non-destructive), then it appears in my list', async () => {
    const store = createInMemoryEvidenceStore();
    const app = portal(store);
    const cookie = await login(app, 'tok-a');
    const gen = await app.request('/api/evidence/generate', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-tf-csrf': csrfFor('t-a'),
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(gen.status).toBe(200);
    const { manifest } = (await gen.json()) as { manifest: { tenantId?: string } | null };
    expect(manifest?.tenantId).toBe('t-a');
    // The generated bundle is persisted under MY scope and now lists.
    const list = (await (await app.request('/api/evidence', { headers: { cookie } })).json()) as {
      manifests: { tenantId?: string }[];
    };
    expect(list.manifests).toHaveLength(1);
    expect(list.manifests[0]?.tenantId).toBe('t-a');
  });

  it('rejects generate without a CSRF token (403) — it is a state-changing request', async () => {
    const store = createInMemoryEvidenceStore();
    const app = portal(store);
    const cookie = await login(app, 'tok-a');
    const res = await app.request('/api/evidence/generate', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    });
    expect(res.status).toBe(403);
  });

  it('a rejected limit is a 400 (bounded list — DoS)', async () => {
    const store = createInMemoryEvidenceStore();
    const app = portal(store);
    const cookie = await login(app, 'tok-a');
    expect((await app.request('/api/evidence?limit=0', { headers: { cookie } })).status).toBe(400);
    expect((await app.request('/api/evidence?limit=-3', { headers: { cookie } })).status).toBe(400);
    expect((await app.request('/api/evidence?limit=x', { headers: { cookie } })).status).toBe(400);
  });

  it('public-key route 404s when no signer is configured (degrades gracefully)', async () => {
    const store = createInMemoryEvidenceStore();
    const app = portal(store, { signer: false });
    const cookie = await login(app, 'tok-a');
    expect((await app.request('/api/evidence/public-key', { headers: { cookie } })).status).toBe(
      404,
    );
  });

  it('an empty store lists [] (fail soft, never a 500)', async () => {
    const store = createInMemoryEvidenceStore();
    const app = portal(store);
    const cookie = await login(app, 'tok-a');
    const res = await app.request('/api/evidence', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { manifests: unknown[] }).manifests).toEqual([]);
  });
});

describe('portal self-serve evidence — CROSS-TENANT abuse (B8e — the mandatory BOLA gate)', () => {
  it("tenant A requesting tenant B's bundleId → uniform 404 (no cross-tenant leak, no existence oracle)", async () => {
    const store = createInMemoryEvidenceStore();
    const ids = await seed(store);
    const app = portal(store);
    const cookieA = await login(app, 'tok-a');

    // A can fetch its own bundle.
    expect(
      (await app.request(`/api/evidence/${ids.a}`, { headers: { cookie: cookieA } })).status,
    ).toBe(200);
    // A requesting B's REAL bundleId → 404 (the store refuses it under A's tenant scope).
    const cross = await app.request(`/api/evidence/${ids.b}`, { headers: { cookie: cookieA } });
    expect(cross.status).toBe(404);
    // A requesting a totally unknown id → 404. The two 404s are byte-identical (no existence oracle:
    // "is this id real but not mine?" is indistinguishable from "this id does not exist").
    const unknown = await app.request('/api/evidence/does-not-exist', {
      headers: { cookie: cookieA },
    });
    expect(unknown.status).toBe(404);
    expect(await cross.text()).toBe(await unknown.text());
  });

  it("tenant A's list never contains tenant B's manifests, even with both seeded", async () => {
    const store = createInMemoryEvidenceStore();
    await seed(store);
    const app = portal(store);
    const cookieA = await login(app, 'tok-a');
    const cookieB = await login(app, 'tok-b');

    const listA = (await (
      await app.request('/api/evidence', { headers: { cookie: cookieA } })
    ).json()) as {
      manifests: { tenantId?: string }[];
    };
    const listB = (await (
      await app.request('/api/evidence', { headers: { cookie: cookieB } })
    ).json()) as {
      manifests: { tenantId?: string }[];
    };
    expect(listA.manifests.every((m) => m.tenantId === 't-a')).toBe(true);
    expect(listB.manifests.every((m) => m.tenantId === 't-b')).toBe(true);
    // No id appears in both tenants' lists (disjoint).
    const idsA = new Set(listA.manifests.map((m) => (m as { bundleId: string }).bundleId));
    const idsB = listB.manifests.map((m) => (m as { bundleId: string }).bundleId);
    expect(idsB.some((id) => idsA.has(id))).toBe(false);
  });

  it('no route accepts a client tenantId — a ?tenantId param is ignored (scope is the session)', async () => {
    const store = createInMemoryEvidenceStore();
    await seed(store);
    const app = portal(store);
    const cookieA = await login(app, 'tok-a');
    // Attempt to widen scope to t-b via a query param: ignored — list is still only t-a's.
    const res = await app.request('/api/evidence?tenantId=t-b', { headers: { cookie: cookieA } });
    const { manifests } = (await res.json()) as { manifests: { tenantId?: string }[] };
    expect(manifests.every((m) => m.tenantId === 't-a')).toBe(true);
  });
});
