import { beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject, TenantRecord, TenantStatus } from '../../src/core/domain.js';
import type { NewTenant, TenantRegistry } from '../../src/ports/tenant-registry.js';
import type { ProvisioningProvider } from '../../src/ports/provisioning-provider.js';
import type { PaymentSetup } from '../../src/ports/payment-setup.js';
import type { CaptchaVerifier } from '../../src/ports/captcha-verifier.js';
import type { Notifier, Notification } from '../../src/ports/notifier.js';
import { createInMemorySecretStore } from '../../src/adapters/secret-store.js';
import { createInMemoryEmailVerificationStore } from '../../src/adapters/email-verification-store.js';
import { createInMemorySignupRequestStore } from '../../src/adapters/signup-request-store.js';
import { createTenantForge, type TenantForgeDeps } from '../../src/app/lib.js';

/** Minimal full TenantRegistry fake (only the bits the signup flow touches do real work). */
function fakeRegistry(): TenantRegistry & { seed(r: TenantRecord): void } {
  const byId = new Map<string, TenantRecord>();
  let seq = 0;
  const clone = (r: TenantRecord): TenantRecord => ({ ...r, metadata: { ...r.metadata } });
  const stub = () => Promise.resolve();
  return {
    seed: (r) => void byId.set(r.id, r),
    create(t: NewTenant) {
      const record: TenantRecord = {
        id: `tenant-${++seq}`,
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
    attachProject: (id, pid) => {
      const r = byId.get(id);
      if (r) r.neonProjectId = pid;
      return Promise.resolve();
    },
    setStatus: (id, status) => {
      const r = byId.get(id);
      if (r) {
        r.status = status;
        r.updatedAt = new Date();
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

function fakeProvisioning(): ProvisioningProvider {
  let n = 0;
  return {
    createTenantProject: () =>
      Promise.resolve({
        neonProjectId: `proj-${++n}`,
        connectionUri: 'postgresql://secret@host/db',
      }),
    deleteTenantProject: () => Promise.resolve(),
    rotateTenantCredential: () =>
      Promise.resolve({ connectionUri: 'postgresql://rotated@host/db' }),
  };
}

/** Fake PaymentSetup with a controllable setup-intent status. */
function fakePaymentSetup(
  setupStatus: 'succeeded' | 'requires_action' = 'succeeded',
): PaymentSetup {
  let custN = 0;
  return {
    provider: 'fake',
    createCustomer: () => Promise.resolve({ customerRef: `cus_${++custN}`, provider: 'fake' }),
    createSetupIntent: () =>
      Promise.resolve({ setupIntentId: 'seti_1', clientSecret: 'seti_1_secret', provider: 'fake' }),
    getSetupIntent: () =>
      Promise.resolve({
        status: setupStatus,
        customerRef: 'cus_1',
        ...(setupStatus === 'succeeded' ? { paymentMethodRef: 'pm_1' } : {}),
        provider: 'fake',
      }),
    setDefaultPaymentMethod: () => Promise.resolve(),
  };
}

const captcha = (success: boolean): CaptchaVerifier => ({
  provider: 'fake',
  verify: () => Promise.resolve({ success, provider: 'fake' }),
});

/** Capturing notifier — records sends so a test can read the emailed code. */
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

/** Pull the 6-digit code out of the latest verification email. */
function codeFrom(notifier: { sent: Notification[] }): string {
  const body = notifier.sent[notifier.sent.length - 1]!.body;
  return /\b(\d{6})\b/.exec(body)![1]!;
}

describe('self-serve signup facade', () => {
  let registry: ReturnType<typeof fakeRegistry>;
  let notifier: ReturnType<typeof fakeNotifier>;
  let enqueued: unknown[];
  let secretStore: ReturnType<typeof createInMemorySecretStore>;

  const build = (over: Partial<TenantForgeDeps> = {}) => {
    registry = fakeRegistry();
    notifier = fakeNotifier();
    enqueued = [];
    secretStore = createInMemorySecretStore();
    const deps: TenantForgeDeps = {
      registry,
      provisioning: fakeProvisioning(),
      secretStore,
      defaultRegion: 'aws-us-east-1',
      notifier,
      captcha: captcha(true),
      paymentSetup: fakePaymentSetup(),
      emailVerificationStore: createInMemoryEmailVerificationStore(),
      signupRequestStore: createInMemorySignupRequestStore(),
      signupQueue: {
        enqueue: (body) => {
          enqueued.push(body);
          return Promise.resolve('msg-1');
        },
      },
      plans: [{ id: 'starter', priceUsd: 0 }],
      ...over,
    };
    return createTenantForge(deps);
  };

  beforeEach(() => build());

  it('start → verify → pay → complete enqueues an async provision and reports provisioning', async () => {
    const tf = build();
    const { signupId } = await tf.startSignup({ email: 'New@Example.com', captchaToken: 't' });
    expect(notifier.sent).toHaveLength(1);
    await tf.verifyEmail(signupId, codeFrom(notifier));
    const setup = await tf.createPaymentSetup(signupId);
    expect(setup.clientSecret).toBe('seti_1_secret');
    const res = await tf.completeSignup(signupId, { slug: 'acme-co', planId: 'starter' });
    expect(res.status).toBe('provisioning');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      type: 'provision',
      slug: 'acme-co',
      region: 'aws-us-east-1',
      metadata: { billingCustomerRef: 'cus_1', billingEmail: 'new@example.com', planId: 'starter' },
    });
  });

  it('rejects a failed captcha before any email is sent', async () => {
    const tf = build({ captcha: captcha(false) });
    await expect(tf.startSignup({ email: 'a@b.com', captchaToken: 'x' })).rejects.toThrow(
      /captcha/,
    );
    expect(notifier.sent).toHaveLength(0);
  });

  it('rejects a wrong code, then locks after too many attempts', async () => {
    const tf = build();
    const { signupId } = await tf.startSignup({ email: 'a@b.com', captchaToken: 't' });
    for (let i = 0; i < 5; i++) {
      await expect(tf.verifyEmail(signupId, '000000')).rejects.toThrow(/invalid verification code/);
    }
    // 6th attempt: locked regardless of correctness.
    await expect(tf.verifyEmail(signupId, codeFrom(notifier))).rejects.toThrow(/too many attempts/);
  });

  it('blocks the PSP setup intent until the email is verified (card-testing guard)', async () => {
    const tf = build();
    const { signupId } = await tf.startSignup({ email: 'a@b.com', captchaToken: 't' });
    await expect(tf.createPaymentSetup(signupId)).rejects.toThrow(/verify your email/);
  });

  it('refuses to complete when the payment method is not confirmed', async () => {
    const tf = build({ paymentSetup: fakePaymentSetup('requires_action') });
    const { signupId } = await tf.startSignup({ email: 'a@b.com', captchaToken: 't' });
    await tf.verifyEmail(signupId, codeFrom(notifier));
    await tf.createPaymentSetup(signupId);
    await expect(tf.completeSignup(signupId, { slug: 'acme-co' })).rejects.toThrow(/not confirmed/);
    expect(enqueued).toHaveLength(0);
  });

  it('returns a generic "slug unavailable" for a taken slug (no enumeration)', async () => {
    const tf = build();
    registry.seed({
      id: 'tenant-x',
      slug: 'taken',
      region: 'aws-us-east-1',
      status: 'active',
      neonProjectId: 'p',
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { signupId } = await tf.startSignup({ email: 'a@b.com', captchaToken: 't' });
    await tf.verifyEmail(signupId, codeFrom(notifier));
    await tf.createPaymentSetup(signupId);
    await expect(tf.completeSignup(signupId, { slug: 'taken' })).rejects.toThrow(
      /slug unavailable/,
    );
  });

  it('reveals the connection URI exactly once after the tenant becomes active', async () => {
    const tf = build();
    const { signupId } = await tf.startSignup({ email: 'a@b.com', captchaToken: 't' });
    await tf.verifyEmail(signupId, codeFrom(notifier));
    await tf.createPaymentSetup(signupId);
    await tf.completeSignup(signupId, { slug: 'acme-co' });
    // Simulate the worker having provisioned the tenant for this slug.
    registry.seed({
      id: 'tenant-prov',
      slug: 'acme-co',
      region: 'aws-us-east-1',
      status: 'active',
      neonProjectId: 'p',
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await secretStore.set('tenant-prov', 'postgresql://live@host/db');
    const first = await tf.signupStatus(signupId);
    expect(first.status).toBe('active');
    expect(first.connectionUri).toBe('postgresql://live@host/db');
    const second = await tf.signupStatus(signupId);
    expect(second.status).toBe('active');
    expect(second.connectionUri).toBeUndefined(); // one-time reveal
  });

  it('fails closed when signup ports are not configured', async () => {
    // Construct WITHOUT the captcha port (omit, not undefined — exactOptionalPropertyTypes).
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      notifier: fakeNotifier(),
      emailVerificationStore: createInMemoryEmailVerificationStore(),
      signupRequestStore: createInMemorySignupRequestStore(),
    });
    await expect(tf.startSignup({ email: 'a@b.com', captchaToken: 't' })).rejects.toThrow(
      /not configured/,
    );
  });
});
