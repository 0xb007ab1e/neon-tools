/**
 * E2E journey — abuse / negative paths (gap B2, journey 4; master §4 security tests).
 *
 * Asserts the fail-closed / deny-by-default invariants end to end across the stack:
 *  - cross-tenant connection access is denied (BOLA — tenant A can never reach tenant B's secret),
 *  - cross-tenant evidence access is denied (the store-level BOLA guard via the facade),
 *  - the one-time signup reveal cannot be replayed after it has fired,
 *  - routing fails closed for a non-active tenant (suspended / offboarding / unprovisioned),
 *  - purge requires the `tenant:purge` permission AND an explicit `confirm` (HTTP role gate —
 *    an `operator` role cannot purge; a missing `confirm` is rejected).
 *
 * These are the security invariants that, if broken, are critical incidents — so they are tested
 * as observable, end-to-end denials.
 */
import { describe, expect, it } from 'vitest';
import { journeyHarness } from './harness.js';
import { aProvisionedTenant, twoTenants, anActiveSignup } from './builders.js';
import { createHttpServer } from '../../src/app/http-server.js';

describe('E2E abuse journey: cross-tenant isolation (BOLA)', () => {
  it("connection resolution returns ONLY the requested tenant's secret — never another tenant's", async () => {
    const h = await journeyHarness();
    const { a, b } = await twoTenants(h);

    // Each tenant resolves to its OWN distinct connection secret (no bleed).
    const connA = await h.tf.getConnection(a.tenant.id);
    const connB = await h.tf.getConnection(b.tenant.id);
    expect(connA.connectionUri).toBe(a.connectionUri);
    expect(connB.connectionUri).toBe(b.connectionUri);
    expect(connA.connectionUri).not.toBe(connB.connectionUri);

    // A server-derived id is the ONLY input; there is no client-supplied tenant override path. A
    // bogus/unknown id fails closed (no fallthrough to any tenant's secret).
    await expect(h.tf.getConnection('tenant-does-not-exist')).rejects.toThrow(/not found/);
  });

  it("tenant A cannot fetch tenant B's evidence bundle (store-level tenant-scope guard)", async () => {
    const h = await journeyHarness();
    const { a, b } = await twoTenants(h);

    // Operator persists a per-tenant bundle for each tenant.
    const bundleA = await h.tf.evidenceBundle({ scope: 'tenant', tenantId: a.tenant.id });
    const bundleB = await h.tf.evidenceBundle({ scope: 'tenant', tenantId: b.tenant.id });
    const idA = bundleA.manifest!.bundleId;
    const idB = bundleB.manifest!.bundleId;

    // Under tenant A's scope: A's own bundle resolves; B's real bundle id is refused (null), exactly
    // like an unknown id — no existence oracle, no cross-tenant leak.
    expect(await h.tf.evidenceGet(idA, a.tenant.id)).not.toBeNull();
    expect(await h.tf.evidenceGet(idB, a.tenant.id)).toBeNull();
    expect(await h.tf.evidenceGet('totally-unknown', a.tenant.id)).toBeNull();

    // A's scoped list never contains B's manifest.
    const listA = await h.tf.evidenceList({ tenantId: a.tenant.id });
    expect(listA.every((m) => m.tenantId === a.tenant.id)).toBe(true);
    expect(listA.some((m) => m.bundleId === idB)).toBe(false);
  });
});

describe('E2E abuse journey: one-time reveal cannot be replayed', () => {
  it('the signup connection reveal fires once then is permanently denied', async () => {
    const h = await journeyHarness();
    const { signupId } = await anActiveSignup(h, { slug: 'reveal-once' });
    await h.drainQueue(); // worker provisions → active

    const first = await h.tf.signupStatus(signupId);
    expect(first.connectionUri).toMatch(/^postgresql:\/\//); // revealed exactly once
    const replay1 = await h.tf.signupStatus(signupId);
    const replay2 = await h.tf.signupStatus(signupId);
    expect(replay1.connectionUri).toBeUndefined(); // gate closed
    expect(replay2.connectionUri).toBeUndefined(); // and stays closed
  });
});

describe('E2E abuse journey: routing fails closed for non-active tenants', () => {
  it('a suspended tenant is not routable', async () => {
    const h = await journeyHarness();
    const { tenant } = await aProvisionedTenant(h, { slug: 'suspended-co' });
    await h.tf.suspend(tenant.id);
    await expect(h.tf.getConnection(tenant.id)).rejects.toThrow(/not routable/);
  });

  it('an offboarding tenant is not routable', async () => {
    const h = await journeyHarness();
    const { tenant } = await aProvisionedTenant(h, { slug: 'offboarding-co' });
    await h.tf.offboard(tenant.id);
    await expect(h.tf.getConnection(tenant.id)).rejects.toThrow(/not routable/);
  });

  it('a tenant whose connection secret was never set is denied (fail closed)', async () => {
    const h = await journeyHarness();
    // Seed an active+provisioned tenant with NO stored secret (a corrupt/partial state).
    h.registry.seed({
      id: 'tenant-orphan',
      slug: 'orphan',
      region: 'aws-us-east-1',
      status: 'active',
      neonProjectId: 'proj-orphan',
      metadata: {},
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    });
    await expect(h.tf.getConnection('tenant-orphan')).rejects.toThrow(
      /no stored connection secret/,
    );
  });
});

describe('E2E abuse journey: purge requires admin role + explicit confirm (HTTP role gate)', () => {
  /** Build the HTTP control plane over the harness facade with two credentialled roles. */
  const httpOver = (h: Awaited<ReturnType<typeof journeyHarness>>) =>
    createHttpServer(h.tf, {
      credentials: [
        { id: 'admin-1', token: 'admin-token', role: 'admin' },
        { id: 'op-1', token: 'operator-token', role: 'operator' },
      ],
    });
  const purge = async (
    app: ReturnType<typeof createHttpServer>,
    id: string,
    token: string,
    body: unknown,
  ): Promise<Response> =>
    app.request(`/v1/tenants/${id}/purge`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('an operator (no tenant:purge permission) is forbidden (403) — purge is admin-only', async () => {
    const h = await journeyHarness();
    const t = await anOffboardedForPurge(h);
    const res = await purge(httpOver(h), t, 'operator-token', { confirm: true });
    expect(res.status).toBe(403);
    // The tenant was NOT purged (still offboarding, project retained).
    expect((await h.tf.getTenant(t))?.status).toBe('offboarding');
  });

  it('an admin without the explicit confirm:true is rejected (400) — destructive op needs confirmation', async () => {
    const h = await journeyHarness();
    const t = await anOffboardedForPurge(h);
    const res = await purge(httpOver(h), t, 'admin-token', {});
    expect(res.status).toBe(400);
    expect((await h.tf.getTenant(t))?.status).toBe('offboarding');
  });

  it('an admin WITH confirm:true succeeds (200) and the tenant is purged', async () => {
    const h = await journeyHarness();
    const t = await anOffboardedForPurge(h);
    const res = await purge(httpOver(h), t, 'admin-token', { confirm: true });
    expect(res.status).toBe(200);
    expect((await h.tf.getTenant(t))?.status).toBe('deleted');
  });
});

/** Arrange an offboarding tenant id ready to be (attempted to be) purged. */
async function anOffboardedForPurge(
  h: Awaited<ReturnType<typeof journeyHarness>>,
): Promise<string> {
  const { tenant } = await aProvisionedTenant(h, { slug: 'purge-target' });
  await h.tf.offboard(tenant.id);
  return tenant.id;
}
