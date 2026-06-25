import { describe, expect, it, vi } from 'vitest';
import type { TenantRecord, TenantStatus } from '../../src/core/domain.js';
import type { TenantEvent } from '../../src/core/observability.js';
import type { ProvisioningProvider } from '../../src/ports/provisioning-provider.js';
import type { SecretStore } from '../../src/ports/secret-store.js';
import type { TenantExporter } from '../../src/ports/tenant-exporter.js';
import type { TenantRegistry } from '../../src/ports/tenant-registry.js';
import type { CertificateSigner } from '../../src/ports/certificate-signer.js';
import { createErasureEngine, type ErasureEngineDeps } from '../../src/adapters/erasure-engine.js';
import { createEphemeralCertificateSigner } from '../../src/adapters/certificate-signer.js';
import { verifyErasureCertificate } from '../../src/core/erasure-cert.js';

/** A deterministic stub signer (no crypto) for tests that only assert the certificate contents. */
const stubSigner: CertificateSigner = {
  sign: () => Promise.resolve('stub.jws.token'),
  publicKeyJwk: () => Promise.resolve({ kty: 'OKP', crv: 'Ed25519', x: 'stub' }),
};

function tenant(overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id: 't1',
    slug: 'acme',
    region: 'aws-eu-central-1',
    status: 'active',
    neonProjectId: 'proj-1',
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

/** Build a hermetic environment: in-memory registry + secret store, recording provisioning/exporter. */
function makeEnv(seed: TenantRecord, opts: { secretLingers?: boolean } = {}) {
  const record = { ...seed };
  const secrets = new Map<string, string>([[seed.id, 'postgres://secret']]);
  const deleted: string[] = [];
  const events: TenantEvent[] = [];

  const registry = {
    getById: (id: string) => Promise.resolve(id === record.id ? { ...record } : null),
    setStatus: (id: string, status: TenantStatus) => {
      if (id === record.id) record.status = status;
      return Promise.resolve();
    },
  } as unknown as TenantRegistry;

  const provisioning = {
    deleteTenantProject: (neonProjectId: string) => {
      deleted.push(neonProjectId);
      return Promise.resolve();
    },
  } as unknown as ProvisioningProvider;

  const secretStore: SecretStore = {
    get: (key: string) => Promise.resolve(secrets.get(key) ?? null),
    set: (key: string, value: string) => {
      secrets.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      // When `secretLingers`, simulate a backend that did not actually shred (verification fails).
      if (!opts.secretLingers) secrets.delete(key);
      return Promise.resolve();
    },
  };

  return { record, secrets, deleted, events, registry, provisioning, secretStore };
}

const fixedNow = (): Date => new Date('2026-06-18T00:00:00.000Z');

describe('createErasureEngine.erase', () => {
  it('exports, deletes the project, shreds the secret, marks deleted, certifies, and signs', async () => {
    const env = makeEnv(tenant());
    const exporter: TenantExporter = {
      exportTenant: () => Promise.resolve({ location: 's3://exports/t1.dump', bytes: 10 }),
    };
    const deps: ErasureEngineDeps = {
      registry: env.registry,
      provisioning: env.provisioning,
      secretStore: env.secretStore,
      signer: stubSigner,
      exporter,
      emit: (e) => env.events.push(e),
      now: fixedNow,
    };
    const signed = await createErasureEngine(deps).erase('t1', { reason: 'GDPR Art.17 #42' });

    expect(signed.certificate).toEqual({
      tenantId: 't1',
      slug: 'acme',
      reason: 'GDPR Art.17 #42',
      erasedAt: '2026-06-18T00:00:00.000Z',
      exported: true,
      exportLocation: 's3://exports/t1.dump',
      projectDeleted: true,
      verification: { secretShredded: true, statusDeleted: true },
      verified: true,
    });
    expect(signed.jws).toBe('stub.jws.token');
    expect(env.deleted).toEqual(['proj-1']);
    expect(env.secrets.has('t1')).toBe(false);
    expect(env.record.status).toBe('deleted');
    expect(env.events).toEqual([
      {
        event: 'tenant.erased',
        at: '2026-06-18T00:00:00.000Z',
        outcome: 'ok',
        tenantId: 't1',
        context: {
          reason: 'GDPR Art.17 #42',
          exported: true,
          projectDeleted: true,
          verified: true,
          signed: true,
        },
      },
    ]);
  });

  it('produces a JWS that verifies against the signer public key (real Ed25519 round-trip)', async () => {
    const env = makeEnv(tenant());
    const signer = await createEphemeralCertificateSigner();
    const signed = await createErasureEngine({
      registry: env.registry,
      provisioning: env.provisioning,
      secretStore: env.secretStore,
      signer,
      now: fixedNow,
    }).erase('t1', { reason: 'GDPR Art.17 #99' });
    expect(signed.jws).toBeDefined();
    const verified = await verifyErasureCertificate(signed.jws!, await signer.publicKeyJwk());
    expect(verified).toEqual(signed.certificate);
  });

  it('throws when the tenant does not exist', async () => {
    const env = makeEnv(tenant());
    const engine = createErasureEngine({
      registry: env.registry,
      provisioning: env.provisioning,
      secretStore: env.secretStore,
      signer: stubSigner,
    });
    await expect(engine.erase('ghost', { reason: 'x' })).rejects.toThrow(/tenant not found: ghost/);
  });

  it('skips export by default when no exporter is configured', async () => {
    const env = makeEnv(tenant());
    const { certificate } = await createErasureEngine({
      registry: env.registry,
      provisioning: env.provisioning,
      secretStore: env.secretStore,
      signer: stubSigner,
      now: fixedNow,
    }).erase('t1', { reason: 'r' });
    expect(certificate.exported).toBe(false);
    expect(certificate.exportLocation).toBeUndefined();
    expect(certificate.verified).toBe(true);
  });

  it('skips export when explicitly disabled even if an exporter is present', async () => {
    const env = makeEnv(tenant());
    const exportTenant = vi.fn();
    const exporter: TenantExporter = { exportTenant };
    const { certificate } = await createErasureEngine({
      registry: env.registry,
      provisioning: env.provisioning,
      secretStore: env.secretStore,
      signer: stubSigner,
      exporter,
      now: fixedNow,
    }).erase('t1', { reason: 'r', export: false });
    expect(certificate.exported).toBe(false);
    expect(exportTenant).not.toHaveBeenCalled();
  });

  it('fails closed when export is requested but no exporter is configured', async () => {
    const env = makeEnv(tenant());
    const engine = createErasureEngine({
      registry: env.registry,
      provisioning: env.provisioning,
      secretStore: env.secretStore,
      signer: stubSigner,
    });
    await expect(engine.erase('t1', { reason: 'r', export: true })).rejects.toThrow(
      /export requested but no exporter is configured/,
    );
  });

  it('does not delete a project for a never-provisioned tenant', async () => {
    const env = makeEnv(tenant({ neonProjectId: null }));
    const { certificate } = await createErasureEngine({
      registry: env.registry,
      provisioning: env.provisioning,
      secretStore: env.secretStore,
      signer: stubSigner,
      now: fixedNow,
    }).erase('t1', { reason: 'r' });
    expect(env.deleted).toEqual([]);
    expect(certificate.projectDeleted).toBe(false);
    expect(certificate.verified).toBe(true);
  });

  it('certifies verified=false (error outcome) when the secret was not shredded', async () => {
    const env = makeEnv(tenant(), { secretLingers: true });
    const { certificate } = await createErasureEngine({
      registry: env.registry,
      provisioning: env.provisioning,
      secretStore: env.secretStore,
      signer: stubSigner,
      emit: (e) => env.events.push(e),
      now: fixedNow,
    }).erase('t1', { reason: 'r' });

    expect(certificate.verification).toEqual({ secretShredded: false, statusDeleted: true });
    expect(certificate.verified).toBe(false);
    expect(env.events[0]!.outcome).toBe('error');
  });

  it('works without an emit sink (audit is optional)', async () => {
    const env = makeEnv(tenant());
    const { certificate } = await createErasureEngine({
      registry: env.registry,
      provisioning: env.provisioning,
      secretStore: env.secretStore,
      signer: stubSigner,
      now: fixedNow,
    }).erase('t1', { reason: 'r' });
    expect(certificate.verified).toBe(true);
  });

  it('uses a real clock by default (erasedAt is an ISO-8601 instant)', async () => {
    const env = makeEnv(tenant());
    const { certificate } = await createErasureEngine({
      registry: env.registry,
      provisioning: env.provisioning,
      secretStore: env.secretStore,
      signer: stubSigner,
    }).erase('t1', { reason: 'r' });
    expect(certificate.erasedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('fails soft when signing throws AFTER erasure — data stays erased, cert is unsigned, operator alerted', async () => {
    const env = makeEnv(tenant());
    const alerts: string[] = [];
    const failingSigner: CertificateSigner = {
      sign: () => Promise.reject(new Error('KMS unavailable')),
      publicKeyJwk: () => Promise.resolve({ kty: 'OKP', crv: 'Ed25519', x: 'stub' }),
    };
    const signed = await createErasureEngine({
      registry: env.registry,
      provisioning: env.provisioning,
      secretStore: env.secretStore,
      signer: failingSigner,
      emit: (e) => env.events.push(e),
      alertOperator: (m) => {
        alerts.push(m);
      },
      now: fixedNow,
    }).erase('t1', { reason: 'r' });

    // The destruction still happened (never rolled back) and the certificate is returned UNSIGNED.
    expect(env.deleted).toEqual(['proj-1']);
    expect(env.secrets.has('t1')).toBe(false);
    expect(env.record.status).toBe('deleted');
    expect(signed.jws).toBeUndefined();
    expect(signed.certificate.verified).toBe(true);
    // Degraded to an error outcome with signError recorded; operator alerted.
    expect(env.events[0]!.outcome).toBe('error');
    expect((env.events[0]!.context as Record<string, unknown>).signed).toBe(false);
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toMatch(/signing FAILED/i);
  });

  it('a failing operator alert never throws on the completed-but-unsigned erasure path', async () => {
    const env = makeEnv(tenant());
    const failingSigner: CertificateSigner = {
      sign: () => Promise.reject(new Error('signing down')),
      publicKeyJwk: () => Promise.resolve({ kty: 'OKP', crv: 'Ed25519', x: 'stub' }),
    };
    const signed = await createErasureEngine({
      registry: env.registry,
      provisioning: env.provisioning,
      secretStore: env.secretStore,
      signer: failingSigner,
      alertOperator: () => {
        throw new Error('alert sink down');
      },
      now: fixedNow,
    }).erase('t1', { reason: 'r' });
    expect(signed.jws).toBeUndefined();
    expect(env.record.status).toBe('deleted');
  });
});
