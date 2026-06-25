/**
 * E2E journey — tenant self-serve evidence via the portal (gap B2, journey 3).
 *
 * Unlike the unit-level `portal-evidence.test.ts` (which stubs the facade), this drives the REAL
 * portal HTTP sub-app wired to the REAL {@link createTenantForge} facade with a real evidence store
 * + Ed25519 signer. An active tenant logs in to the portal session and self-generates → lists →
 * downloads its OWN signed evidence bundle, then verifies it against the published public key — a
 * genuine cross-entrypoint (HTTP portal → facade → store → core verify) journey. Tenant scope is
 * server-derived from the portal session (never client-supplied).
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { journeyHarness } from './harness.js';
import { aProvisionedTenant } from './builders.js';
import { createPortal } from '../../src/app/portal.js';
import { verifyEvidenceBundle } from '../../src/core/evidence-bundle.js';
import type { TenantAuthenticator } from '../../src/ports/tenant-authenticator.js';
import type { SignedEvidenceBundle } from '../../src/core/evidence-bundle.js';
import type { JWK } from 'jose';

const SESSION_SECRET = 'portal-session-secret-for-e2e';
const NOW = 1_700_000_000_000;
const SESSION_EXP = NOW + 60 * 60 * 1000; // portal default 1h TTL

/** A portal token authenticator mapping `tok:<tenantId>` → that tenant (the journey's session map). */
const tokenAuth = (validTenantIds: Set<string>): TenantAuthenticator => ({
  authenticate: (token: string) => {
    const id = token.startsWith('tok:') ? token.slice(4) : '';
    return Promise.resolve(validTenantIds.has(id) ? { tenantId: id } : null);
  },
});

/** Log in to the portal and return the session cookie (just the `name=value` pair). */
async function login(app: ReturnType<typeof createPortal>, token: string): Promise<string> {
  const res = await app.request('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

/** The session-bound CSRF token a client reads from the portal (`tenantId.HMAC(csrf:{id}:{exp})`). */
function csrfFor(tenantId: string): string {
  const sig = createHmac('sha256', SESSION_SECRET)
    .update(`csrf:${tenantId}:${SESSION_EXP}`)
    .digest('base64url');
  return `${tenantId}.${sig}`;
}

describe('E2E journey: tenant self-serve evidence (portal → facade → core)', () => {
  it('an active tenant self-generates → lists → downloads its OWN bundle, and it verifies', async () => {
    const h = await journeyHarness();
    const { tenant } = await aProvisionedTenant(h, { slug: 'self-serve-co' });

    const app = createPortal({
      tf: h.tf,
      authenticator: tokenAuth(new Set([tenant.id])),
      sessionSecret: SESSION_SECRET,
      enableEvidence: true,
      now: () => NOW,
    });
    const cookie = await login(app, `tok:${tenant.id}`);

    // --- Self-generate MY current bundle (CSRF-protected, server-scoped to the session tenant). ---
    const gen = await app.request('/api/evidence/generate', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-tf-csrf': csrfFor(tenant.id),
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(gen.status).toBe(200);
    const { manifest } = (await gen.json()) as {
      manifest: { bundleId: string; tenantId?: string };
    };
    expect(manifest.tenantId).toBe(tenant.id);

    // --- List: only MY manifest appears (server-derived scope). ---
    const listRes = await app.request('/api/evidence', { headers: { cookie } });
    expect(listRes.status).toBe(200);
    const { manifests } = (await listRes.json()) as { manifests: { tenantId?: string }[] };
    expect(manifests.length).toBeGreaterThanOrEqual(1);
    expect(manifests.every((m) => m.tenantId === tenant.id)).toBe(true);

    // --- Download MY signed bundle + verify it offline with the published public key. ---
    const dl = await app.request(`/api/evidence/${manifest.bundleId}`, { headers: { cookie } });
    expect(dl.status).toBe(200);
    const signed = (await dl.json()) as SignedEvidenceBundle;
    expect(signed.bundle.tenantId).toBe(tenant.id);

    const pkRes = await app.request('/api/evidence/public-key', { headers: { cookie } });
    expect(pkRes.status).toBe(200);
    const { publicKey } = (await pkRes.json()) as { publicKey: JWK };
    expect(publicKey).not.toHaveProperty('d'); // public material only
    const verified = await verifyEvidenceBundle(signed.jws, publicKey);
    expect(verified.tenantId).toBe(tenant.id);
  });
});
