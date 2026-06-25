/**
 * E2E journey — full operator tenant lifecycle + evidence layer (gap B2, journey 1).
 *
 * Drives the whole stack through the facade: provision → reveal connection (one-time operator
 * hand-off) → a usage/billing touch → suspend → resume → offboard (export) → purge → verify the
 * **signed erasure-equivalent** path → produce + verify a **signed compliance report** and a
 * **per-tenant signed evidence bundle**, then operator-retrieve the persisted bundle. Asserts
 * observable outcomes (returned state, emitted audit events, verifiable Ed25519 signatures) — not
 * implementation — so refactors don't break it. Hermetic: in-memory stack, deterministic ids,
 * injected clock for the retention window.
 */
import { describe, expect, it } from 'vitest';
import { journeyHarness, monthPeriod, days } from './harness.js';
import { aProvisionedTenant } from './builders.js';
import { verifyErasureCertificate } from '../../src/core/erasure-cert.js';
import { verifyComplianceReport } from '../../src/core/compliance-cert.js';
import { verifyEvidenceBundle } from '../../src/core/evidence-bundle.js';

describe('E2E journey: operator tenant lifecycle (happy path)', () => {
  it('provision → use → suspend → resume → offboard → purge, with a verifiable erasure-style proof', async () => {
    const h = await journeyHarness({ retentionDays: 30 });

    // --- Provision: a fresh active tenant with its one-time connection secret. ---
    const { tenant, connectionUri } = await aProvisionedTenant(h, { slug: 'acme-co' });
    expect(tenant.slug).toBe('acme-co');
    expect(connectionUri).toMatch(/^postgresql:\/\//);
    // The secret is stored under the tenant id and resolvable server-side (BOLA: by derived id only).
    const resolved = await h.tf.getConnection(tenant.id);
    expect(resolved.tenantId).toBe(tenant.id);
    expect(resolved.connectionUri).toBe(connectionUri);

    // --- A usage/billing touch: metering resolves the project + aggregates consumption. ---
    const usage = await h.tf.usage(tenant.id, monthPeriod(h.clock));
    expect(usage.tenantId).toBe(tenant.id);
    expect(usage.consumption.computeTimeSeconds).toBeGreaterThan(0);

    // --- Suspend → resume (reversible lifecycle). A suspended tenant is NOT routable (fail closed). ---
    const suspended = await h.tf.suspend(tenant.id);
    expect(suspended.status).toBe('suspended');
    await expect(h.tf.getConnection(tenant.id)).rejects.toThrow(/not routable/);
    const resumed = await h.tf.resume(tenant.id);
    expect(resumed.status).toBe('active');
    await expect(h.tf.getConnection(tenant.id)).resolves.toMatchObject({ tenantId: tenant.id });

    // --- Offboard (archive + export): reversible until purge; the project is retained. ---
    const off = await h.tf.offboard(tenant.id);
    expect(off.tenant.status).toBe('offboarding');
    expect(off.archive?.location).toContain(tenant.id);
    // Before the retention window elapses, the tenant is NOT yet purge-eligible.
    const reportBefore = await h.tf.retentionReport({ now: h.clock.now() });
    const rowBefore = reportBefore.tenants.find((r) => r.tenantId === tenant.id);
    expect(rowBefore?.eligible).toBe(false);

    // --- Purge after the window: irreversible delete + crypto-shred of the connection secret. ---
    h.clock.advance(days(31));
    const sweep = await h.tf.purgeExpired({ now: h.clock.now() });
    expect(sweep.purged).toContain(tenant.id);
    // Observable outcomes: the Neon project was deleted and the secret is gone (shredded).
    expect(h.provisioning.deletes).toContain(off.tenant.neonProjectId);
    expect(await h.secretStore.get(tenant.id)).toBeNull();
    const purged = await h.tf.getTenant(tenant.id);
    expect(purged?.status).toBe('deleted');

    // The audit trail recorded the lifecycle transitions (observable, redacted — never the secret).
    const emitted = new Set(h.events.map((e) => e.event));
    expect(emitted.has('tenant.provisioned')).toBe(true);
    expect(emitted.has('tenant.purge_sweep')).toBe(true);
    // The deletion transition (offboarding → deleted) was recorded for this tenant.
    expect(
      h.events.some(
        (e) =>
          e.event === 'tenant.transition' &&
          e.tenantId === tenant.id &&
          (e.context as { to?: string } | undefined)?.to === 'deleted',
      ),
    ).toBe(true);
    expect(JSON.stringify(h.events)).not.toContain(connectionUri); // secret never logged
  });

  it('erases a tenant from any state and the certificate verifies against the published public key', async () => {
    const h = await journeyHarness();
    const { tenant } = await aProvisionedTenant(h, { slug: 'erase-me' });

    // Right-to-erasure (GDPR Art. 17): final export + delete + shred + verify + SIGN.
    const signed = await h.tf.erase(tenant.id, { reason: 'gdpr-art17', export: true });
    expect(signed.certificate.verified).toBe(true);
    expect(signed.certificate.tenantId).toBe(tenant.id);
    expect(signed.jws).toBeDefined(); // present on the happy path (signing succeeded)

    // An auditor verifies the certificate offline with ONLY the published public key.
    const pub = await h.tf.erasureCertificatePublicKey();
    expect(pub).not.toBeNull();
    const verified = await verifyErasureCertificate(signed.jws!, pub!);
    expect(verified.tenantId).toBe(tenant.id);
    expect(verified.reason).toBe('gdpr-art17');

    // The data is genuinely gone: project deleted, secret shredded, record deleted.
    expect(h.provisioning.deletes.length).toBeGreaterThan(0);
    expect(await h.secretStore.get(tenant.id)).toBeNull();
    expect((await h.tf.getTenant(tenant.id))?.status).toBe('deleted');
  });

  it('produces a signed compliance report + per-tenant evidence bundle, both verifiable; the bundle is persisted + retrievable', async () => {
    const h = await journeyHarness();
    const { tenant } = await aProvisionedTenant(h, { slug: 'auditable-co' });

    // --- Signed fleet compliance report: verifies against its published public key. ---
    const report = await h.tf.signedComplianceReport();
    expect(report.digest).toMatch(/^[0-9a-f]{64}$/);
    const reportPub = await h.tf.complianceReportPublicKey();
    expect(reportPub).not.toBeNull();
    const verifiedReport = await verifyComplianceReport(report.jws, reportPub!);
    expect(verifiedReport.inventory.byStatus.active).toBeGreaterThanOrEqual(1);

    // --- Per-tenant signed evidence bundle: scoped to ONE server-derived tenant, verifies, persists. ---
    const bundle = await h.tf.evidenceBundle({ scope: 'tenant', tenantId: tenant.id });
    expect(bundle.bundle.scope).toBe('tenant');
    expect(bundle.bundle.tenantId).toBe(tenant.id);
    expect(bundle.manifest).toBeDefined(); // persisted (an evidence store is wired)
    const bundlePub = await h.tf.evidenceBundlePublicKey();
    const verifiedBundle = await verifyEvidenceBundle(bundle.jws, bundlePub!);
    expect(verifiedBundle.tenantId).toBe(tenant.id);

    // --- Operator retrieval (fleet scope = null): the persisted bundle round-trips by id. ---
    const fetched = await h.tf.evidenceGet(bundle.manifest!.bundleId, null);
    expect(fetched?.bundle.tenantId).toBe(tenant.id);
    expect(fetched?.jws).toBe(bundle.jws);
    // It also lists for the operator (fleet-wide, facts only).
    const manifests = await h.tf.evidenceList();
    expect(manifests.some((m) => m.bundleId === bundle.manifest!.bundleId)).toBe(true);
  });
});
