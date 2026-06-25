/**
 * E2E journey harness + builders (gap B2).
 *
 * Wires a complete in-memory TenantForge stack — registry, provisioning, secret store, evidence
 * store + all three Ed25519 signers, audit log, signup ports, pending-erasure store, one-time-code
 * store, usage provider, event sink — into the real {@link createTenantForge} facade, so a journey
 * test exercises the whole stack hermetically (no live Neon, no network, deterministic ids, an
 * injectable clock). This is the fast, CI-runnable complement to the live `test:int` game-day
 * suite, NOT another live-Neon file.
 *
 * Design (per `@rules/topic-testing.md`): one place assembles the stack ({@link journeyHarness});
 * journeys compose it; arrange-phase **builders** ({@link aProvisionedTenant}, {@link anActiveSignup},
 * {@link anOffboardedTenant}) reach common states in one or two lines; synthetic-data **factories**
 * mint tenants/signups. Determinism comes from deterministic id counters (registry/provisioning) and
 * an injected `clock` whose value is threaded into the facade methods that accept a `now`
 * (`purgeExpired` / `retentionReport`). Nothing here touches production data.
 */
import { createInMemorySecretStore } from '../../src/adapters/secret-store.js';
import { createInMemoryAuditLogStore } from '../../src/adapters/audit-log-store.js';
import { createAuditLogEventSink, createFanOutEventSink } from '../../src/adapters/event-sink.js';
import { createInMemoryEvidenceStore } from '../../src/adapters/evidence-store.js';
import { createInMemoryEmailVerificationStore } from '../../src/adapters/email-verification-store.js';
import { createInMemorySignupRequestStore } from '../../src/adapters/signup-request-store.js';
import { createInMemoryPendingErasureStore } from '../../src/adapters/pending-erasure-store.js';
import { createInMemoryOneTimeCodeStore } from '../../src/adapters/one-time-code-store.js';
import { createEphemeralCertificateSigner } from '../../src/adapters/certificate-signer.js';
import { createEphemeralComplianceReportSigner } from '../../src/adapters/compliance-report-signer.js';
import { createEphemeralEvidenceBundleSigner } from '../../src/adapters/evidence-bundle-signer.js';
import {
  createLifecycleHandler,
  createTenantForge,
  type TenantForge,
  type TenantForgeDeps,
} from '../../src/app/lib.js';
import type { JsonObject, TenantRecord, TenantStatus } from '../../src/core/domain.js';
import type { NewTenant, TenantRegistry } from '../../src/ports/tenant-registry.js';
import type {
  ProvisioningProvider,
  ProvisionRequest,
} from '../../src/ports/provisioning-provider.js';
import type { TenantExporter, ExportResult } from '../../src/ports/tenant-exporter.js';
import type { PaymentSetup } from '../../src/ports/payment-setup.js';
import type { CaptchaVerifier } from '../../src/ports/captcha-verifier.js';
import type { Notifier, Notification } from '../../src/ports/notifier.js';
import type { UsageProvider } from '../../src/ports/usage-provider.js';
import type { EventSink } from '../../src/ports/event-sink.js';
import type { TenantEvent } from '../../src/core/observability.js';
import type { LifecycleCommand } from '../../src/adapters/lifecycle-command.js';

/** A deterministic, injectable test clock — advanceable in whole milliseconds. */
export interface TestClock {
  /** The current instant. */
  now(): Date;
  /** Advance the clock by `ms` milliseconds (e.g. past a retention window). */
  advance(ms: number): void;
}

/** Create a {@link TestClock} fixed at `start` (defaults to a stable epoch instant). */
export function testClock(start = new Date('2026-06-25T00:00:00.000Z')): TestClock {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** A capturing notifier — records every send so a journey can read an emailed code / receipt. */
export interface CapturingNotifier extends Notifier {
  /** Every notification handed to the notifier, in order. */
  readonly sent: Notification[];
}

/** Create a {@link CapturingNotifier}. */
export function capturingNotifier(): CapturingNotifier {
  const sent: Notification[] = [];
  return {
    provider: 'fake',
    sent,
    notify: (n) => {
      sent.push(n);
      return Promise.resolve({ id: `n-${sent.length}`, provider: 'fake', status: 'sent' as const });
    },
  };
}

/** Extract the 6-digit one-time code from the most recent notification body (signup / step-up). */
export function latestCode(notifier: CapturingNotifier): string {
  const last = notifier.sent[notifier.sent.length - 1];
  if (last === undefined) throw new Error('latestCode: no notification was sent');
  const m = /\b(\d{6})\b/.exec(last.body);
  if (m === null) throw new Error('latestCode: no 6-digit code in the latest notification');
  return m[1]!;
}

/** A {@link TenantRegistry} fake with deterministic ids + test seam (`seed`). */
export interface FakeRegistry extends TenantRegistry {
  /** Seed a fully-formed record directly (for arranging non-default states). */
  seed(record: TenantRecord): void;
}

/**
 * A realistic in-memory {@link TenantRegistry}: deterministic ids (`tenant-1`, `tenant-2`, …),
 * `updatedAt` bumped on every status change (so retention/purge windows key off the last
 * transition like the production registry), and clone-on-read (callers can't mutate internals).
 *
 * @param clock - The harness clock; record timestamps come from it (deterministic, not wall-clock).
 */
function fakeRegistry(clock: TestClock): FakeRegistry {
  const byId = new Map<string, TenantRecord>();
  let seq = 0;
  const clone = (r: TenantRecord): TenantRecord => ({ ...r, metadata: { ...r.metadata } });
  const stub = (): Promise<void> => Promise.resolve();
  return {
    seed(record) {
      byId.set(record.id, record);
    },
    create(tenant: NewTenant) {
      const now = clock.now();
      const record: TenantRecord = {
        id: `tenant-${++seq}`,
        slug: tenant.slug,
        region: tenant.region,
        status: 'provisioning',
        neonProjectId: null,
        metadata: (tenant.metadata as JsonObject) ?? {},
        createdAt: now,
        updatedAt: now,
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
    attachProject: (id, neonProjectId) => {
      const r = byId.get(id);
      if (r) r.neonProjectId = neonProjectId;
      return Promise.resolve();
    },
    setStatus: (id, status) => {
      const r = byId.get(id);
      if (r) {
        r.status = status;
        r.updatedAt = clock.now();
      }
      return Promise.resolve();
    },
    updateMetadata: (id, patch) => {
      const r = byId.get(id);
      if (r) r.metadata = { ...r.metadata, ...patch };
      return Promise.resolve();
    },
    relocate: (id, region, neonProjectId) => {
      const r = byId.get(id);
      if (r) {
        r.region = region;
        r.neonProjectId = neonProjectId;
      }
      return Promise.resolve();
    },
    registerMigration: (m: { version: string; checksum: string }) =>
      Promise.resolve({ id: `mig-${m.version}`, version: m.version, checksum: m.checksum }),
    listMigrations: () => Promise.resolve([]),
    listTenantMigrationStates: () => Promise.resolve([]),
    recordTenantMigration: stub,
    migrate: stub,
    ping: stub,
    close: stub,
  };
}

/** A {@link ProvisioningProvider} fake recording create/delete/rotate calls with deterministic ids. */
export interface FakeProvisioning extends ProvisioningProvider {
  /** Every create request, in order. */
  readonly creates: ProvisionRequest[];
  /** Every deleted Neon project id, in order. */
  readonly deletes: string[];
}

/** A realistic in-memory provisioning provider (deterministic `proj-N` ids; unique connection URIs). */
function fakeProvisioning(): FakeProvisioning {
  const creates: ProvisionRequest[] = [];
  const deletes: string[] = [];
  return {
    creates,
    deletes,
    createTenantProject(request) {
      creates.push(request);
      const n = creates.length;
      return Promise.resolve({
        neonProjectId: `proj-${n}`,
        // Synthetic, unique per project — a secret the harness threads through the secret store.
        connectionUri: `postgresql://owner:pw@proj-${n}.example/db`,
      });
    },
    deleteTenantProject(neonProjectId) {
      deletes.push(neonProjectId);
      return Promise.resolve();
    },
    rotateTenantCredential(neonProjectId) {
      return Promise.resolve({
        connectionUri: `postgresql://rotated:pw@${neonProjectId}.example/db`,
      });
    },
  };
}

/** A {@link TenantExporter} fake that records a synthetic durable archive reference. */
function fakeExporter(): TenantExporter {
  let n = 0;
  return {
    exportTenant(tenant: TenantRecord): Promise<ExportResult> {
      n += 1;
      return Promise.resolve({ location: `archive://exports/${tenant.id}/${n}`, bytes: 4096 });
    },
  };
}

/** A {@link PaymentSetup} fake with a controllable terminal setup-intent status. */
function fakePaymentSetup(status: 'succeeded' | 'requires_action' = 'succeeded'): PaymentSetup {
  let cust = 0;
  return {
    provider: 'fake',
    createCustomer: () => Promise.resolve({ customerRef: `cus_${++cust}`, provider: 'fake' }),
    createSetupIntent: () =>
      Promise.resolve({ setupIntentId: 'seti_1', clientSecret: 'seti_1_secret', provider: 'fake' }),
    getSetupIntent: () =>
      Promise.resolve({
        status,
        customerRef: 'cus_1',
        ...(status === 'succeeded' ? { paymentMethodRef: 'pm_1' } : {}),
        provider: 'fake',
      }),
    setDefaultPaymentMethod: () => Promise.resolve(),
  };
}

/** A captcha verifier whose verdict is fixed (`true` = solved). */
function fakeCaptcha(success = true): CaptchaVerifier {
  return { provider: 'fake', verify: () => Promise.resolve({ success, provider: 'fake' }) };
}

/** A usage provider returning a fixed synthetic consumption bucket (deterministic billing touch). */
function fakeUsageProvider(): UsageProvider {
  return {
    getProjectConsumption: () =>
      Promise.resolve([
        {
          computeTimeSeconds: 3600,
          activeTimeSeconds: 1800,
          writtenDataBytes: 1_000_000,
          syntheticStorageBytes: 5_000_000,
        },
      ]),
  };
}

/** An {@link EventSink} that records every emitted event (for asserting the audit trail). */
export interface CapturingSink extends EventSink {
  /** Every event emitted by the facade, in order. */
  readonly events: TenantEvent[];
}

function capturingSink(): CapturingSink {
  const events: TenantEvent[] = [];
  return {
    events,
    emit(e: TenantEvent): void {
      events.push(e);
    },
  };
}

/** Knobs for {@link journeyHarness} (all default to a fully-wired, succeeding stack). */
export interface JourneyHarnessOptions {
  /** Fixed PSP setup-intent status (default `succeeded`). */
  paymentStatus?: 'succeeded' | 'requires_action';
  /** Captcha verdict (default `true` = solved). */
  captchaSuccess?: boolean;
  /** Plan catalog (default a single free `starter` plan). */
  plans?: TenantForgeDeps['plans'];
  /** Default retention window in days (default 30). */
  retentionDays?: number;
  /** Extra dep overrides merged last (escape hatch for a journey-specific tweak). */
  deps?: Partial<TenantForgeDeps>;
}

/** A fully-assembled in-memory TenantForge stack + handles to inspect its state. */
export interface JourneyHarness {
  /** The control-plane facade under test (the system entrypoint a journey drives). */
  readonly tf: TenantForge;
  /** The deterministic, advanceable clock (thread `clock.now()` into `purgeExpired`/`retentionReport`). */
  readonly clock: TestClock;
  /** The in-memory tenant registry (inspect/seed state). */
  readonly registry: FakeRegistry;
  /** The provisioning provider (assert create/delete calls — e.g. purge deleted the project). */
  readonly provisioning: FakeProvisioning;
  /** The connection-secret store (assert a secret was set on provision / shredded on purge). */
  readonly secretStore: ReturnType<typeof createInMemorySecretStore>;
  /** The persisted audit trail (drives compliance report's audit excerpt + erasure history). */
  readonly auditLog: ReturnType<typeof createInMemoryAuditLogStore>;
  /** The evidence-at-rest store (bundles persist here; tenant-scope BOLA guard lives here). */
  readonly evidenceStore: ReturnType<typeof createInMemoryEvidenceStore>;
  /** The signup funnel record store. */
  readonly signupRequestStore: ReturnType<typeof createInMemorySignupRequestStore>;
  /** The capturing notifier (read emailed codes / receipts). */
  readonly notifier: CapturingNotifier;
  /** Every event the facade emitted (assert observable audit outcomes). */
  readonly events: TenantEvent[];
  /** Bodies enqueued onto the lifecycle queue (e.g. the async `provision` from signup). */
  readonly enqueued: unknown[];
  /**
   * Drain the lifecycle queue by handing every enqueued command to the real
   * {@link createLifecycleHandler} — simulates the async worker provisioning a self-serve signup,
   * hermetically and deterministically.
   */
  drainQueue(): Promise<void>;
}

/**
 * Assemble a complete, hermetic in-memory TenantForge stack for an E2E journey.
 *
 * Every collaborator is an in-memory adapter or a deterministic fake; the three Ed25519 signers are
 * **ephemeral** (generated per harness — valid for the life of the test, verifiable via the facade's
 * `*PublicKey()` methods). Each call returns a fresh, isolated stack, so journeys are
 * order-independent and parallel-safe.
 *
 * @param options - Optional knobs; defaults give a fully-wired, succeeding stack.
 * @returns The harness (facade + state handles + queue drainer).
 */
export async function journeyHarness(options: JourneyHarnessOptions = {}): Promise<JourneyHarness> {
  const clock = testClock();
  const registry = fakeRegistry(clock);
  const provisioning = fakeProvisioning();
  const secretStore = createInMemorySecretStore();
  const auditLog = createInMemoryAuditLogStore();
  const evidenceStore = createInMemoryEvidenceStore();
  const signupRequestStore = createInMemorySignupRequestStore();
  const notifier = capturingNotifier();
  const sink = capturingSink();
  const enqueued: unknown[] = [];

  // Fan out facade events to BOTH the persisted audit log (so the compliance report has an audit
  // excerpt + erasure history) and a capturing sink (so journeys can assert observable outcomes).
  const eventSink = createFanOutEventSink([createAuditLogEventSink(auditLog), sink]);

  const [certificateSigner, complianceReportSigner, evidenceBundleSigner] = await Promise.all([
    createEphemeralCertificateSigner(),
    createEphemeralComplianceReportSigner(),
    createEphemeralEvidenceBundleSigner(),
  ]);

  const deps: TenantForgeDeps = {
    registry,
    provisioning,
    secretStore,
    defaultRegion: 'aws-us-east-1',
    allowedRegions: ['aws-us-east-1', 'aws-eu-central-1'],
    retentionDays: options.retentionDays ?? 30,
    exporter: fakeExporter(),
    eventSink,
    auditLog,
    usageProvider: fakeUsageProvider(),
    notifier,
    certificateSigner,
    complianceReportSigner,
    evidenceBundleSigner,
    evidenceStore,
    // Self-serve signup ports.
    captcha: fakeCaptcha(options.captchaSuccess ?? true),
    paymentSetup: fakePaymentSetup(options.paymentStatus ?? 'succeeded'),
    emailVerificationStore: createInMemoryEmailVerificationStore(),
    signupRequestStore,
    signupQueue: {
      enqueue: (body) => {
        enqueued.push(body);
        return Promise.resolve(`msg-${enqueued.length}`);
      },
    },
    // Self-serve portal step-up + cancellable erasure.
    oneTimeCodeStore: createInMemoryOneTimeCodeStore(),
    pendingErasureStore: createInMemoryPendingErasureStore(),
    plans: options.plans ?? [{ id: 'starter', priceUsd: 0 }],
    ...options.deps,
  };

  const tf = createTenantForge(deps);
  const handle = createLifecycleHandler(tf);

  return {
    tf,
    clock,
    registry,
    provisioning,
    secretStore,
    auditLog,
    evidenceStore,
    signupRequestStore,
    notifier,
    events: sink.events,
    enqueued,
    async drainQueue() {
      // Copy + clear first so a command that itself enqueues doesn't loop within one drain.
      const batch = enqueued.splice(0, enqueued.length);
      for (const body of batch) {
        await handle(body as LifecycleCommand);
      }
    },
  };
}

/** Days → milliseconds (for {@link TestClock.advance} past a retention window). */
export const days = (n: number): number => n * 24 * 60 * 60 * 1000;

/** The current calendar-month billing period, derived from a {@link TestClock}. */
export function monthPeriod(clock: TestClock): { from: Date; to: Date } {
  const d = clock.now();
  return { from: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), to: d };
}
