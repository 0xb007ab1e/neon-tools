import { beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject, TenantRecord, TenantStatus } from '../../src/core/domain.js';
import type { NewTenant, TenantRegistry } from '../../src/ports/tenant-registry.js';
import type { ProvisioningProvider } from '../../src/ports/provisioning-provider.js';
import type { PaymentSetup } from '../../src/ports/payment-setup.js';
import type { Notifier, Notification } from '../../src/ports/notifier.js';
import type { TenantExporter } from '../../src/ports/tenant-exporter.js';
import { createInMemorySecretStore } from '../../src/adapters/secret-store.js';
import { createInMemoryOneTimeCodeStore } from '../../src/adapters/one-time-code-store.js';
import { createInMemoryPendingErasureStore } from '../../src/adapters/pending-erasure-store.js';
import type { CertificateSigner } from '../../src/ports/certificate-signer.js';
import { createTenantForge, type TenantForge, type TenantForgeDeps } from '../../src/app/lib.js';

/**
 * A deterministic stub certificate signer (no real crypto) — these facade tests assert the
 * always-signed wiring + certificate contents, not the EdDSA round-trip (that lives in the core /
 * adapter suites). Erasure is always-signed, so every erasure path must be given a signer.
 */
const stubSigner: CertificateSigner = {
  sign: () => Promise.resolve('stub.jws.token'),
  publicKeyJwk: () => Promise.resolve({ kty: 'OKP', crv: 'Ed25519', x: 'stub' }),
};

/** Minimal TenantRegistry fake supporting the portal self-serve paths. */
function fakeRegistry(): TenantRegistry & {
  seed(r: Partial<TenantRecord> & { id: string }): void;
} {
  const byId = new Map<string, TenantRecord>();
  const clone = (r: TenantRecord): TenantRecord => ({ ...r, metadata: { ...r.metadata } });
  const stub = () => Promise.resolve();
  return {
    seed: (r) =>
      void byId.set(r.id, {
        id: r.id,
        slug: r.slug ?? r.id,
        region: r.region ?? 'aws-us-east-1',
        status: r.status ?? 'active',
        neonProjectId: r.neonProjectId ?? 'proj-1',
        metadata: (r.metadata as JsonObject) ?? {},
        createdAt: r.createdAt ?? new Date(0),
        updatedAt: r.updatedAt ?? new Date(0),
      }),
    create(t: NewTenant) {
      const record: TenantRecord = {
        id: `tenant-x`,
        slug: t.slug,
        region: t.region,
        status: 'provisioning',
        neonProjectId: null,
        metadata: (t.metadata as JsonObject) ?? {},
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
      byId.set(record.id, record);
      return Promise.resolve(clone(record));
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
    attachProject: stub,
    setStatus: (id, status) => {
      const r = byId.get(id);
      if (r) {
        r.status = status;
        r.updatedAt = new Date(1_000_000);
      }
      return Promise.resolve();
    },
    updateMetadata: (id, patch) => {
      const r = byId.get(id);
      if (r) r.metadata = { ...r.metadata, ...patch };
      return Promise.resolve();
    },
    relocate: stub,
    registerMigration: (m: { version: string; checksum: string }) =>
      Promise.resolve({ id: 'm1', version: m.version, checksum: m.checksum }),
    listMigrations: () => Promise.resolve([]),
    listTenantMigrationStates: () => Promise.resolve([]),
    recordTenantMigration: stub,
    migrate: stub,
    ping: stub,
    close: stub,
  };
}

function fakeProvisioning(): ProvisioningProvider & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    createTenantProject: () =>
      Promise.resolve({ neonProjectId: 'proj-1', connectionUri: 'postgresql://s@h/db' }),
    deleteTenantProject: (pid: string) => {
      deleted.push(pid);
      return Promise.resolve();
    },
    rotateTenantCredential: () => Promise.resolve({ connectionUri: 'postgresql://r@h/db' }),
  };
}

/** PaymentSetup fake whose setup-intent returns a controllable customer + status. */
function fakePaymentSetup(intent: {
  status?: 'succeeded' | 'requires_action';
  customerRef?: string;
  paymentMethodRef?: string;
  /** When true, the PSP set-default call throws (to assert the facade fails closed). */
  setDefaultThrows?: boolean;
}): PaymentSetup & {
  lastSetupIntentReq?: { customerRef: string };
  setDefaultCalls: { customerRef: string; paymentMethodRef: string }[];
} {
  const self: PaymentSetup & {
    lastSetupIntentReq?: { customerRef: string };
    setDefaultCalls: { customerRef: string; paymentMethodRef: string }[];
  } = {
    provider: 'fake',
    setDefaultCalls: [],
    createCustomer: () => Promise.resolve({ customerRef: 'cus_new', provider: 'fake' }),
    createSetupIntent: (req) => {
      self.lastSetupIntentReq = { customerRef: req.customerRef };
      return Promise.resolve({
        setupIntentId: 'seti_1',
        clientSecret: 'seti_1_secret',
        provider: 'fake',
      });
    },
    getSetupIntent: () =>
      Promise.resolve({
        status: intent.status ?? 'succeeded',
        customerRef: intent.customerRef ?? 'cus_a',
        ...(intent.status !== 'requires_action'
          ? { paymentMethodRef: intent.paymentMethodRef ?? 'pm_1' }
          : {}),
        provider: 'fake',
      }),
    setDefaultPaymentMethod: (customerRef, paymentMethodRef) => {
      if (intent.setDefaultThrows === true) {
        return Promise.reject(new Error('stripe set default payment method failed (502)'));
      }
      self.setDefaultCalls.push({ customerRef, paymentMethodRef });
      return Promise.resolve();
    },
  };
  return self;
}

function fakeExporter(): TenantExporter {
  return { exportTenant: () => Promise.resolve({ location: 'archive://t', bytes: 42 }) };
}

function fakeNotifier(): Notifier & { sent: Notification[] } {
  const sent: Notification[] = [];
  return {
    provider: 'fake',
    sent,
    notify: (n) => {
      sent.push(n);
      return Promise.resolve({ id: 'n1', provider: 'fake', status: 'sent' as const });
    },
  };
}

function codeFrom(notifier: { sent: Notification[] }): string {
  const body = notifier.sent[notifier.sent.length - 1]!.body;
  return /\b(\d{6})\b/.exec(body)![1]!;
}

describe('portal self-serve facade — payment method (F5)', () => {
  let registry: ReturnType<typeof fakeRegistry>;
  const build = (over: Partial<TenantForgeDeps> = {}): TenantForge =>
    createTenantForge({
      registry,
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      allowedRegions: ['aws-us-east-1'],
      ...over,
    });

  beforeEach(() => {
    registry = fakeRegistry();
  });

  it('tenantPaymentSetup mints an intent for the tenant’s OWN customerRef', async () => {
    registry.seed({ id: 't-a', metadata: { billingCustomerRef: 'cus_a' } });
    const ps = fakePaymentSetup({ customerRef: 'cus_a' });
    const tf = build({ paymentSetup: ps });
    const setup = await tf.tenantPaymentSetup('t-a');
    expect(setup.setupIntentId).toBe('seti_1');
    expect(ps.lastSetupIntentReq?.customerRef).toBe('cus_a'); // never another tenant's customer
  });

  it('tenantPaymentSetup fails closed when the tenant has no billing customer (F5)', async () => {
    registry.seed({ id: 't-a', metadata: {} });
    const tf = build({ paymentSetup: fakePaymentSetup({}) });
    await expect(tf.tenantPaymentSetup('t-a')).rejects.toThrow(/no billing customer/);
  });

  it('confirmTenantPaymentMethod rejects a SetupIntent for a DIFFERENT customer (PSP-side BOLA — F5)', async () => {
    registry.seed({ id: 't-a', metadata: { billingCustomerRef: 'cus_a' } });
    // The intent belongs to cus_other, not the tenant's cus_a → mismatch, fail closed.
    const ps = fakePaymentSetup({ customerRef: 'cus_other' });
    const tf = build({ paymentSetup: ps });
    await expect(tf.confirmTenantPaymentMethod('t-a', 'seti_1')).rejects.toThrow(
      /payment\/customer mismatch/,
    );
    // Never set a default for the wrong customer, and never claim a local default.
    expect(ps.setDefaultCalls).toHaveLength(0);
    expect((await registry.getById('t-a'))!.metadata['defaultPaymentMethodRef']).toBeUndefined();
  });

  it('confirmTenantPaymentMethod rejects an unconfirmed intent (never trust the client)', async () => {
    registry.seed({ id: 't-a', metadata: { billingCustomerRef: 'cus_a' } });
    const ps = fakePaymentSetup({ status: 'requires_action' });
    const tf = build({ paymentSetup: ps });
    await expect(tf.confirmTenantPaymentMethod('t-a', 'seti_1')).rejects.toThrow(/not confirmed/);
    expect(ps.setDefaultCalls).toHaveLength(0); // no set-default on an unverified method
  });

  it('confirmTenantPaymentMethod fails closed when there is no billing customer', async () => {
    registry.seed({ id: 't-a', metadata: {} });
    const ps = fakePaymentSetup({ customerRef: 'cus_a' });
    const tf = build({ paymentSetup: ps });
    await expect(tf.confirmTenantPaymentMethod('t-a', 'seti_1')).rejects.toThrow(
      /no billing customer/,
    );
    expect(ps.setDefaultCalls).toHaveLength(0);
  });

  it('confirmTenantPaymentMethod sets the PSP default on the tenant’s OWN customer with the verified PM', async () => {
    registry.seed({ id: 't-a', metadata: { billingCustomerRef: 'cus_a' } });
    const ps = fakePaymentSetup({ customerRef: 'cus_a', paymentMethodRef: 'pm_99' });
    const tf = build({ paymentSetup: ps });
    const res = await tf.confirmTenantPaymentMethod('t-a', 'seti_1');
    expect(res).toMatchObject({ tenantId: 't-a', hasDefault: true });
    // The PSP set-default WAS invoked with the verified PM on the tenant's own customer (M1).
    expect(ps.setDefaultCalls).toEqual([{ customerRef: 'cus_a', paymentMethodRef: 'pm_99' }]);
    // The local mirror was written only after the PSP default succeeded.
    expect((await registry.getById('t-a'))!.metadata['defaultPaymentMethodRef']).toBe('pm_99');
  });

  it('confirmTenantPaymentMethod fails closed when the PSP set-default throws (no success, no local write)', async () => {
    registry.seed({ id: 't-a', metadata: { billingCustomerRef: 'cus_a' } });
    const ps = fakePaymentSetup({ customerRef: 'cus_a', setDefaultThrows: true });
    const tf = build({ paymentSetup: ps });
    await expect(tf.confirmTenantPaymentMethod('t-a', 'seti_1')).rejects.toThrow(/set default/);
    // Did NOT report success → must NOT have written the local default (would falsely claim updated).
    expect((await registry.getById('t-a'))!.metadata['defaultPaymentMethodRef']).toBeUndefined();
  });
});

describe('portal self-serve facade — step-up (F1)', () => {
  let registry: ReturnType<typeof fakeRegistry>;
  let notifier: ReturnType<typeof fakeNotifier>;
  const build = (): TenantForge =>
    createTenantForge({
      registry,
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      allowedRegions: ['aws-us-east-1'],
      notifier,
      oneTimeCodeStore: createInMemoryOneTimeCodeStore(),
    });

  beforeEach(() => {
    registry = fakeRegistry();
    notifier = fakeNotifier();
  });

  it('requests a code (emailed) and verifies it exactly once, bound to the action', async () => {
    registry.seed({ id: 't-a', metadata: { billingEmail: 'a@example.com' } });
    const tf = build();
    await tf.requestTenantStepUp('t-a', 'cancel');
    const code = codeFrom(notifier);
    // Wrong action does NOT verify.
    expect(await tf.verifyTenantStepUp('t-a', 'erasure', code)).toBe(false);
    // Correct action verifies, single-use.
    expect(await tf.verifyTenantStepUp('t-a', 'cancel', code)).toBe(true);
    expect(await tf.verifyTenantStepUp('t-a', 'cancel', code)).toBe(false);
  });

  it('an incorrect code never verifies (bypass blocked)', async () => {
    registry.seed({ id: 't-a', metadata: { billingEmail: 'a@example.com' } });
    const tf = build();
    await tf.requestTenantStepUp('t-a', 'cancel');
    expect(await tf.verifyTenantStepUp('t-a', 'cancel', '000000')).toBe(false);
  });

  it('fails closed requesting step-up with no email on file', async () => {
    registry.seed({ id: 't-a', metadata: {} });
    const tf = build();
    await expect(tf.requestTenantStepUp('t-a', 'cancel')).rejects.toThrow(/no verified email/);
  });
});

describe('portal self-serve facade — cancel billing exclusion (F3c)', () => {
  it('a cancelled (offboarding) tenant is excluded from the active-tenant set sweeps use', async () => {
    const registry = fakeRegistry();
    registry.seed({ id: 't-a', metadata: { billingCustomerRef: 'cus_a' } });
    const tf = createTenantForge({
      registry,
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      allowedRegions: ['aws-us-east-1'],
      retentionDays: 30,
    });
    const result = await tf.cancelTenant('t-a');
    expect(result.status).toBe('offboarding');
    expect(result.reversibleUntil).toBeTypeOf('string');
    // Billing/dunning sweeps list active tenants — the cancelled tenant must not appear.
    const active = await registry.list({ status: 'active' });
    expect(active.find((t) => t.id === 't-a')).toBeUndefined();
  });
});

describe('portal self-serve facade — erasure undo window (F2)', () => {
  const seedTf = (over: Partial<TenantForgeDeps> = {}) => {
    const registry = fakeRegistry();
    registry.seed({ id: 't-a' });
    const provisioning = fakeProvisioning();
    const store = createInMemoryPendingErasureStore();
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      allowedRegions: ['aws-us-east-1'],
      exporter: fakeExporter(),
      pendingErasureStore: store,
      certificateSigner: stubSigner,
      erasureUndoWindowMs: 0, // zero window so executeAt = now → immediately due for the execute path
      ...over,
    });
    return { tf, registry, provisioning, store };
  };

  it('requestTenantErasure SCHEDULES (does not delete) and the tenant keeps serving', async () => {
    const { tf, registry, provisioning } = seedTf();
    const res = await tf.requestTenantErasure('t-a', 'r');
    expect(res.status).toBe('pending');
    // Nothing deleted synchronously; the tenant record is intact (still serving).
    expect(provisioning.deleted).toHaveLength(0);
    expect(await registry.getById('t-a')).not.toBeNull();
    expect((await tf.pendingErasure('t-a'))?.status).toBe('pending');
  });

  it('cancel BEFORE the window leaves the project intact (no erase)', async () => {
    const { tf, provisioning, registry } = seedTf({ erasureUndoWindowMs: 60_000 });
    await tf.requestTenantErasure('t-a', 'r');
    expect(await tf.cancelTenantErasure('t-a')).toBe(true);
    // Executing a cancelled request is a no-op (lost the flip) — nothing deleted.
    const due = await tf.duePendingErasures();
    expect(due).toHaveLength(0); // not due (cancelled, and window not elapsed)
    expect(provisioning.deleted).toHaveLength(0);
    expect(await registry.getById('t-a')).not.toBeNull();
  });

  it('after the window, the executor erases + emits a certificate; idempotent on redelivery', async () => {
    const { tf, provisioning } = seedTf({ erasureUndoWindowMs: 0 });
    await tf.requestTenantErasure('t-a', 'r');
    // Window elapsed (executeAt = now) → due.
    const due = await tf.duePendingErasures();
    expect(due).toHaveLength(1);
    const cert = await tf.executePendingErasure(due[0]!.id);
    expect(cert).not.toBeNull();
    expect(provisioning.deleted).toContain('proj-1');
    // Redelivery: a second execute of the same id wins nothing → no second delete (idempotent).
    const again = await tf.executePendingErasure(due[0]!.id);
    expect(again).toBeNull();
    expect(provisioning.deleted).toHaveLength(1);
  });

  it('cancel-vs-execute race: a cancel that wins blocks the executor (no double-delete)', async () => {
    const { tf, provisioning } = seedTf({ erasureUndoWindowMs: 0 });
    const tenantId = 't-a';
    await tf.requestTenantErasure(tenantId, 'r');
    const due = await tf.duePendingErasures();
    expect(due).toHaveLength(1);
    // Cancel wins first → the executor must find no pending record to claim.
    expect(await tf.cancelTenantErasure(tenantId)).toBe(true);
    expect(await tf.executePendingErasure(due[0]!.id)).toBeNull();
    expect(provisioning.deleted).toHaveLength(0);
  });

  it('refuses a second erasure while one is in flight (one active request per tenant)', async () => {
    const { tf } = seedTf({ erasureUndoWindowMs: 60_000 });
    await tf.requestTenantErasure('t-a', 'r');
    await expect(tf.requestTenantErasure('t-a', 'r')).rejects.toThrow(/already in progress/);
  });
});

describe('portal self-serve facade — erasure-completion alert (L2)', () => {
  /** Seed a tenant (optionally with a billing email) + a notifier/exporter and a zero undo window. */
  const seed = (opts: { email?: string; notifier?: ReturnType<typeof fakeNotifier> } = {}) => {
    const registry = fakeRegistry();
    registry.seed({
      id: 't-a',
      metadata: opts.email !== undefined ? { billingEmail: opts.email } : {},
    });
    const provisioning = fakeProvisioning();
    const store = createInMemoryPendingErasureStore();
    const notifier = opts.notifier ?? fakeNotifier();
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      allowedRegions: ['aws-us-east-1'],
      exporter: fakeExporter(),
      pendingErasureStore: store,
      certificateSigner: stubSigner,
      erasureUndoWindowMs: 0,
      operatorEmail: 'ops@operator.example',
      notifier,
    });
    return { tf, registry, provisioning, store, notifier };
  };

  it('captures the tenant email at request time and stores it on the pending record', async () => {
    const { tf, store } = seed({ email: 'a@example.com' });
    await tf.requestTenantErasure('t-a', 'r');
    const active = await store.getActive('t-a');
    expect(active?.tenantEmail).toBe('a@example.com');
  });

  it('on execution alerts BOTH the operator and the tenant (using the captured email)', async () => {
    const { tf, notifier } = seed({ email: 'a@example.com' });
    await tf.requestTenantErasure('t-a', 'r');
    notifier.sent.length = 0; // ignore the request-time schedule alerts; assert only execution alerts
    const due = await tf.duePendingErasures();
    const cert = await tf.executePendingErasure(due[0]!.id);
    expect(cert).not.toBeNull();
    // Operator alert (operations address, no PII) AND the tenant completion notice (captured email).
    expect(notifier.sent.some((n) => n.to === 'ops@operator.example')).toBe(true);
    const tenantNote = notifier.sent.find((n) => n.to === 'a@example.com');
    expect(tenantNote).toBeDefined();
    expect(tenantNote!.subject).toMatch(/erased/i);
    // References the certificate (its completion instant) — booleans/refs only, never a secret.
    expect(tenantNote!.body).toContain(cert!.certificate.erasedAt);
  });

  it('alerts only the operator when no tenant email was on file at request time', async () => {
    const { tf, notifier } = seed({}); // no billingEmail
    await tf.requestTenantErasure('t-a', 'r');
    notifier.sent.length = 0;
    const due = await tf.duePendingErasures();
    await tf.executePendingErasure(due[0]!.id);
    expect(notifier.sent.some((n) => n.to === 'ops@operator.example')).toBe(true);
    expect(notifier.sent.some((n) => n.to.includes('@example.com'))).toBe(false);
  });

  it('a notifier failure on the tenant alert never fails or rolls back the erasure', async () => {
    // Notifier throws on the tenant completion notice → the erasure must still succeed (data is gone).
    const throwingNotifier: ReturnType<typeof fakeNotifier> = {
      provider: 'fake',
      sent: [],
      notify: (n) => {
        throwingNotifier.sent.push(n);
        return Promise.reject(new Error('smtp 500'));
      },
    };
    const { tf, provisioning } = seed({ email: 'a@example.com', notifier: throwingNotifier });
    await tf.requestTenantErasure('t-a', 'r');
    const due = await tf.duePendingErasures();
    const cert = await tf.executePendingErasure(due[0]!.id);
    expect(cert).not.toBeNull(); // erasure completed despite the alert failure
    expect(provisioning.deleted).toContain('proj-1');
  });
});

describe('portal self-serve facade — erasure-executor sweep (M2)', () => {
  const seedSweep = (over: Partial<TenantForgeDeps> = {}) => {
    const registry = fakeRegistry();
    const provisioning = fakeProvisioning();
    const store = createInMemoryPendingErasureStore();
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      allowedRegions: ['aws-us-east-1'],
      exporter: fakeExporter(),
      pendingErasureStore: store,
      certificateSigner: stubSigner,
      erasureUndoWindowMs: 0,
      ...over,
    });
    return { tf, registry, provisioning, store };
  };

  it('empty store → no-op report (nothing due)', async () => {
    const { tf, provisioning } = seedSweep();
    const report = await tf.erasureSweep();
    expect(report).toEqual({ scanned: 0, processed: [], skipped: [], failed: [] });
    expect(provisioning.deleted).toHaveLength(0);
  });

  it('no pending-erasure store wired → no-op report', async () => {
    const registry = fakeRegistry();
    const tf = createTenantForge({
      registry,
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      allowedRegions: ['aws-us-east-1'],
    });
    expect(await tf.erasureSweep()).toEqual({
      scanned: 0,
      processed: [],
      skipped: [],
      failed: [],
    });
  });

  it('executes due records and reports them processed', async () => {
    const { tf, registry, provisioning } = seedSweep();
    registry.seed({ id: 't-a' });
    await tf.requestTenantErasure('t-a', 'r');
    const report = await tf.erasureSweep();
    expect(report.scanned).toBe(1);
    expect(report.processed).toHaveLength(1);
    expect(report.skipped).toHaveLength(0);
    expect(report.failed).toHaveLength(0);
    expect(provisioning.deleted).toContain('proj-1');
  });

  it('does NOT execute not-yet-due records (window not elapsed)', async () => {
    const { tf, registry, provisioning } = seedSweep({ erasureUndoWindowMs: 60_000 });
    registry.seed({ id: 't-a' });
    await tf.requestTenantErasure('t-a', 'r');
    const report = await tf.erasureSweep();
    expect(report.scanned).toBe(0); // listDue excludes the future executeAt
    expect(report.processed).toHaveLength(0);
    expect(provisioning.deleted).toHaveLength(0);
  });

  it('is failure-isolated — one tenant failing does not stop the others', async () => {
    // Provisioning deletes proj-a fine but throws for proj-b. Both are due; the sweep must process
    // the healthy one and isolate the failure (mirrors purgeExpired).
    const registry = fakeRegistry();
    registry.seed({ id: 't-a', neonProjectId: 'proj-a' });
    registry.seed({ id: 't-b', neonProjectId: 'proj-b' });
    const deleted: string[] = [];
    const provisioning: ProvisioningProvider & { deleted: string[] } = {
      deleted,
      createTenantProject: () =>
        Promise.resolve({ neonProjectId: 'proj', connectionUri: 'postgresql://s@h/db' }),
      deleteTenantProject: (pid: string) => {
        if (pid === 'proj-b') return Promise.reject(new Error('neon 500 deleting proj-b'));
        deleted.push(pid);
        return Promise.resolve();
      },
      rotateTenantCredential: () => Promise.resolve({ connectionUri: 'postgresql://r@h/db' }),
    };
    const store = createInMemoryPendingErasureStore();
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      allowedRegions: ['aws-us-east-1'],
      exporter: fakeExporter(),
      pendingErasureStore: store,
      certificateSigner: stubSigner,
      erasureUndoWindowMs: 0,
    });
    await tf.requestTenantErasure('t-a', 'r');
    await tf.requestTenantErasure('t-b', 'r');
    const report = await tf.erasureSweep();
    expect(report.scanned).toBe(2);
    // The healthy tenant was erased; the failing one is isolated in `failed`, never blocking it.
    expect(report.processed).toHaveLength(1);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.tenantId).toBe('t-b');
    expect(deleted).toEqual(['proj-a']);
  });

  it('idempotent across redelivery / concurrent sweeps — a second run double-deletes nothing', async () => {
    const { tf, registry, provisioning, store } = seedSweep();
    registry.seed({ id: 't-a' });
    await tf.requestTenantErasure('t-a', 'r');
    const first = await tf.erasureSweep();
    expect(first.processed).toHaveLength(1);
    // The record is now `done`, not `pending` → listDue returns nothing on a second run.
    const second = await tf.erasureSweep();
    expect(second.scanned).toBe(0);
    expect(second.processed).toHaveLength(0);
    expect(provisioning.deleted).toHaveLength(1); // never deleted twice
    expect(await store.getActive('t-a')).toBeNull();
  });

  it('a record that lost the atomic flip (cancel / concurrent sweep) is reported skipped, not deleted', async () => {
    // Model a race: the sweep's `listDue` still sees the record as pending, but by the time it calls
    // executePendingErasure another actor (a cancel, or a concurrent sweep) has already claimed it, so
    // the atomic `claimForProcessing` flip loses → executePendingErasure returns null → `skipped`,
    // never a second delete (red-team F2). A thin store decorator injects that lost race deterministically.
    const registry = fakeRegistry();
    registry.seed({ id: 't-a' });
    const provisioning = fakeProvisioning();
    const inner = createInMemoryPendingErasureStore();
    let cancelledOnce = false;
    const racingStore: typeof inner = {
      ...inner,
      // listDue reports the record as due (pending)…
      listDue: (nowMs, limit) => inner.listDue(nowMs, limit),
      // …but the executor's claim loses the very first time (a racing actor won the flip first).
      claimForProcessing: async (id) => {
        if (!cancelledOnce) {
          cancelledOnce = true;
          await inner.cancel('t-a', Date.now()); // a cancel wins the flip first
        }
        return inner.claimForProcessing(id);
      },
    };
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      allowedRegions: ['aws-us-east-1'],
      exporter: fakeExporter(),
      pendingErasureStore: racingStore,
      certificateSigner: stubSigner,
      erasureUndoWindowMs: 0,
    });
    await tf.requestTenantErasure('t-a', 'r');
    const report = await tf.erasureSweep();
    expect(report.scanned).toBe(1);
    expect(report.processed).toHaveLength(0);
    expect(report.skipped).toHaveLength(1); // lost the flip → skipped, not failed
    expect(report.failed).toHaveLength(0);
    expect(provisioning.deleted).toHaveLength(0); // no delete after losing the race
  });
});
