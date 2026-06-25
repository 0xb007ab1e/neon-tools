import {
  assertRegion,
  assertSlug,
  aggregateConsumption,
  assertPeriod,
  assertRegionAllowed,
  assertResidency,
  assertTransition,
  isPurgeable,
  redactSecrets,
  TRACEPARENT_HEADER,
  invoiceChargeAmount,
  chargeIdempotencyKey,
  assertRefundAmount,
  refundIdempotencyKey,
  prorateRefundMinor,
  proratePlanChangeMinor,
  renderReceipt,
  receiptIdempotencyKey,
  renderInvoiceEmail,
  invoiceEmailIdempotencyKey,
  type ReceiptKind,
  planDunning,
  dunningStateFromCharges,
  type DunningSchedule,
  type TenantEvent,
  retentionCutoff,
  buildRetentionReport,
  type RetentionReport,
  selectRegion,
  normalizeAuditQuery,
  detectAuditAnomalies,
  detectCostAnomalies,
  buildOperatorDigest,
  formatOperatorDigest,
  type OperatorDigest,
  webhookSecretKey,
  toWebhookSubscriptionSummary,
  type WebhookSubscriptionCreated,
  type WebhookSubscriptionSummary,
  signupTokenStatus,
  assertRedeemable,
  type SignupTokenRecord,
  type SignupTokenStatus,
  assertVerifiable,
  canRevealConnection,
  type SignupRequestStatus,
  findPlan,
  planAssignment,
  buildComplianceReport,
  buildEvidenceBundle,
  type ComplianceReport,
  type ComplianceReportOptions,
  type SignedComplianceReport,
  type EvidenceScope,
  type SignedEvidenceBundle,
  type AuditQueryInput,
  type AnomalyThresholds,
  type AuditAnomaly,
  type CostAnomalyThresholds,
  type CostAnomaly,
  type PlanDefinition,
  type BillingPeriod,
  type Jurisdiction,
  type JsonObject,
  type TenantRecord,
  type TenantStatus,
  type TenantUsage,
  type ErasureCertificate,
  type SignedErasureCertificate,
  type FleetDriftReport,
  type FleetReconcilePlan,
} from '../core/index.js';
import { createNeonProvisioningProvider } from '../adapters/neon-api/provisioning-provider.js';
import { createPgTenantRegistry } from '../adapters/neon-pg/registry.js';
import { createNeonPgSecretStore } from '../adapters/neon-pg/secret-store.js';
import { createVaultSecretStore } from '../adapters/vault/secret-store.js';
import { deriveKey } from '../adapters/secret-crypto.js';
import { createConnectionRouter } from '../adapters/connection-router.js';
import { createNeonArchiveExporter } from '../adapters/neon-archive-exporter.js';
import { createPgDumpExporter, spawnPgDump } from '../adapters/pg-dump/exporter.js';
import { createPgDataMover } from '../adapters/pg-dump/data-mover.js';
import { createFilesystemObjectStore } from '../adapters/object-store/filesystem.js';
import {
  createJsonEventSink,
  createNoopEventSink,
  createFanOutEventSink,
  createAuditLogEventSink,
} from '../adapters/event-sink.js';
import { createPgAuditLogStore } from '../adapters/neon-pg/audit-log-store.js';
import { currentActor } from './actor-context.js';
import { currentTrace, outboundTraceparent } from './trace-context.js';
import { createErasureEngine, type EraseOptions } from '../adapters/erasure-engine.js';
import type { CertificateSigner } from '../ports/certificate-signer.js';
import {
  createEd25519CertificateSigner,
  createEphemeralCertificateSigner,
} from '../adapters/certificate-signer.js';
import type { ComplianceReportSigner } from '../ports/compliance-report-signer.js';
import {
  createEd25519ComplianceReportSigner,
  createEphemeralComplianceReportSigner,
} from '../adapters/compliance-report-signer.js';
import type { EvidenceBundleSigner } from '../ports/evidence-bundle-signer.js';
import {
  createEd25519EvidenceBundleSigner,
  createEphemeralEvidenceBundleSigner,
} from '../adapters/evidence-bundle-signer.js';
import { createCachingConnectionRouter } from '../adapters/caching-connection-router.js';
import {
  createRehomeEngine,
  type RehomeOptions,
  type RehomeResult,
} from '../adapters/rehome-engine.js';
import type { TenantDataMover } from '../ports/tenant-data-mover.js';
import {
  createSecretRotationEngine,
  type RotationResult,
  type RotationSweepReport,
} from '../adapters/secret-rotation-engine.js';
import {
  createBackupEngine,
  type SnapshotResult,
  type BackupSweepReport,
  type ArchiveResult,
} from '../adapters/backup-engine.js';
import type { SnapshotProvider } from '../ports/snapshot-provider.js';
import type {
  RetentionPolicy,
  Quota,
  CostRates,
  CostReport,
  BillingRates,
  IncludedUsage,
  Invoice,
} from '../core/index.js';
import {
  createQuotaEngine,
  type QuotaCheckResult,
  type QuotaSweepReport,
} from '../adapters/quota-engine.js';
import { createCostEngine } from '../adapters/cost-engine.js';
import { createInvoiceEngine, type FleetInvoiceReport } from '../adapters/invoice-engine.js';
import {
  createUsageAlertEngine,
  type UsageAlertSweepReport,
} from '../adapters/usage-alert-engine.js';
import {
  createFleetOrchestrator,
  type FleetMigrationReport,
  type FleetMigrationSpec,
  type MigrateFleetOptions,
  type ReconcileFleetOptions,
  type FleetReconcileReport,
} from '../adapters/fleet-orchestrator.js';
import { createPgMigrationRunner } from '../adapters/neon-pg/migration-runner.js';
import { createNeonUsageProvider } from '../adapters/neon-api/usage-provider.js';
import { createNeonSnapshotProvider } from '../adapters/neon-api/snapshot-provider.js';
import type { LifecycleCommand } from '../adapters/lifecycle-command.js';
import type { ProvisioningProvider } from '../ports/provisioning-provider.js';
import type { TenantRegistry } from '../ports/tenant-registry.js';
import type { ExportResult, TenantExporter } from '../ports/tenant-exporter.js';
import type { SecretStore } from '../ports/secret-store.js';
import type { EventSink } from '../ports/event-sink.js';
import type { AuditLogStore } from '../ports/audit-log-store.js';
import type { ChargeResult, PaymentGateway, RefundResult } from '../ports/payment-gateway.js';
import { createStripeGateway } from '../adapters/payment/stripe-gateway.js';
import type { PaymentSetup } from '../ports/payment-setup.js';
import type { CaptchaVerifier } from '../ports/captcha-verifier.js';
import type { EmailVerificationStore } from '../ports/email-verification-store.js';
import type { SignupRequestStore } from '../ports/signup-request-store.js';
import type { PaymentEvent, PaymentWebhookVerifier } from '../ports/payment-webhook.js';
import type { Notifier } from '../ports/notifier.js';
import type { CreditLedger } from '../ports/credit-ledger.js';
import type { OneTimeCodeStore } from '../ports/one-time-code-store.js';
import type { PendingErasureRecord, PendingErasureStore } from '../ports/pending-erasure-store.js';
import { createStripeWebhookVerifier } from '../adapters/payment/stripe-webhook.js';
import { createInMemoryCreditLedger } from '../adapters/credit-ledger.js';
import { createPgCreditLedger } from '../adapters/neon-pg/credit-ledger.js';
import { createInMemorySignupTokenStore } from '../adapters/signup-token-store.js';
import { createPgSignupTokenStore } from '../adapters/neon-pg/signup-token-store.js';
import type { SignupTokenStore } from '../ports/signup-token-store.js';
import { createStripeSetup } from '../adapters/payment/stripe-setup.js';
import { createTurnstileVerifier } from '../adapters/captcha/turnstile-verifier.js';
import { createInMemoryEmailVerificationStore } from '../adapters/email-verification-store.js';
import { createPgEmailVerificationStore } from '../adapters/neon-pg/email-verification-store.js';
import { createInMemorySignupRequestStore } from '../adapters/signup-request-store.js';
import { createPgSignupRequestStore } from '../adapters/neon-pg/signup-request-store.js';
import { createInMemoryOneTimeCodeStore } from '../adapters/one-time-code-store.js';
import { createInMemoryPendingErasureStore } from '../adapters/pending-erasure-store.js';
import { createPgPendingErasureStore } from '../adapters/neon-pg/pending-erasure-store.js';
import { createPgMessageQueue } from '../adapters/neon-pg/message-queue.js';
import { createPgWebhookSubscriptionStore } from '../adapters/neon-pg/webhook-subscription-store.js';
import { createSubscriptionWebhookEventSink } from '../adapters/subscription-webhook-event-sink.js';
import type { WebhookSubscriptionStore } from '../ports/webhook-subscription-store.js';
import { assertHttpsUrl } from '../core/transport-security.js';
import { createLogNotifier } from '../adapters/notify/log-notifier.js';
import { createHttpNotifier } from '../adapters/notify/http-notifier.js';
import type { UsageProvider } from '../ports/usage-provider.js';
import type { MigrationRunner } from '../ports/migration-runner.js';
import type { TenantConnection } from '../ports/connection-router.js';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { loadConfig, type Config } from './config.js';

export type { Config } from './config.js';

/** A compliance report plus a tamper-evidence digest over its canonical JSON. */
export interface ComplianceReportResult {
  /** The point-in-time attestation. */
  report: ComplianceReport;
  /** SHA-256 hex digest of the report JSON (integrity anchor; not an authenticity signature). */
  digest: string;
}

/** The outcome of a fleet-wide charge run (failure-isolated, per-tenant). */
export interface FleetChargeReport {
  /** When the run was generated (ISO-8601 UTC). */
  generatedAt: string;
  /** Tenants charged this run (success/processing). */
  charged: (ChargeResult & { tenantId: string })[];
  /** Tenants intentionally skipped (no billing customer ref, or a zero/no-charge invoice). */
  skipped: { tenantId: string; reason: string }[];
  /** Tenants whose charge attempt errored (declines/transport) — isolated, never blocking others. */
  failed: { tenantId: string; error: string }[];
}

/** Per-tenant outcome + the run summary of a dunning (failed-charge retry) sweep. */
export interface DunningReport {
  /** When the run was generated (ISO-8601 UTC). */
  generatedAt: string;
  /** The schedule the run applied. */
  schedule: DunningSchedule;
  /** Retried tenants whose retry charge succeeded/processed this run. */
  retried: (ChargeResult & { tenantId: string; attempt: number })[];
  /** Tenants whose retry charge errored again — isolated, never blocking others. */
  failed: { tenantId: string; attempt: number; error: string }[];
  /** Tenants suspended this run (retries exhausted — reversible escalation). */
  suspended: { tenantId: string; failures: number }[];
  /** Tenants examined but not acted on (not failing, within backoff, or no billing ref). */
  skipped: { tenantId: string; reason: string }[];
}

/** Options for a {@link TenantForge.billingRun}. */
export interface BillingRunOptions {
  /** Skip the dunning sweep (charge-only run). Defaults to false (charge then dun). */
  skipDunning?: boolean;
  /** Dunning policy for the sweep; defaults to {@link DEFAULT_DUNNING_SCHEDULE}. */
  dunningSchedule?: DunningSchedule;
}

/** The combined result of a scheduled billing run: the fleet charge plus the dunning sweep. */
export interface BillingRunReport {
  /** When the run completed (ISO-8601 UTC). */
  generatedAt: string;
  /** The billing period the run charged/dunned. */
  period: { from: string; to: string };
  /** The fleet-charge phase result. */
  charge: FleetChargeReport;
  /** The dunning-sweep phase result; absent when `skipDunning` was set. */
  dunning?: DunningReport;
}

/** Options for a {@link TenantForge.refundCharge}. */
export interface RefundOptions {
  /** Partial-refund amount in minor units; omit for a full refund of the original charge. */
  amountMinor?: number;
  /** Human reason for the refund (no secrets/PII), attached at the PSP + recorded in the audit event. */
  reason?: string;
  /** Currency override (lowercase ISO 4217); required only when the charge isn't in the audit trail. */
  currency?: string;
  /** Tenant id for attribution; defaults to the one on the matching `tenant.charged` audit event. */
  tenantId?: string;
}

/**
 * A **safe, customer-facing projection** of a tenant for the self-serve portal — only fields a tenant
 * may see about itself. Deliberately omits raw `metadata` (which can hold internal flags / the PSP
 * `billingCustomerRef`) and `neonProjectId` (an internal infra id); the plan price is surfaced
 * explicitly when present.
 */
export interface TenantSummary {
  /** The tenant's id. */
  id: string;
  /** The tenant's slug. */
  slug: string;
  /** The region the tenant's data lives in (residency — a tenant may see its own). */
  region: string;
  /** Lifecycle status. */
  status: TenantStatus;
  /** When the tenant was created (ISO-8601 UTC). */
  createdAt: string;
  /** The flat plan price in USD, if set on the tenant (`metadata.priceUsd`). */
  planPriceUsd?: number;
}

/** Options for a plan change / preview. */
export interface PlanChangeOptions {
  /** The period the change prorates within; defaults to the current month. */
  period?: BillingPeriod;
  /** The instant the change takes effect; defaults to now. */
  asOf?: Date;
  /** Settle the prorated delta now (charge an upgrade / refund a downgrade). Money movement — gated. */
  settle?: boolean;
}

/** A prorated **quote** for switching a tenant to a new plan price (no mutation, no money). */
export interface PlanChangePreview {
  /** The tenant. */
  tenantId: string;
  /** The current plan price (USD). */
  oldPriceUsd: number;
  /** The proposed plan price (USD). */
  newPriceUsd: number;
  /** The period the proration is computed over. */
  period: { from: string; to: string };
  /** Signed prorated settlement (minor units): `>0` charge (upgrade), `<0` refund (downgrade), `0` none. */
  proratedDeltaMinor: number;
}

/** The result of an applied plan change: the quote plus how the delta was settled. */
export interface PlanChangeReport extends PlanChangePreview {
  /**
   * How the prorated delta was settled: `none` (zero delta or `settle` not requested), `charged`
   * (upgrade), `credited` (downgrade → uncapped credit balance, when a credit ledger is wired),
   * `refunded` (downgrade → refund against the latest charge, capped, when no ledger), or `skipped`
   * (settle requested but no billing customer ref / no prior charge to credit).
   */
  settlement: 'none' | 'charged' | 'credited' | 'refunded' | 'skipped';
  /** The settlement charge/refund id, when one occurred. */
  settlementId?: string;
}

export type {
  ChargeRequest,
  ChargeResult,
  PaymentGateway,
  RefundRequest,
  RefundResult,
} from '../ports/payment-gateway.js';
export type { PaymentEvent, PaymentWebhookVerifier } from '../ports/payment-webhook.js';
export type { Notifier, Notification, NotificationResult } from '../ports/notifier.js';
export type { DunningSchedule, DunningDecision, DunningState } from '../core/dunning.js';
export type {
  FleetMigrationSpec,
  MigrateFleetOptions,
  FleetMigrationReport,
  ReconcileFleetOptions,
  FleetReconcileReport,
} from '../adapters/fleet-orchestrator.js';

/** Collaborators injected into {@link createTenantForge} (ports & adapters). */
export interface TenantForgeDeps {
  /** Persistence for tenant metadata. */
  registry: TenantRegistry;
  /** Creates/destroys the isolated per-tenant database. */
  provisioning: ProvisioningProvider;
  /** Default region when a provision request omits one (already validated). */
  defaultRegion: string;
  /**
   * Allow-listed regions tenants may be provisioned in (residency enforcement). Empty/omitted =
   * all known regions allowed.
   */
  allowedRegions?: readonly string[];
  /**
   * Default retention window (days) for {@link TenantForge.purgeExpired} / {@link
   * TenantForge.retentionReport} when the caller doesn't pass one. Absent ⇒ 30 days.
   */
  retentionDays?: number;
  /**
   * Dedicated store for per-tenant connection secrets (keyed by tenant id). The connection URI is
   * stored here on provision and deleted on offboard — never persisted in the registry (master §5).
   */
  secretStore: SecretStore;
  /**
   * Produces a durable archive reference for a tenant on offboard (e.g. the retained, scaled-to-zero
   * Neon project). Optional — without one, offboard still retains the project and returns a default
   * reference.
   */
  exporter?: TenantExporter;
  /**
   * Applies a migration to one tenant database. Required only for {@link TenantForge.migrateFleet};
   * when absent, that method fails closed.
   */
  migrationRunner?: MigrationRunner;
  /**
   * Receives structured, tenant-scoped events for observability. Optional; defaults to a no-op sink
   * (events are dropped). Emission is best-effort and never breaks an operation.
   */
  eventSink?: EventSink;
  /**
   * Fetches per-tenant resource consumption (metering). Required only for {@link TenantForge.usage};
   * when absent, that method fails closed.
   */
  usageProvider?: UsageProvider;
  /**
   * Cache `getConnection` resolutions for this many ms (process-local, tenant-keyed, single-flight;
   * see {@link import('../adapters/caching-connection-router.js').createCachingConnectionRouter}).
   * `0`/omitted disables caching (resolve hits the registry + secret store every call). Entries are
   * invalidated automatically on lifecycle transitions and erasure.
   */
  connectionCacheTtlMs?: number;
  /** Max cached connection resolutions before the least-recently-used is evicted. Optional. */
  connectionCacheMaxEntries?: number;
  /**
   * Copies a tenant's data between projects. Required only for {@link TenantForge.rehome}; when
   * absent, that method fails closed.
   */
  dataMover?: TenantDataMover;
  /**
   * Takes/lists/prunes/restores per-tenant database snapshots (Neon branches). Required only for the
   * snapshot/backup methods ({@link TenantForge.snapshot} etc.); when absent, those fail closed.
   */
  snapshots?: SnapshotProvider;
  /**
   * Off-Neon archive exporter (pg_dump → object store) for the durable long-term backup tier.
   * Required only for {@link TenantForge.archive} / {@link TenantForge.archiveFleet}; when absent,
   * those fail closed.
   */
  archiveExporter?: TenantExporter;
  /** Unit cost rates (USD) for {@link TenantForge.costReport}; defaults to empty (zero cost). */
  costRates?: CostRates;
  /** Per-unit billing (sell) rates for {@link TenantForge.invoice}; defaults to empty (usage not billed). */
  billingRates?: BillingRates;
  /**
   * Usage-alert thresholds for {@link TenantForge.checkUsageAlerts} — fractions of a tenant's
   * included allowance to alert at (e.g. `[0.8, 1.0]`). Empty/absent ⇒ usage alerts are off.
   */
  usageAlertThresholds?: number[];
  /**
   * The operator's **plan catalog** for {@link TenantForge.assignPlan} / {@link TenantForge.listPlans}
   * — named tiers bundling price + included allowances. Absent/empty ⇒ no catalog (assignPlan fails
   * closed). Validate with `assertPlanCatalog` before passing.
   */
  plans?: PlanDefinition[];
  /**
   * Payment gateway (PSP) for {@link TenantForge.chargeInvoice}. Optional and swappable behind the
   * {@link PaymentGateway} port (Stripe ships; others plug in the same way). Absent ⇒ charging fails
   * closed. Charging is a money-moving outward action — never auto-wired without explicit config.
   */
  paymentGateway?: PaymentGateway;
  /**
   * Verifier for **inbound PSP webhooks** (e.g. Stripe). Swappable behind the
   * {@link PaymentWebhookVerifier} port. Required only for {@link TenantForge.ingestPaymentWebhook};
   * absent ⇒ ingestion fails closed.
   */
  paymentWebhookVerifier?: PaymentWebhookVerifier;
  /**
   * Persisted audit trail. When provided, {@link TenantForge.complianceReport} includes erasure
   * history + a recent audit excerpt; absent = the report omits the `audit` section. (Wire the
   * matching {@link createAuditLogEventSink} into the event sink so the trail is populated.)
   */
  auditLog?: AuditLogStore;
  /**
   * Notifier for **billing receipts** (charge/refund confirmations). When provided, a successful
   * charge/refund best-effort sends a receipt to the tenant's `metadata.billingEmail` (if set) and
   * records a redacted `tenant.notified` event. Absent = no receipts. A send failure never breaks
   * the billing operation it confirms.
   */
  notifier?: Notifier;
  /**
   * Operator/ops recipient for the operator alert digest (an operations address, not a tenant's).
   * When set together with a {@link notifier}, `operatorDigest({ notify: true })` emails the digest
   * (best-effort) for non-`ok` severities. Absent = the digest is read-only (event/log only).
   */
  operatorEmail?: string;
  /**
   * Credit ledger for prorated downgrade credits + applying credit to charges. When provided, a
   * charge first draws down any available balance (so the card is charged the remainder), and a plan
   * **downgrade** grants an uncapped credit rather than a capped refund. Absent = credit features off.
   */
  creditLedger?: CreditLedger;
  /**
   * Store for one-time tenant **signup/invite tokens** (the builder-owned "signup" lifecycle stage).
   * When provided, `issueSignupToken` / `redeemSignupToken` / `listSignupTokens` are enabled; absent
   * ⇒ they fail closed. Only the token hash is persisted.
   */
  signupTokenStore?: SignupTokenStore;
  /**
   * **Self-serve signup** ports (the public, payment-gated web signup). All four (plus a
   * {@link notifier} and a {@link signupQueue} producer) must be present for `startSignup` /
   * `verifyEmail` / `createPaymentSetup` / `completeSignup` / `signupStatus` to work; absent ⇒ they
   * fail closed. `paymentSetup` onboards a PSP customer + payment method; `captcha` gates bots before
   * any cost-incurring call; `emailVerificationStore` proves the address; `signupRequestStore` is the
   * funnel record. None hold secrets.
   */
  paymentSetup?: PaymentSetup;
  /** Captcha verifier gating the public signup (fail-closed). See {@link paymentSetup}. */
  captcha?: CaptchaVerifier;
  /** One-time email-verification code store for signup. See {@link paymentSetup}. */
  emailVerificationStore?: EmailVerificationStore;
  /** Signup funnel record store. See {@link paymentSetup}. */
  signupRequestStore?: SignupRequestStore;
  /**
   * Producer for the lifecycle queue — `completeSignup` enqueues a `provision` command so the new
   * tenant is created asynchronously by the worker (Neon project creation is slow). Any queue adapter
   * (in-memory / Postgres / Pub/Sub) satisfies this. Absent ⇒ signup completion fails closed.
   */
  signupQueue?: { enqueue(body: unknown): Promise<string> };
  /** TTL (ms) for a signup email-verification code. Defaults to 15 minutes. */
  emailCodeTtlMs?: number;
  /**
   * **Self-serve portal** step-up second-factor store (threat-model B8w / red-team F1). When provided
   * (with a {@link notifier}), `requestTenantStepUp` mints a single-use email code and
   * `verifyTenantStepUp` checks it — the control-plane-owned factor that gates the destructive portal
   * actions (cancel, erasure), independent of the OIDC token. Absent ⇒ those actions fail closed.
   */
  oneTimeCodeStore?: OneTimeCodeStore;
  /** TTL (ms) for a portal step-up code. Defaults to 10 minutes. */
  stepUpCodeTtlMs?: number;
  /** Max failed step-up attempts before the code locks. Defaults to 5. */
  stepUpMaxAttempts?: number;
  /**
   * **Self-serve portal** pending-erasure store (the mandatory undo window — threat-model B8w /
   * red-team F2). When provided (with an exporter for the verified-erasure engine),
   * `requestTenantErasure` schedules a cancellable erasure, `cancelTenantErasure` cancels it, and
   * `executePendingErasure` runs it after the window via a single atomic conditional flip. Absent ⇒
   * self-serve erasure fails closed.
   */
  pendingErasureStore?: PendingErasureStore;
  /**
   * **Cryptographic signer for erasure certificates** (EdDSA/Ed25519 compact JWS). When present,
   * every {@link TenantForge.erase} / {@link TenantForge.executePendingErasure} produces a
   * **signed** certificate (the `.jws` an auditor verifies with `verifyErasureCertificate` against
   * {@link TenantForge.erasureCertificatePublicKey}). **Erasure is always-signed:** with no signer,
   * `erase` and scheduling an erasure (`requestTenantErasure`) **fail closed** — there is no unsigned
   * path, so a tenant can never be erased without a verifiable certificate. The composition root
   * validates the key at startup (fail-fast) and, in non-prod only, generates an ephemeral key.
   */
  certificateSigner?: CertificateSigner;
  /**
   * **Cryptographic signer for compliance reports** (EdDSA/Ed25519 compact JWS; ADR-0011 Phase 1).
   * When present, {@link TenantForge.signedComplianceReport} emits a **signed** report (the `.jws` an
   * auditor verifies with `verifyComplianceReport` against {@link TenantForge.complianceReportPublicKey}).
   * Absent ⇒ `signedComplianceReport` **fails closed** (no unsigned signed-report path). The plain,
   * unsigned {@link TenantForge.complianceReport} does **not** require this signer — existing callers
   * that consume the digest-only result are unaffected. The composition root validates the key at
   * startup (fail-fast) and, in non-prod only, generates an ephemeral key. Reuses the Ed25519
   * mechanism behind {@link certificateSigner} but is a **distinct purpose/kid** (not confusable).
   */
  complianceReportSigner?: ComplianceReportSigner;
  /**
   * **Cryptographic signer for evidence bundles** (EdDSA/Ed25519 compact JWS; ADR-0011 Phase 2).
   * When present, {@link TenantForge.evidenceBundle} emits a **signed** bundle (the `.jws` an auditor
   * verifies with `verifyEvidenceBundle` against {@link TenantForge.evidenceBundlePublicKey}). Absent
   * ⇒ `evidenceBundle` **fails closed** (no unsigned bundle path). Per ADR-0011 this **reuses the
   * compliance evidence signing key** (`TENANTFORGE_COMPLIANCE_SIGNING_KEY`) — no third prod key — but
   * is a **distinct purpose/kid/typ** (not confusable with a compliance report or erasure certificate).
   * The composition root validates the key at startup (fail-fast) and, in non-prod only, generates an
   * ephemeral key.
   */
  evidenceBundleSigner?: EvidenceBundleSigner;
  /** Erasure undo window (ms): how long a tenant may cancel a scheduled erasure. Defaults to 48h. */
  erasureUndoWindowMs?: number;
  /**
   * Store for managed outbound **webhook subscriptions**. When provided (with a {@link secretStore}),
   * `createWebhookSubscription` / `listWebhookSubscriptions` / `deleteWebhookSubscription` are
   * enabled and matching events fan out to each subscription; absent ⇒ they fail closed / no-op.
   */
  webhookSubscriptionStore?: WebhookSubscriptionStore;
  /** Permit non-https webhook subscription URLs (local/testing only; default false → https enforced). */
  allowInsecureWebhookUrl?: boolean;
}

/** Default retention window (days) an archived tenant is kept before {@link TenantForge.purgeExpired}. */
const DEFAULT_RETENTION_DAYS = 30;
/** Upper bound on offboarding tenants scanned per sweep. */
const MAX_SWEEP = 100_000;

/**
 * Default dunning policy: give up after 4 consecutive failed attempts (then suspend), waiting at
 * least 24h between retries. Conservative — a card decline often clears within a day, and suspending
 * a paying tenant prematurely is worse than one more wait.
 */
export const DEFAULT_DUNNING_SCHEDULE: DunningSchedule = {
  maxAttempts: 4,
  minHoursBetweenAttempts: 24,
};

/** Options for {@link TenantForge.purgeExpired}. */
export interface PurgeSweepOptions {
  /** Retention window in days; archived tenants older than this are purged. Defaults to 30. */
  retentionDays?: number;
  /** The current instant (injectable for testing); defaults to now. */
  now?: Date;
}

/** The result of a retention purge sweep. */
export interface PurgeSweepReport {
  /** Number of `offboarding` tenants examined. */
  scanned: number;
  /** Tenant ids purged this sweep. */
  purged: string[];
  /** Tenants that failed to purge (isolated — they don't block the sweep; retried next run). */
  failed: { tenantId: string; error: string }[];
}

/** The result of an erasure-executor sweep (drains due, window-elapsed pending erasures). */
export interface ErasureSweepReport {
  /** Number of due pending-erasure records the sweep examined this run. */
  scanned: number;
  /** Request ids whose erasure this sweep executed (won the atomic `pending → processing` flip). */
  processed: string[];
  /**
   * Request ids skipped because they lost the atomic flip — already cancelled by the tenant, or an
   * at-least-once redelivery / concurrent sweep claimed them. A no-op, not an error.
   */
  skipped: string[];
  /** Records whose erasure errored (isolated — one tenant's failure never blocks the rest; retried). */
  failed: { id: string; tenantId: string; error: string }[];
}

/** The result of offboarding (archiving) a tenant. */
export interface OffboardOutcome {
  /** The tenant record (now `offboarding` — retained, pending purge; reversible until purged). */
  tenant: TenantRecord;
  /** A reference to the retained archive (e.g. `neon-project:<id>`), or null if no exporter is wired. */
  archive: ExportResult | null;
}

/** A request to provision a tenant. */
export interface ProvisionInput {
  /** Desired slug (validated + normalized). */
  slug: string;
  /**
   * Region override. When omitted, the region is chosen automatically: if `residency` is set, the
   * ResidencyRouter selects a compliant region from the allow-list; otherwise the configured default.
   */
  region?: string;
  /**
   * Required data-residency jurisdiction (e.g. `eu`). With an explicit `region`, that region must
   * belong to it or provisioning fails closed; with no `region`, the ResidencyRouter *selects* a
   * compliant one from the allow-list (std-privacy).
   */
  residency?: Jurisdiction;
  /** Optional non-sensitive metadata. */
  metadata?: JsonObject;
}

/** The result of a provision call. */
export interface ProvisionOutcome {
  /** The tenant record (active on success). */
  tenant: TenantRecord;
  /**
   * The owner connection URI for the freshly created project — a **secret**. Present only when this
   * call created the project; `null` when an already-provisioned tenant was returned (idempotent
   * re-request). The caller hands it to a secret manager and never logs it.
   */
  connectionUri: string | null;
}

/** Input to adopt an EXISTING Neon project into the registry as a managed tenant. */
export interface ImportInput {
  /** Desired slug (validated + normalized). */
  slug: string;
  /** The existing Neon project's id to adopt (NOT created — it already exists). */
  neonProjectId: string;
  /**
   * The existing project's owner connection URI — a **secret** supplied by the operator. Stored in
   * the SecretStore (keyed by tenant id) and never logged. Required because, unlike provision, no
   * project is created here to mint one.
   */
  connectionUri: string;
  /** Region the existing project lives in (validated + allow-list/residency-checked like provision). */
  region?: string;
  /** Required data-residency jurisdiction; the region must satisfy it or import fails closed. */
  residency?: Jurisdiction;
  /** Optional non-sensitive metadata. */
  metadata?: JsonObject;
}

/** The result of an import call — the adopted tenant (no connection URI: it was supplied inbound). */
export interface ImportOutcome {
  /** The adopted tenant record (active). */
  tenant: TenantRecord;
}

/** A readiness report: overall status plus per-dependency check results. */
export interface HealthReport {
  /** `ok` when every dependency check passed; `degraded` otherwise. */
  status: 'ok' | 'degraded';
  /** Per-dependency outcomes. */
  checks: {
    /** Control-plane registry connectivity (the hard dependency for every operation). */
    registry: 'ok' | 'error';
  };
}

/** The outcome of delivering one tenant's invoice by email. */
export interface InvoiceSendResult {
  /** The tenant billed. */
  tenantId: string;
  /** Whether the invoice email was handed to the notifier. */
  sent: boolean;
  /** Why it was not sent (e.g. `no billing email`), when `sent` is false. */
  reason?: string;
  /** The invoice total (USD). */
  totalUsd: number;
}

/** A fleet invoice-delivery run. */
export interface FleetInvoiceDeliveryReport {
  /** When the run was generated (ISO-8601 UTC). */
  generatedAt: string;
  /** Tenants whose invoice was delivered (sorted by id). */
  sent: string[];
  /** Tenants skipped (no billing email / nothing to send), with the reason. */
  skipped: { tenantId: string; reason: string }[];
  /** Tenants whose delivery failed (isolated — they don't block the run). */
  failed: { tenantId: string; error: string }[];
}

/** The result of issuing a signup token — the **raw token is returned once** and never stored. */
export interface SignupTokenIssued {
  /** The raw token (show once; the customer redeems with it). Never persisted or logged. */
  token: string;
  /** The desired tenant slug this token provisions. */
  slug: string;
  /** Expiry instant (ISO-8601 UTC). */
  expiresAt: string;
}

/** A redacted signup-token summary for listing (never includes the hash or raw token). */
export interface SignupTokenSummary {
  /** The desired tenant slug. */
  slug: string;
  /** Lifecycle status at read time. */
  status: SignupTokenStatus;
  /** Optional region override. */
  region?: string;
  /** Optional plan id recorded on the tenant. */
  planId?: string;
  /** Expiry instant (ISO-8601 UTC). */
  expiresAt: string;
  /** When issued (ISO-8601 UTC). */
  createdAt: string;
  /** When redeemed (ISO-8601 UTC), if redeemed. */
  redeemedAt?: string;
  /** The tenant provisioned on redemption, if redeemed. */
  redeemedTenantId?: string;
}

/** Input to start a self-serve signup: the email to verify + a solved captcha token. */
export interface StartSignupInput {
  /** The customer's email (PII — never logged). */
  email: string;
  /** The captcha widget token (verified server-side before any cost-incurring step). */
  captchaToken: string;
  /** Optional caller IP, passed to the captcha provider for extra signal. */
  remoteIp?: string;
}

/** Input to complete a signup once a payment method is saved: the chosen tenant config. */
export interface CompleteSignupInput {
  /** Desired tenant slug (validated; must be available). */
  slug: string;
  /** Optional explicit region (allow-list checked); else resolved from residency/default. */
  region?: string;
  /** Optional residency to route the region (data residency). */
  residency?: Jurisdiction;
  /** Optional plan id from the catalog (recorded on the tenant). */
  planId?: string;
}

/** A pending payment-method setup handed to the browser (Stripe.js confirms it client-side). */
export interface SignupPaymentSetup {
  /** The PSP client secret for the browser SDK to confirm the setup intent. */
  clientSecret: string;
  /** The setup-intent id (verified server-side on completion). */
  setupIntentId: string;
}

/** The result of confirming + setting a tenant's default payment method (no card data; safe to show). */
export interface TenantPaymentMethodResult {
  /** The tenant the method was set for (the session tenant). */
  tenantId: string;
  /** Whether a default payment method is now on file. */
  hasDefault: true;
  /** The PSP setup-intent id that was verified (a reference, not card data). */
  setupIntentId: string;
}

/** A safe-projection view of a tenant's scheduled (cancellable) erasure for the portal. */
export interface PendingErasureView {
  /** ISO-8601 when the erasure was requested. */
  requestedAt: string;
  /** ISO-8601 after which the erasure executes — the customer can cancel until then. */
  executeAt: string;
  /** Current status (the undo-window state). */
  status: PendingErasureRecord['status'];
}

/** The outcome of a self-serve cancel (offboard) — includes the reversibility deadline to surface. */
export interface TenantCancelResult {
  /** The tenant id (the session tenant). */
  tenantId: string;
  /** The tenant's status after cancel (`offboarding`). */
  status: string;
  /**
   * ISO-8601 deadline after which the cancel is no longer self-/operator-reversible (the project is
   * eligible for purge) — `offboardedAt + retentionDays`. Surfaced so the customer knows the window.
   */
  reversibleUntil: string;
}

/** The outcome of scheduling a self-serve erasure (the undo window is now open). */
export interface TenantErasureRequestResult {
  /** The tenant id (the session tenant). */
  tenantId: string;
  /** ISO-8601 when the erasure was requested. */
  requestedAt: string;
  /** ISO-8601 after which it executes (request + undo window) — the customer can cancel until then. */
  executeAt: string;
  /** The undo-window state (`pending`). */
  status: PendingErasureRecord['status'];
}

/**
 * Signup funnel status for the poller. `connectionUri` is present **once** — the single in-app reveal
 * after the tenant goes active (never emailed/logged; master §5).
 */
export interface SignupStatus {
  /** Current funnel state. */
  status: SignupRequestStatus;
  /** The chosen slug, once set. */
  slug?: string;
  /** The one-time connection URI (only on the first poll after activation). */
  connectionUri?: string;
}

/** The TenantForge control-plane API (library surface). */
export interface TenantForge {
  /** Apply the control-plane registry migrations idempotently. */
  migrate(): Promise<void>;

  /**
   * Readiness check: probe critical dependencies (registry connectivity) and report status. Fail-soft
   * — never throws; a failed dependency yields `status: 'degraded'`. Use for a readiness probe
   * (distinct from a static liveness check). The Neon API is a per-call upstream (its own timeouts /
   * bounded retries), deliberately **not** probed here to avoid hitting it on every readiness tick.
   *
   * @returns The health report.
   */
  health(): Promise<HealthReport>;

  /**
   * Provision a tenant: create an isolated Neon project, record it, and activate the tenant.
   * Idempotent on slug and resumable if a prior attempt was interrupted mid-provision.
   *
   * @param input - The desired slug, optional region, and metadata.
   * @returns The tenant record and (only when newly created) its connection secret.
   */
  provision(input: ProvisionInput): Promise<ProvisionOutcome>;

  /**
   * **Adopt an existing Neon project** into the registry as a managed tenant — the migration-
   * onboarding path (bring a fleet already on Neon under TenantForge management) without creating
   * or destroying a project. Mirrors {@link TenantForge.provision} minus the Neon-API create: the
   * operator supplies the existing `neonProjectId` + its `connectionUri` (stored as the per-tenant
   * secret, never logged). Same slug + region/residency validation; fails closed on a slug already
   * in use. Builder-only — mapping an existing project to your tenant identity is knowledge Neon
   * doesn't have. CLI/HTTP only (it accepts a secret) — not the agent surface.
   *
   * @param input - The slug, existing project id + connection URI, optional region/residency/metadata.
   * @returns The adopted (active) tenant record.
   * @throws If the slug is already in use, or the region violates the required residency.
   */
  importTenant(input: ImportInput): Promise<ImportOutcome>;

  /**
   * **Issue a one-time signup/invite token** scoped to a desired `slug` (+ optional region / plan),
   * expiring after `ttlSeconds` (default 7 days). Returns the **raw token once** — only its hash is
   * stored, so it can't be recovered later (treat it like a credential). The operator hands the
   * token to a prospective tenant; redeeming it provisions the tenant. Creating a token is an
   * operator action — **CLI/library only** (never HTTP/MCP). Requires a signup-token store.
   *
   * @param opts - Desired `slug` and optional `region` / `planId` / `ttlSeconds`.
   * @returns The raw token, slug, and expiry.
   * @throws Error if no signup-token store is wired or the slug is invalid.
   */
  issueSignupToken(opts: {
    slug: string;
    region?: string;
    planId?: string;
    ttlSeconds?: number;
  }): Promise<SignupTokenIssued>;

  /**
   * **Redeem a signup token** → provision the tenant it was issued for (the self-serve "signup"
   * step; call this from your authenticated signup handler). Validates the token (unknown / expired
   * / already-redeemed all fail closed), provisions with the token's slug/region (+ records its
   * plan), and marks the token consumed (single-use). Provisions real resources — **CLI/library
   * only** (never HTTP/MCP). Requires a signup-token store.
   *
   * @param token - The raw token from {@link TenantForge.issueSignupToken}.
   * @returns The provisioned tenant + connection secret (as {@link TenantForge.provision}).
   * @throws Error if no store is wired, or the token is unknown / expired / already redeemed.
   */
  redeemSignupToken(token: string): Promise<ProvisionOutcome>;

  /**
   * List recent signup tokens (redacted — never the hash or raw token), newest-first, with each
   * token's current status. Read-only; returns `[]` when no store is wired.
   *
   * @param limit - Max rows (default 50).
   * @returns The token summaries.
   */
  listSignupTokens(limit?: number): Promise<SignupTokenSummary[]>;

  /**
   * **Self-serve signup — step 1.** Verify the captcha (fail-closed), open a funnel record, and email
   * a one-time verification code. Returns the opaque signup id (the HTTP layer binds it to a signed,
   * short-lived session cookie). Requires the signup ports + a notifier; fails closed otherwise.
   *
   * @param input - Email + captcha token (+ optional caller IP).
   * @returns The signup id to carry through the remaining steps.
   */
  startSignup(input: StartSignupInput): Promise<{ signupId: string }>;

  /**
   * **Self-serve signup — step 2.** Verify the emailed code for a signup (single-use, attempt-capped,
   * timing-safe). Advances the funnel to `email_verified`. Throws on an unknown signup, or an expired /
   * locked / already-verified / mismatched code.
   *
   * @param signupId - The signup id from {@link startSignup}.
   * @param code - The code the customer received by email.
   */
  verifyEmail(signupId: string, code: string): Promise<void>;

  /**
   * **Self-serve signup — step 3.** Only after the email is verified (card-testing guard): create the
   * PSP customer + a setup intent and return the client secret for Stripe.js to collect the card
   * client-side. Idempotent — re-calling reuses the customer. Card data never touches this server.
   *
   * @param signupId - The signup id.
   * @returns The client secret + setup-intent id for the browser SDK.
   */
  createPaymentSetup(signupId: string): Promise<SignupPaymentSetup>;

  /**
   * **Self-serve signup — step 4.** Verify (server-side) that the setup intent succeeded + a payment
   * method is saved, validate slug/region/plan, then **enqueue** an async `provision` command carrying
   * the billing metadata. Returns the new funnel status (`provisioning`). Throws on unconfirmed
   * payment, an unavailable slug (generic — no enumeration), or an unknown plan.
   *
   * @param signupId - The signup id.
   * @param input - Chosen slug + optional region/residency/plan.
   * @returns The funnel status after completion.
   */
  completeSignup(signupId: string, input: CompleteSignupInput): Promise<SignupStatus>;

  /**
   * **Self-serve signup — status poll.** Returns the funnel status; when the tenant has become active,
   * reveals the one-time connection URI exactly once (then never again). Bound to the signup's own
   * slug — a request can only ever see its own tenant.
   *
   * @param signupId - The signup id.
   * @returns The current status (+ the connection URI on the first post-activation poll).
   */
  signupStatus(signupId: string): Promise<SignupStatus>;

  /**
   * **Create a managed webhook subscription**: an endpoint that receives matching control-plane
   * events, each HMAC-signed with this subscription's own secret. The URL is SSRF-validated
   * (https). The signing **secret is returned ONCE** here (stored encrypted in the SecretStore; the
   * receiver uses it to verify our `X-TenantForge-Signature`). `eventTypes` is an allow-list; empty
   * = every event. CLI/HTTP only (it returns a secret) — never the agent surface.
   *
   * @param input - The destination URL and optional event-type filter.
   * @returns The created subscription incl. the one-time signing secret.
   * @throws If no subscription store is wired, or the URL fails SSRF validation.
   */
  createWebhookSubscription(input: {
    url: string;
    eventTypes?: readonly string[];
  }): Promise<WebhookSubscriptionCreated>;

  /**
   * List webhook subscriptions (redacted — never the signing secret), newest-first. Read-only;
   * returns `[]` when no store is wired.
   *
   * @param limit - Max rows (default 50).
   * @returns The subscription summaries.
   */
  listWebhookSubscriptions(limit?: number): Promise<WebhookSubscriptionSummary[]>;

  /**
   * Delete a webhook subscription and crypto-shred its signing secret.
   *
   * @param id - The subscription id.
   * @returns `true` if a subscription was removed, `false` if none matched.
   */
  deleteWebhookSubscription(id: string): Promise<boolean>;

  /**
   * Look up a tenant by id.
   *
   * @param id - The tenant id.
   * @returns The record, or null if not found.
   */
  getTenant(id: string): Promise<TenantRecord | null>;

  /**
   * List tenants, most-recent first.
   *
   * @param options - Optional status filter and page size.
   * @returns The matching records.
   */
  listTenants(options?: {
    status?: TenantStatus;
    limit?: number;
    cursor?: { createdAt: Date; id: string };
  }): Promise<TenantRecord[]>;

  /**
   * Suspend an active tenant (e.g. non-payment). Reversible via {@link TenantForge.resume}.
   *
   * @param id - The tenant id.
   * @returns The updated record.
   */
  suspend(id: string): Promise<TenantRecord>;

  /**
   * Resume a **suspended** tenant back to active. Reactivating an *offboarded* tenant is gated by
   * the retention policy — use {@link TenantForge.restore} for that (this rejects an `offboarding`
   * tenant so the gate can't be bypassed).
   *
   * @param id - The tenant id.
   * @returns The updated record.
   */
  resume(id: string): Promise<TenantRecord>;

  /**
   * Restore an **offboarded** tenant back to active (un-archive), provided it is still **within its
   * retention window** — past the window it is eligible for purge and restore is refused (fail
   * closed). The inverse of {@link TenantForge.offboard}: the Neon project and connection secret were
   * retained, so this is just the reverse status transition (no re-provisioning). Lets an operator
   * recover from an accidental/premature offboard.
   *
   * @param id - The tenant id.
   * @returns The updated record (`active`).
   * @throws If the tenant is not `offboarding`, or is past its retention window.
   */
  restore(id: string): Promise<TenantRecord>;

  /**
   * Offboard a tenant: stop serving and **archive** it — the Neon project is retained (scaled to
   * zero ≈ $0 idle) for the retention window, not deleted. **Reversible** via {@link TenantForge.restore}
   * until {@link TenantForge.purge}. This honors export-then-delete by keeping the data recoverable
   * during retention (`@rules/workflow-data-lifecycle.md`).
   *
   * @param id - The tenant id.
   * @returns The tenant record (`offboarding`) and a reference to the retained archive.
   */
  offboard(id: string): Promise<OffboardOutcome>;

  /**
   * **Export a tenant's data** to durable storage and return a reference — the data-portability /
   * DSAR path (GDPR Art. 20). Unlike {@link TenantForge.offboard} / {@link TenantForge.erase}, this
   * **does not** change the tenant's state or delete anything: the tenant stays active and is given
   * a copy of its data. Records a `tenant.exported` audit event (location + size — a reference, not
   * the data). Reads tenant data → **CLI/library only** (never HTTP/MCP). Requires an exporter.
   *
   * @param id - The tenant id.
   * @returns A reference to the written export (`location` + optional `bytes`).
   * @throws Error if the tenant is unknown or no exporter is configured.
   */
  exportTenantData(id: string): Promise<ExportResult>;

  /**
   * Recent **data-export history** (`tenant.exported` events) from the persisted audit trail.
   * Returns `[]` without an audit store.
   *
   * @param limit - Max entries, newest-first (default 20).
   * @returns The matching events, newest first.
   */
  exportHistory(limit?: number): Promise<TenantEvent[]>;

  /**
   * Purge an offboarded tenant: **irreversibly** delete its Neon project, crypto-shred its
   * connection secret, and mark it `deleted`. The deferred hard-delete after the retention window —
   * run manually or by a scheduled job. Only valid for an `offboarding` (or never-provisioned)
   * tenant.
   *
   * @param id - The tenant id.
   * @returns The deleted tenant record.
   */
  purge(id: string): Promise<TenantRecord>;

  /**
   * Purge every archived (`offboarding`) tenant past its retention window — the scheduled retention
   * sweep (run by a cron / K8s CronJob). Failure-isolated and idempotent: a tenant that fails is
   * reported and retried next run; already-purged tenants are gone so won't reappear.
   *
   * @param options - Retention window (days) and an injectable clock.
   * @returns Per-tenant sweep report (scanned / purged / failed).
   */
  purgeExpired(options?: PurgeSweepOptions): Promise<PurgeSweepReport>;

  /**
   * **Retention report** (read-only) — which archived (`offboarding`) tenants are scheduled for
   * purge and when, given the retention window. The read-only preview of what {@link
   * TenantForge.purgeExpired} would eventually delete; eligibility matches the sweep exactly. The
   * operator's data-retention policy — not a Neon concept.
   *
   * @param options - Optional `retentionDays` (defaults to the configured window) and `now`.
   * @returns The retention report (eligible / pending counts + per-tenant rows).
   */
  retentionReport(options?: { retentionDays?: number; now?: Date }): Promise<RetentionReport>;

  /**
   * Erase a tenant under a right-to-erasure request (GDPR Art. 17 / CCPA — ErasureEngine #17): an
   * optional final export, then delete the project, crypto-shred the secret, mark `deleted`, verify,
   * and return a **cryptographically signed** {@link SignedErasureCertificate}. Unlike
   * {@link TenantForge.purge}, erasure is the legal-override path — it applies from **any** state,
   * not just an offboarded tenant. Inspect `.certificate.verified` (a `false` is a remediation
   * signal — the data is already gone); `.jws` is the EdDSA/Ed25519 compact JWS an auditor verifies
   * with `verifyErasureCertificate` against {@link TenantForge.erasureCertificatePublicKey}.
   *
   * **Always-signed:** fails closed if no certificate signer is configured (no unsigned erasure).
   *
   * @param id - The tenant to erase.
   * @param options - The audit reason and export choice.
   * @returns The signed erasure certificate.
   * @throws Error if no certificate signer is configured.
   */
  erase(id: string, options: EraseOptions): Promise<SignedErasureCertificate>;

  /**
   * The **public** verification key (Ed25519 JWK) for erasure certificates — publish this to
   * auditors / data subjects so they can verify a certificate's `.jws` with
   * `verifyErasureCertificate`. Contains no private material.
   *
   * @returns The public Ed25519 JWK, or `null` when no certificate signer is configured.
   */
  erasureCertificatePublicKey(): Promise<import('jose').JWK | null>;

  /**
   * Re-home an active tenant to a new region (#5) — for a residency change or latency optimization.
   * Provisions a new project in the target region, copies the data (via the injected data mover),
   * switches the registry + connection secret over, then decommissions the old project. Fail closed:
   * a copy failure rolls back the new project and leaves the source intact. Requires a `dataMover`.
   *
   * @param id - The tenant to relocate.
   * @param options - The target region + optional required jurisdiction.
   * @returns The re-home result.
   */
  rehome(id: string, options: RehomeOptions): Promise<RehomeResult>;

  /**
   * Rotate one active tenant's connection credential (#7): mint a new one on its Neon project, store
   * it, and invalidate any cached connection (workflow-secrets / secret-rotation runbook).
   *
   * @param id - The tenant to rotate.
   * @returns The rotation result.
   */
  rotateSecret(id: string): Promise<RotationResult>;

  /**
   * Rotate every active tenant's connection credential — the scheduled fleet sweep (cron / CronJob).
   * Failure-isolated: one tenant's failure is reported, not fatal.
   *
   * @param options - Optional scan cap.
   * @returns Per-tenant sweep report.
   */
  rotateSecrets(options?: { limit?: number }): Promise<RotationSweepReport>;

  /**
   * Take a point-in-time snapshot of one active tenant's database (a Neon branch — instant,
   * copy-on-write). Requires a configured snapshot provider; fails closed otherwise.
   *
   * @param id - The tenant to snapshot.
   * @returns The snapshot result.
   */
  snapshot(id: string): Promise<SnapshotResult>;

  /**
   * Snapshot every active tenant — the scheduled backup sweep (cron / CronJob). Failure-isolated.
   *
   * @param options - Optional scan cap.
   * @returns Per-tenant sweep report.
   */
  snapshotFleet(options?: { limit?: number }): Promise<BackupSweepReport>;

  /**
   * Prune every active tenant's snapshots under the retention policy — the scheduled retention
   * sweep. Failure-isolated.
   *
   * @param options - Optional scan cap and retention override (defaults to keeping the 7 newest).
   * @returns Per-tenant sweep report.
   */
  pruneSnapshots(options?: {
    limit?: number;
    policy?: RetentionPolicy;
  }): Promise<BackupSweepReport>;

  /**
   * Restore a tenant's database to a snapshot (destructive recovery — overwrites live data).
   * Requires a configured snapshot provider; fails closed otherwise.
   *
   * @param id - The tenant to restore.
   * @param snapshotId - The snapshot (branch) id to restore from.
   */
  restoreSnapshot(id: string, snapshotId: string): Promise<void>;

  /**
   * Archive one active tenant off-Neon (pg_dump → object store) — the durable long-term backup tier.
   * Requires a configured archive exporter; fails closed otherwise.
   *
   * @param id - The tenant to archive.
   * @returns The archive result.
   */
  archive(id: string): Promise<ArchiveResult>;

  /**
   * Archive every active tenant off-Neon — the scheduled long-term backup sweep. Failure-isolated.
   * Archive retention is the object store's lifecycle policy (S3/GCS), not app-managed.
   *
   * @param options - Optional scan cap.
   * @returns Per-tenant sweep report.
   */
  archiveFleet(options?: { limit?: number }): Promise<BackupSweepReport>;

  /**
   * Check one active tenant's metered consumption over `period` against `quota` (detection only —
   * emits an audit event; the caller decides whether to act). Requires a usage provider.
   *
   * @param id - The tenant to check.
   * @param period - The billing period to meter.
   * @param quota - The limits to enforce.
   * @returns The quota check result (exceeded + breaches).
   */
  checkQuota(id: string, period: BillingPeriod, quota: Quota): Promise<QuotaCheckResult>;

  /**
   * Check every active tenant against `quota` — the scheduled quota sweep. Failure-isolated. With
   * `enforce: true`, over-quota tenants are **suspended** (reversible) rather than only reported —
   * opt-in, since auto-suspending a tenant is impactful. Requires a usage provider.
   *
   * @param period - The billing period to meter.
   * @param quota - The limits to enforce.
   * @param options - Optional scan cap and `enforce` (suspend on breach).
   * @returns The sweep report.
   */
  checkQuotas(
    period: BillingPeriod,
    quota: Quota,
    options?: { limit?: number; enforce?: boolean },
  ): Promise<QuotaSweepReport>;

  /**
   * **Check the fleet for usage alerts** over `period` — tenants approaching/exceeding the included
   * allowances their plan defines (`metadata.includedUsage`), at the configured thresholds
   * (`usageAlertThresholds`, e.g. 80% / 100%). Failure-isolated. Emits a `tenant.usage_alert` event
   * per alerted tenant (fanned to any outbound webhook). When `notify` is set and a notifier is
   * wired, also emails each alerted tenant's `metadata.billingEmail` (best-effort). This applies the
   * operator's plan-allowance policy on top of Neon's metering — Neon has no notion of per-tenant
   * plan allowances, so this is not a Neon feature. Requires a usage provider + configured thresholds.
   *
   * @param period - The billing period to meter.
   * @param options - Optional scan cap and `notify` (email alerted tenants).
   * @returns The sweep report (only tenants with alerts are listed).
   */
  checkUsageAlerts(
    period: BillingPeriod,
    options?: { limit?: number; notify?: boolean },
  ): Promise<UsageAlertSweepReport>;

  /**
   * Recent **usage-alert history** (`tenant.usage_alert` events) from the persisted audit trail.
   * Returns `[]` when no audit store is wired.
   *
   * @param limit - Max events to return (default 20).
   * @returns The matching events, newest first.
   */
  usageAlertHistory(limit?: number): Promise<TenantEvent[]>;

  /**
   * Generate a point-in-time **compliance report** over the fleet — physical-isolation and
   * data-residency attestations derived from the registry — with a SHA-256 integrity digest. Emits
   * *evidence* (queryable facts), not a legal certification.
   *
   * @returns The report and its digest.
   */
  complianceReport(): Promise<ComplianceReportResult>;

  /**
   * Generate a point-in-time **signed compliance report** over the fleet — the same attestation as
   * {@link TenantForge.complianceReport}, but with the integrity anchor upgraded to an **EdDSA
   * (Ed25519) compact JWS** that an auditor can verify **offline with only the published public key**
   * (`verifyComplianceReport` against {@link TenantForge.complianceReportPublicKey}) — ADR-0011 Phase 1
   * of the compliance evidence layer. The legacy SHA-256 `digest` is retained alongside the `jws` for
   * backward compatibility. The JWS uses a domain `typ`/`kid` distinct from the erasure certificate's,
   * so the two artifact classes are never confusable.
   *
   * **Fails closed** if no compliance-report signer is configured (no unsigned signed-report path) —
   * production requires `TENANTFORGE_COMPLIANCE_SIGNING_KEY` (validated at startup); non-prod with no
   * key uses an ephemeral key (not verifiable across restarts). The plain {@link
   * TenantForge.complianceReport} is unaffected and needs no signer.
   *
   * @returns The report, its JWS authenticity anchor, and the legacy SHA-256 digest.
   * @throws Error if no compliance-report signer is configured.
   */
  signedComplianceReport(): Promise<SignedComplianceReport>;

  /**
   * The **public** verification key (Ed25519 JWK) for **compliance reports** — publish this to
   * auditors so they can verify a signed report's `.jws` with `verifyComplianceReport`. Contains no
   * private material. Distinct from {@link TenantForge.erasureCertificatePublicKey} (different
   * purpose/kid), though both may be backed by the same physical key.
   *
   * @returns The public Ed25519 JWK, or `null` when no compliance-report signer is configured.
   */
  complianceReportPublicKey(): Promise<import('jose').JWK | null>;

  /**
   * Assemble a point-in-time, signed **evidence bundle** (ADR-0011 Phase 2) — a single,
   * auditor-consumable pack of the isolation proof, residency attestation, a PII-minimized audit
   * excerpt, and the embedded **signed** erasure certificate(s), for either the whole **fleet** or a
   * single **tenant**. The bundle is signed as an **EdDSA (Ed25519) compact JWS** that an auditor
   * verifies **offline with only the published public key** (`verifyEvidenceBundle` against
   * {@link TenantForge.evidenceBundlePublicKey}). The embedded erasure-certificate JWS strings are
   * folded in **opaque** (not re-signed) and remain **independently verifiable** via
   * `verifyErasureCertificate`.
   *
   * **Per-tenant scope is a BOLA boundary:** with `scope: 'tenant'` the bundle filters **every**
   * artifact to the one **server-derived** `tenantId` — a tenant's bundle can never carry another
   * tenant's facts. (Retrieval/access-control is Phase 3; this method assembles + signs only — no new
   * HTTP/CLI/MCP surface yet.) `erasureCertificates` are caller-supplied already-signed JWS strings
   * (Phase 3 wires their persisted source); omitted ⇒ none.
   *
   * **Fails closed** if no evidence-bundle signer is configured (no unsigned bundle path) —
   * production requires `TENANTFORGE_COMPLIANCE_SIGNING_KEY` (the shared evidence key; validated at
   * startup); non-prod with no key uses an ephemeral key (not verifiable across restarts).
   *
   * @param options - Scope (`fleet` | `tenant`), the server-derived `tenantId` (required for tenant
   *   scope), and optional already-signed `erasureCertificates` JWS strings to embed.
   * @returns The signed evidence bundle (`{ bundle, jws }`).
   * @throws Error if no evidence-bundle signer is configured, or the scope/tenant pairing is invalid
   *   (tenant scope without an id, fleet scope with one, or an unknown scoped tenant).
   */
  evidenceBundle(options: {
    scope: EvidenceScope;
    tenantId?: string;
    erasureCertificates?: readonly string[];
  }): Promise<SignedEvidenceBundle>;

  /**
   * The **public** verification key (Ed25519 JWK) for **evidence bundles** — publish this to auditors
   * so they can verify a signed bundle's `.jws` with `verifyEvidenceBundle`. Contains no private
   * material. Per ADR-0011 the bundle reuses the compliance evidence key, so this matches
   * {@link TenantForge.complianceReportPublicKey} byte-for-byte when both are configured; it is
   * exposed separately for clarity of purpose.
   *
   * @returns The public Ed25519 JWK, or `null` when no evidence-bundle signer is configured.
   */
  evidenceBundlePublicKey(): Promise<import('jose').JWK | null>;

  /**
   * **Query the audit trail** — the general, filterable view over the operator-attributed,
   * append-only control-plane event stream (who-did-what-when; NIST AU / SOC2 / OWASP A09). Filter
   * by event name(s), tenant, and a `since` lower bound; results are newest-first and bounded
   * (`limit` clamped). Read-only; returns `[]` when no audit store is wired. The narrow
   * `*History` methods are conveniences over this. Events are already redacted (master §5).
   *
   * @param query - Optional `events` / `tenantId` / `since` filters and a `limit`.
   * @returns Matching audit events, most-recent first.
   */
  queryAudit(query?: AuditQueryInput): Promise<TenantEvent[]>;

  /**
   * **Scan the recent audit trail for anomalies** — an overall error spike plus per-actor /
   * per-tenant error clusters (std-mitre-attack detection / topic-logging-observability: alert on
   * error bursts + repeated failures). Reads a recent window and runs the pure
   * {@link detectAuditAnomalies}; read-only, returns `[]` when no audit store is wired. Builder-side
   * control-plane detection — Neon has no record of these operations.
   *
   * @param opts - Optional `since` lower bound, window `limit` (default 500), and `thresholds`.
   * @returns The detected anomalies (most severe orderings first; empty when none).
   */
  scanAuditAnomalies(opts?: {
    since?: string;
    limit?: number;
    thresholds?: AnomalyThresholds;
  }): Promise<AuditAnomaly[]>;

  /**
   * Per-tenant **cost / margin** report over `period`: estimated Neon cost (from the configured
   * rates) vs. the operator's price (tenant `metadata.priceUsd`), flagging unprofitable tenants.
   * Read-only attribution — not an invoice. Requires a usage provider.
   *
   * @param period - The billing period to meter.
   * @returns The cost report.
   */
  costReport(period: BillingPeriod): Promise<CostReport>;

  /**
   * **Scan the fleet for cost/margin anomalies** over `period` — tenants that are unprofitable or
   * **consuming without a price** (always), plus opt-in thin-margin / high-cost flags. Runs the
   * cost report then the pure {@link detectCostAnomalies}; read-only, most-severe-first. Operator
   * FinOps — Neon has no notion of the operator's prices/margins, so this is not a Neon feature.
   * Requires a usage provider.
   *
   * @param period - The billing period to meter.
   * @param thresholds - Optional `minMarginUsd` (thin-margin) / `maxCostUsd` (high-cost) opt-ins.
   * @returns The detected cost anomalies (empty when none).
   */
  scanCostAnomalies(
    period: BillingPeriod,
    thresholds?: CostAnomalyThresholds,
  ): Promise<CostAnomaly[]>;

  /**
   * **Operator alert digest** — aggregate the control-plane detectors (audit anomalies, cost
   * anomalies, fleet drift, retention backlog, usage alerts) into one operational-health summary
   * with an overall severity (`ok`/`info`/`warning`/`critical`). Read-only and best-effort per
   * detector (a detector that can't run contributes nothing). Always emits an `operator.digest`
   * event (the webhook/SIEM alert hook); with `notify` + a configured notifier + operator email it
   * also emails the digest for a non-`ok` severity. The single pane an operator checks instead of
   * running five scans — builder-only (Neon has no view of your control-plane operations).
   *
   * @param options - Optional billing `period` (defaults to the current month) and `notify`.
   * @returns The assembled {@link OperatorDigest}.
   */
  operatorDigest(options?: { period?: BillingPeriod; notify?: boolean }): Promise<OperatorDigest>;

  /**
   * Generate an **invoice document** for one tenant over `period`: its usage billed at the
   * configured billing (sell) rates plus its flat plan fee (`metadata.priceUsd`). An artifact (line
   * items + total) — it does **not** charge a card. Requires a usage provider.
   *
   * @param id - The tenant id.
   * @param period - The billing period.
   * @returns The invoice.
   */
  invoice(id: string, period: BillingPeriod): Promise<Invoice>;

  /**
   * Generate invoices for every active tenant over `period` (failure-isolated — unmeterable tenants
   * are listed, not failed). Requires a usage provider.
   *
   * @param period - The billing period.
   * @returns The fleet invoice report.
   */
  invoiceFleet(period: BillingPeriod): Promise<FleetInvoiceReport>;

  /**
   * **Deliver** a tenant's invoice for `period` by email to its `metadata.billingEmail` — generates
   * the invoice document, renders it, and sends it via the configured notifier (de-duplicated per
   * tenant + period). An outward send (not money movement), so the surface is CLI/library only —
   * never HTTP/MCP; the recipient address is never recorded in the audit trail (PII). Records a
   * `tenant.invoiced` event. Requires a usage provider **and** a notifier.
   *
   * @param id - The tenant id.
   * @param period - The billing period.
   * @returns The send outcome (sent / skipped with reason + total).
   * @throws Error if no notifier is configured, or the tenant/usage provider is unavailable.
   */
  sendInvoice(id: string, period: BillingPeriod): Promise<InvoiceSendResult>;

  /**
   * Deliver invoices to **every active tenant** for `period` (the scheduled run). Failure-isolated:
   * a tenant with no billing email is `skipped`; a delivery error is recorded under `failed` rather
   * than failing the run. CLI/library only. Requires a usage provider + a notifier.
   *
   * @param period - The billing period.
   * @returns The fleet delivery report.
   */
  sendInvoiceFleet(period: BillingPeriod): Promise<FleetInvoiceDeliveryReport>;

  /**
   * Recent **invoice-delivery history** (`tenant.invoiced` events) from the persisted audit trail.
   * Returns `[]` when no audit store is wired. The recipient address is never recorded (PII).
   *
   * @param limit - Max events to return (default 20).
   * @returns The matching events, newest first.
   */
  invoiceDeliveryHistory(limit?: number): Promise<TenantEvent[]>;

  /**
   * Resolve a tenant id to its connection, scoped to that tenant's project. Fails closed unless the
   * tenant is active, provisioned, and has a stored connection secret. The id must be derived
   * server-side from the authenticated principal, never client-supplied (BOLA).
   *
   * @param id - The server-derived tenant id.
   * @returns The tenant-scoped connection (the URI is a secret — never log it).
   */
  getConnection(id: string): Promise<TenantConnection>;

  /**
   * Apply a versioned, backward-compatible migration across all active tenants: batched,
   * bounded-concurrency, failure-isolated, and idempotent/resumable. A fleet change is a release —
   * runbook + rollback it. Requires a migration runner in the deps.
   *
   * @param spec - The migration version + SQL.
   * @param options - Batch size.
   * @returns A per-tenant report (succeeded / failed / already-applied).
   */
  migrateFleet(
    spec: FleetMigrationSpec,
    options?: MigrateFleetOptions,
  ): Promise<FleetMigrationReport>;

  /**
   * Report fleet migration **drift** (#8): which active tenants are behind the catalog's latest
   * version or have failures, and which are up to date. Read-only — applies nothing.
   *
   * @param options - Optional scan cap.
   * @returns The fleet drift report.
   */
  fleetStatus(options?: { limit?: number }): Promise<FleetDriftReport>;

  /**
   * Preview a fleet **reconciliation** (#2, read-only): which active tenants are behind the target
   * and exactly which versions each would receive. No SQL needed — derived from the catalog + state.
   *
   * @param options - Optional target version, batch size, and scan cap.
   * @returns The reconcile plan.
   */
  reconcilePlan(options?: ReconcileFleetOptions): Promise<FleetReconcilePlan>;

  /**
   * **Reconcile** the fleet (#2): bring every behind/failed active tenant up to the target by
   * applying its missing catalog versions in order, stopping at a tenant's first failure.
   * Failure-isolated, idempotent/resumable, optional canary. A fleet change is a release. Requires a
   * migration runner.
   *
   * @param specs - The ordered migration catalog (version + SQL) to reconcile toward.
   * @param options - Target version, batch size, canary tenant.
   * @returns A per-tenant reconcile report.
   */
  reconcileFleet(
    specs: readonly FleetMigrationSpec[],
    options?: ReconcileFleetOptions,
  ): Promise<FleetReconcileReport>;

  /**
   * Recent fleet **reconcile/migration history** from the persisted audit trail (who reconciled
   * what, when, and the outcome) — the durable record behind the reconcile plan. Returns `[]` when no
   * audit store is wired (the trail is only persisted with `TENANTFORGE_AUDIT_LOG=pg`).
   *
   * @param limit - Max entries to return (newest-first). Defaults to 20.
   * @returns Recent `fleet.reconcile` audit events.
   */
  reconcileHistory(limit?: number): Promise<TenantEvent[]>;

  /**
   * **Charge** a tenant for its invoice over a period via the configured payment gateway (PSP). A
   * money-moving outward action: requires a payment gateway and the tenant's `billingCustomerRef`
   * (metadata); the amount is the invoice total in minor units; the charge is **idempotent** (a retry
   * never double-bills). Emits a redacted `tenant.charged` audit event (amount/status/charge id — no
   * card data). Fails closed without a gateway / customer ref / positive amount.
   *
   * @param id - The tenant id.
   * @param period - The billing period to invoice + charge.
   * @returns The charge result (no card data).
   */
  chargeInvoice(id: string, period: BillingPeriod): Promise<ChargeResult>;

  /**
   * Charge every active tenant that has a billing customer ref for the period — failure-isolated
   * (a decline/error on one tenant never blocks others; tenants without a ref or with a zero invoice
   * are skipped, not failed). The billing-run sweep (for a cron). Requires a payment gateway.
   *
   * @param period - The billing period.
   * @returns A per-tenant charge report (charged / skipped / failed).
   */
  chargeInvoiceFleet(period: BillingPeriod): Promise<FleetChargeReport>;

  /**
   * Recent **charge history** from the persisted audit trail (`tenant.charged` events). Returns `[]`
   * when no audit store is wired.
   *
   * @param limit - Max entries, newest-first. Defaults to 20.
   * @returns Recent charge audit events.
   */
  chargeHistory(limit?: number): Promise<TenantEvent[]>;

  /**
   * Run a **dunning sweep**: for every active tenant with a billing customer ref, derive its
   * consecutive-failure count from the persisted `tenant.charged` audit trail and decide
   * (`planDunning`) whether to **retry** the charge now (with a per-attempt idempotency key so the
   * PSP makes a fresh attempt, never replays the failure), **suspend** the tenant (retries exhausted
   * — a reversible escalation), or **wait** (not failing, or within the backoff window). Each action
   * emits a redacted `tenant.dunning` audit event. Failure-isolated and idempotent — re-running is
   * safe. Requires a payment gateway and an audit store (without the trail there is no failure
   * history to act on, so every tenant is skipped).
   *
   * @param period - The billing period to (re)charge; defaults to the current month.
   * @param schedule - Retry policy; defaults to {@link DEFAULT_DUNNING_SCHEDULE}.
   * @returns A per-tenant dunning report (retried / failed / suspended / skipped).
   */
  runDunning(period?: BillingPeriod, schedule?: DunningSchedule): Promise<DunningReport>;

  /**
   * Recent **dunning history** (`tenant.dunning` events) from the persisted audit trail. Returns `[]`
   * when no audit store is wired.
   *
   * @param limit - Max entries, newest-first. Defaults to 20.
   * @returns Recent dunning audit events.
   */
  dunningHistory(limit?: number): Promise<TenantEvent[]>;

  /**
   * Run a complete **scheduled billing run** for the period: charge the fleet (each charge
   * idempotent), then run a dunning sweep so a charge that fails this run starts its retry clock.
   * The unattended capstone of the billing arc — wire it to a cron / K8s CronJob (like
   * `purge-expired`). Idempotent and failure-isolated, so a scheduler double-fire is safe. Emits a
   * roll-up `billing.run` audit event (the per-tenant charge/dunning events come from the sweeps).
   * Requires a payment gateway.
   *
   * @param period - The billing period; defaults to the current month.
   * @param opts - `skipDunning` for a charge-only run; `dunningSchedule` to override the policy.
   * @returns The combined charge + dunning report.
   */
  billingRun(period?: BillingPeriod, opts?: BillingRunOptions): Promise<BillingRunReport>;

  /**
   * Recent **billing-run history** (`billing.run` roll-up events) from the persisted audit trail.
   * Returns `[]` when no audit store is wired.
   *
   * @param limit - Max entries, newest-first. Defaults to 20.
   * @returns Recent billing-run audit events.
   */
  billingRunHistory(limit?: number): Promise<TenantEvent[]>;

  /**
   * **Refund (or credit) a prior charge**, fully or partially, via the configured gateway. Looks the
   * charge up in the persisted audit trail to recover the tenant / currency / original amount (so a
   * full refund resolves to the right currency and a partial refund is bounded); pass `currency`
   * explicitly when the charge predates the audit store. Idempotent on a per-charge+amount key so a
   * retried refund never double-refunds. Emits a redacted `tenant.refunded` audit event (refund id,
   * amount, status — no card data). Requires a payment gateway; throws on a PSP error.
   *
   * @param chargeId - The PSP charge id to refund (from charge history).
   * @param opts - `amountMinor` for a partial refund; `reason`; `currency`/`tenantId` overrides.
   * @returns The refund result (no card data).
   */
  refundCharge(chargeId: string, opts?: RefundOptions): Promise<RefundResult>;

  /**
   * Recent **refund history** (`tenant.refunded` events) from the persisted audit trail. Returns `[]`
   * when no audit store is wired.
   *
   * @param limit - Max entries, newest-first. Defaults to 20.
   * @returns Recent refund audit events.
   */
  refundHistory(limit?: number): Promise<TenantEvent[]>;

  /**
   * Recent **notification history** (`tenant.notified` events — billing receipts) from the persisted
   * audit trail. Returns `[]` when no audit store is wired. The recipient address is never recorded
   * (PII); each entry carries the kind / reference / provider / status only.
   *
   * @param limit - Max entries, newest-first. Defaults to 20.
   * @returns Recent notification audit events.
   */
  notificationHistory(limit?: number): Promise<TenantEvent[]>;

  /**
   * **Refund the unused portion of a tenant's latest charge**, prorated to `asOf` (the offboard
   * instant) — the money to return when a tenant leaves mid-period. Derives the charge id / amount /
   * currency / period from the most recent successful `tenant.charged` audit event and refunds
   * `prorateRefundMinor(...)` of it via {@link refundCharge} (idempotent). Returns the refund result,
   * or `null` when there is nothing to refund (no prior charge, or the period is fully consumed).
   * Requires a payment gateway + an audit store. Money movement — keep it CLI-gated, off HTTP/MCP.
   *
   * @param id - The tenant id.
   * @param opts - `asOf` (defaults to now), `reason` (recorded on the refund).
   * @returns The prorated refund result, or `null` if nothing is owed.
   */
  refundUnusedPeriod(
    id: string,
    opts?: { asOf?: Date; reason?: string },
  ): Promise<RefundResult | null>;

  /**
   * A **safe, customer-facing summary** of one tenant (for the self-serve portal) — id / slug /
   * region / status / plan price only; never raw metadata or internal infra ids. Returns `null` if
   * the tenant doesn't exist. The caller must pass a **server-derived** tenant id (the portal session),
   * never a client-supplied one (no cross-tenant access — `topic-multi-tenancy`).
   *
   * @param tenantId - The tenant's own id (from the authenticated portal session).
   * @returns The safe summary, or `null`.
   */
  tenantSummary(tenantId: string): Promise<TenantSummary | null>;

  /**
   * A tenant's **own** charge history (`tenant.charged` events scoped to it) for the portal. Returns
   * `[]` without an audit store. The query is tenant-filtered in the store, so it cannot return
   * another tenant's events.
   *
   * @param tenantId - The tenant's own id (server-derived).
   * @param limit - Max entries, newest-first. Defaults to 20.
   * @returns The tenant's charge events.
   */
  tenantCharges(tenantId: string, limit?: number): Promise<TenantEvent[]>;

  /**
   * A tenant's **own** refund history (`tenant.refunded` events scoped to it) for the portal. Returns
   * `[]` without an audit store. Tenant-filtered in the store.
   *
   * @param tenantId - The tenant's own id (server-derived).
   * @param limit - Max entries, newest-first. Defaults to 20.
   * @returns The tenant's refund events.
   */
  tenantRefunds(tenantId: string, limit?: number): Promise<TenantEvent[]>;

  /**
   * A tenant's **own** receipt history (`tenant.notified` events scoped to it) for the portal.
   * Returns `[]` without an audit store. Tenant-filtered in the store; the recipient address was
   * never recorded, so these entries are safe to show the tenant.
   *
   * @param tenantId - The tenant's own id (server-derived).
   * @param limit - Max entries, newest-first. Defaults to 20.
   * @returns The tenant's receipt-notification events.
   */
  tenantNotifications(tenantId: string, limit?: number): Promise<TenantEvent[]>;

  /**
   * **Preview** switching a tenant to `newPriceUsd`: the prorated settlement for the remaining period
   * (signed minor units — see {@link import('../core/billing.js').proratePlanChangeMinor}). Pure
   * quote — **no mutation, no money** — so it's safe to expose read-only.
   *
   * @param id - The tenant id.
   * @param newPriceUsd - The proposed flat plan price (USD, ≥ 0).
   * @param opts - Optional `period` / `asOf` (default current month / now).
   * @returns The prorated quote.
   */
  previewPlanChange(
    id: string,
    newPriceUsd: number,
    opts?: { period?: BillingPeriod; asOf?: Date },
  ): Promise<PlanChangePreview>;

  /**
   * **Change a tenant's plan price** (`metadata.priceUsd`) and, when `settle` is set, settle the
   * prorated delta for the remaining period — **charge** an upgrade or **refund** a downgrade (against
   * the tenant's latest charge, capped at it). Emits a `tenant.plan_changed` event. Settling moves
   * money, so the surface is CLI-only + `--yes` gated (never HTTP/MCP); requires a payment gateway
   * when `settle` is set. The price update itself always applies.
   *
   * @param id - The tenant id.
   * @param newPriceUsd - The new flat plan price (USD, ≥ 0).
   * @param opts - `period` / `asOf` / `settle`.
   * @returns The change report (quote + settlement outcome).
   */
  changePlan(id: string, newPriceUsd: number, opts?: PlanChangeOptions): Promise<PlanChangeReport>;

  /**
   * **Begin a payment-method setup for an existing tenant** (the self-serve portal's "update card").
   * Mints a PSP SetupIntent for the **tenant's own** `billingCustomerRef` (read from the registry by
   * the server-derived tenant id — never client input) and hands the browser a client secret so
   * Stripe.js can collect + confirm the card client-side (PAN never touches this server). Fails closed
   * when the tenant has no billing customer (red-team F5). Mirrors the signup
   * {@link TenantForge.createPaymentSetup} pattern for an already-provisioned tenant.
   *
   * @param tenantId - The tenant's own id (from the authenticated portal session).
   * @returns The client secret + setup-intent id.
   * @throws If self-serve payment isn't configured or the tenant has no billing customer.
   */
  tenantPaymentSetup(tenantId: string): Promise<SignupPaymentSetup>;

  /**
   * **Verify a confirmed SetupIntent and set it as the tenant's default payment method.** Never trusts
   * the client's "card saved" claim: reads the intent back server-side, requires `status === succeeded`
   * with a saved payment method, and checks `intent.customerRef === tenant.billingCustomerRef` so a
   * SetupIntent for customer X can't be applied to tenant Y (PSP-side BOLA — red-team F5). Records the
   * default in metadata and emits `tenant.payment_method_updated`.
   *
   * @param tenantId - The tenant's own id (server-derived).
   * @param setupIntentId - The SetupIntent the browser confirmed.
   * @returns A safe confirmation (no card data).
   * @throws If unconfigured, the tenant has no billing customer, or verification/ownership fails.
   */
  confirmTenantPaymentMethod(
    tenantId: string,
    setupIntentId: string,
  ): Promise<TenantPaymentMethodResult>;

  /**
   * A tenant's **recent invoices** for the portal — generated on demand for the current month and the
   * preceding `months - 1` months (invoices are generated, not stored). Requires a usage provider.
   *
   * @param tenantId - The tenant's own id (server-derived).
   * @param months - How many trailing months to include (1–12). Defaults to 3.
   * @returns Invoices, newest period first.
   */
  tenantInvoices(tenantId: string, months?: number): Promise<Invoice[]>;

  /**
   * **Request a control-plane step-up second factor** for a destructive portal action (cancel /
   * erasure). Mints a single-use, short-TTL code, persists only its hash, and delivers it to the
   * tenant's verified billing email — independent of the OIDC token (red-team F1). Fails closed
   * without a one-time-code store + notifier.
   *
   * @param tenantId - The tenant's own id (server-derived).
   * @param action - The action the code authorizes (`cancel` | `erasure`).
   * @throws If step-up isn't configured or the tenant has no billing email.
   */
  requestTenantStepUp(tenantId: string, action: 'cancel' | 'erasure'): Promise<void>;

  /**
   * **Verify a presented step-up code** for a tenant + action (single-use, constant-time, attempt-
   * locked). Returns true only on an exact, unexpired, unconsumed match bound to that action.
   *
   * @param tenantId - The tenant's own id (server-derived).
   * @param action - The action the code must be bound to.
   * @param code - The presented code.
   * @returns Whether the code verified (and was consumed).
   */
  verifyTenantStepUp(
    tenantId: string,
    action: 'cancel' | 'erasure',
    code: string,
  ): Promise<boolean>;

  /**
   * **Self-serve cancel** — offboard the **session tenant's own** account (project retained, scaled to
   * zero; reversible until purge — **never** `purge`). Excludes the tenant from billing/dunning sweeps
   * (they filter to `active`). Emits `tenant.offboarded` and alerts operator + the tenant's email.
   * Returns the reversibility deadline so the customer knows the window.
   *
   * @param tenantId - The tenant's own id (server-derived).
   * @returns The cancel outcome incl. `reversibleUntil`.
   */
  cancelTenant(tenantId: string): Promise<TenantCancelResult>;

  /**
   * **Schedule a self-serve erasure** with a mandatory undo window (red-team F2): creates a `pending`
   * record (request + window); the tenant **keeps serving** until the window elapses, when the executor
   * runs the verified-erasure engine — only if it wins an atomic flip. The customer may
   * {@link TenantForge.cancelTenantErasure} until then. Emits `tenant.erasure_requested` and alerts.
   *
   * @param tenantId - The tenant's own id (server-derived).
   * @param reason - Audit reason carried into the certificate (no secrets).
   * @returns The schedule (incl. `executeAt`).
   * @throws If self-serve erasure isn't configured or an erasure is already in flight.
   */
  requestTenantErasure(tenantId: string, reason: string): Promise<TenantErasureRequestResult>;

  /**
   * **Cancel a pending self-serve erasure** within the undo window (atomic `pending → cancelled`).
   * Returns true only if it won the flip (the executor hadn't already claimed it).
   *
   * @param tenantId - The tenant's own id (server-derived).
   * @returns Whether a pending erasure was cancelled.
   */
  cancelTenantErasure(tenantId: string): Promise<boolean>;

  /**
   * The tenant's **active pending erasure** (for the portal to show the undo deadline), or `null`.
   *
   * @param tenantId - The tenant's own id (server-derived).
   * @returns The safe pending-erasure view, or `null`.
   */
  pendingErasure(tenantId: string): Promise<PendingErasureView | null>;

  /**
   * **Execute a due pending erasure** (the scheduled executor / queue consumer). Wins an atomic
   * `pending → processing` flip before destroying anything; a lost flip (cancelled / redelivered)
   * acks and exits without erasing — idempotent across at-least-once delivery (red-team F2). Runs the
   * verified-erasure engine on the winner, marks the record `done`, and alerts operator + tenant.
   *
   * @param id - The pending-erasure request id.
   * @returns The signed erasure certificate when this call ran the erasure, else `null` (lost the flip).
   */
  executePendingErasure(id: string): Promise<SignedErasureCertificate | null>;

  /**
   * Pending erasures whose window has elapsed and are still `pending` — the executor's work queue.
   *
   * @param limit - Max records. Defaults to 100.
   * @returns Due pending-erasure ids + tenant ids.
   */
  duePendingErasures(limit?: number): Promise<{ id: string; tenantId: string }[]>;

  /**
   * **Erasure-executor sweep** — drain every **due** (window-elapsed, still-`pending`) self-serve
   * erasure and execute it: {@link duePendingErasures} → {@link executePendingErasure} per record.
   * The scheduled job that actually runs scheduled erasures (run by the worker poll loop / a cron),
   * mirroring {@link purgeExpired}. **Without it, nothing drains the pending-erasure queue and a
   * scheduled GDPR Art. 17 erasure never executes** (SLA unmeetable). **Failure-isolated** (one
   * tenant's failure never blocks the rest), bounded by `limit`, and **idempotent across redelivery /
   * concurrent sweeps**: each erasure is gated by the store's atomic `pending → processing` flip, so a
   * record claimed by a cancel or a racing sweep is reported `skipped`, never double-deleted. No-op
   * (empty report) when no pending-erasure store is wired or nothing is due. Safe to **always run**:
   * it can only act on records the (flag-gated) destructive request endpoint scheduled — while the
   * `TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE` flag is off nothing is ever scheduled, so the sweep
   * no-ops.
   *
   * @param options - Optional cap on records processed this run (defaults to 100).
   * @returns Per-record sweep report (scanned / processed / skipped / failed).
   */
  erasureSweep(options?: { limit?: number }): Promise<ErasureSweepReport>;

  /**
   * **Set a tenant's included usage allowances** (`metadata.includedUsage`) — the per-period usage
   * its plan covers before any **overage** is billed. Usage within an allowance is free; only the
   * excess is billed (at the configured billing rates) on the tenant's next invoice/charge. This is
   * a billing-policy change (a metadata merge — never touches tenant content), so the surface is
   * CLI-only (never HTTP/MCP). Pass `{}` to clear all allowances (bill from the first unit).
   * Each dimension must be a finite, non-negative number.
   *
   * @param id - The tenant id.
   * @param allowance - The included allowances (any subset of metered dimensions).
   * @returns The updated tenant record.
   * @throws Error if the tenant is unknown or an allowance is negative/non-finite.
   */
  setIncludedUsage(id: string, allowance: IncludedUsage): Promise<TenantRecord>;

  /**
   * The operator's **plan catalog** — the published tiers (id, name, price, included allowances).
   * Read-only; empty when no catalog is configured (`TENANTFORGE_PLANS`).
   *
   * @returns The plan definitions.
   */
  listPlans(): PlanDefinition[];

  /**
   * **Assign a plan** to a tenant: set its price (`metadata.priceUsd`), included allowances
   * (`metadata.includedUsage`), and `metadata.planId` to exactly what the plan defines — the plan
   * fully defines the tenant's billing (a metadata merge; never touches tenant content). Emits a
   * `tenant.plan_assigned` event. Billing policy, so the surface is CLI-only (never HTTP/MCP). Does
   * **not** settle proration — use {@link TenantForge.changePlan} with `settle` for that.
   *
   * @param tenantId - The tenant id.
   * @param planId - A plan id from the catalog.
   * @returns The updated tenant record.
   * @throws Error if no catalog is configured, the plan is unknown, or the tenant is unknown.
   */
  assignPlan(tenantId: string, planId: string): Promise<TenantRecord>;

  /**
   * Recent **plan-change history** (`tenant.plan_changed` events) from the persisted audit trail.
   * Returns `[]` when no audit store is wired.
   *
   * @param limit - Max entries, newest-first. Defaults to 20.
   * @returns Recent plan-change audit events.
   */
  planChangeHistory(limit?: number): Promise<TenantEvent[]>;

  /**
   * **Grant credit** to a tenant's balance (an operator adjustment / goodwill / refund-as-credit).
   * Requires a credit ledger; emits a `tenant.credit_granted` event. Adds a financial liability, so
   * the surface is CLI-only + `--yes` gated.
   *
   * @param tenantId - The tenant to credit.
   * @param amountMinor - The amount to grant (minor units, > 0).
   * @param opts - `currency` (default `usd`) and a `reason`.
   * @throws Error if no credit ledger is wired or the amount is not positive.
   */
  grantCredit(
    tenantId: string,
    amountMinor: number,
    opts?: { currency?: string; reason?: string },
  ): Promise<void>;

  /**
   * A tenant's current **credit balance** (minor units, never negative) for a currency. Returns `0`
   * when no credit ledger is wired.
   *
   * @param tenantId - The tenant.
   * @param currency - Lowercase ISO 4217 (default `usd`).
   * @returns The balance in minor units.
   */
  creditBalance(tenantId: string, currency?: string): Promise<number>;

  /**
   * A tenant's recent **credit-ledger entries** (grants + consumptions), newest-first. Returns `[]`
   * when no credit ledger is wired.
   *
   * @param tenantId - The tenant.
   * @param limit - Max entries. Defaults to 20.
   * @returns The credit entries.
   */
  creditHistory(
    tenantId: string,
    limit?: number,
  ): Promise<import('../ports/credit-ledger.js').CreditEntry[]>;

  /**
   * Recent **credit-grant history** (`tenant.credit_granted` events) from the persisted audit trail —
   * a fleet-wide operator view. Returns `[]` when no audit store is wired.
   *
   * @param limit - Max entries, newest-first. Defaults to 20.
   * @returns Recent credit-grant audit events.
   */
  creditGrantHistory(limit?: number): Promise<TenantEvent[]>;

  /**
   * **Ingest an inbound PSP webhook** (e.g. Stripe): verify its signature over the raw body, parse +
   * normalize it, and emit a redacted `payment.webhook` audit event (attributed to the tenant when
   * the event carries one). Requires a configured webhook verifier; throws on a bad/stale signature
   * or malformed payload (the HTTP layer returns 4xx without leaking why). At-least-once delivery —
   * the only effect is an append-only audit event, so a duplicate is benign.
   *
   * @param rawBody - The exact request bytes (never re-serialized — that breaks the HMAC).
   * @param signature - The PSP signature header (e.g. Stripe's `Stripe-Signature`).
   * @returns The normalized payment event.
   */
  ingestPaymentWebhook(rawBody: string, signature: string): Promise<PaymentEvent>;

  /**
   * Recent **inbound payment-webhook history** (`payment.webhook` events) from the persisted audit
   * trail. Returns `[]` when no audit store is wired.
   *
   * @param limit - Max entries, newest-first. Defaults to 20.
   * @returns Recent payment-webhook audit events.
   */
  paymentWebhookHistory(limit?: number): Promise<TenantEvent[]>;

  /**
   * Meter a tenant's resource consumption over a period (for billing) — resolves the tenant's Neon
   * project and aggregates its consumption. Requires a usage provider in the deps.
   *
   * @param id - The tenant id.
   * @param period - The billing period.
   * @returns The tenant's aggregated usage.
   */
  usage(id: string, period: BillingPeriod): Promise<TenantUsage>;

  /** Release underlying resources (the registry connection pool). */
  close(): Promise<void>;
}

/**
 * Create a {@link TenantForge} from injected collaborators (the composition seam used by every
 * entrypoint and by tests with in-memory fakes).
 *
 * @param deps - The registry, provisioning provider, and default region.
 * @returns The control-plane API.
 */
export function createTenantForge(deps: TenantForgeDeps): TenantForge {
  const { registry, provisioning, defaultRegion, secretStore, exporter, migrationRunner } = deps;
  const usageProvider = deps.usageProvider;
  const certificateSigner = deps.certificateSigner;
  const complianceReportSigner = deps.complianceReportSigner;
  const evidenceBundleSigner = deps.evidenceBundleSigner;
  const allowedRegions = deps.allowedRegions ?? [];
  const baseRouter = createConnectionRouter({ registry, secretStore });
  // Optional process-local resolution cache (control-plane cost at fleet scale). When enabled, the
  // cache is invalidated on every transition + erasure so a non-routable/re-keyed tenant is never served.
  const cachingRouter =
    (deps.connectionCacheTtlMs ?? 0) > 0
      ? createCachingConnectionRouter({
          inner: baseRouter,
          ttlMs: deps.connectionCacheTtlMs!,
          ...(deps.connectionCacheMaxEntries !== undefined
            ? { maxEntries: deps.connectionCacheMaxEntries }
            : {}),
        })
      : undefined;
  const router = cachingRouter ?? baseRouter;
  const invalidateConnection = (id: string): void => cachingRouter?.invalidate(id);
  const eventSink = deps.eventSink ?? createNoopEventSink();
  const auditLog = deps.auditLog;
  const paymentGateway = deps.paymentGateway;
  const notifier = deps.notifier;
  const creditLedger = deps.creditLedger;
  const paymentWebhookVerifier = deps.paymentWebhookVerifier;

  /** Build the backup engine on demand; fails closed if no snapshot provider was configured. */
  const backupEngine = (): ReturnType<typeof createBackupEngine> => {
    if (deps.snapshots === undefined) {
      throw new Error('snapshot operations require a configured snapshot provider');
    }
    return createBackupEngine({
      registry,
      snapshots: deps.snapshots,
      ...(deps.archiveExporter !== undefined ? { archiveExporter: deps.archiveExporter } : {}),
      emit: (event) => eventSink.emit(event),
    });
  };

  /** Build the quota engine on demand; fails closed if no usage provider was configured. */
  const quotaEngine = (): ReturnType<typeof createQuotaEngine> => {
    if (deps.usageProvider === undefined) {
      throw new Error('quota operations require a configured usage provider');
    }
    return createQuotaEngine({
      registry,
      usageProvider: deps.usageProvider,
      emit: (event) => eventSink.emit(event),
    });
  };

  /** Build the cost engine on demand; fails closed if no usage provider was configured. */
  const costEngine = (): ReturnType<typeof createCostEngine> => {
    if (deps.usageProvider === undefined) {
      throw new Error('cost reporting requires a configured usage provider');
    }
    return createCostEngine({
      registry,
      usageProvider: deps.usageProvider,
      rates: deps.costRates ?? {},
    });
  };

  /** Build the invoice engine, failing closed when no usage provider is wired. */
  const invoiceEngine = (): ReturnType<typeof createInvoiceEngine> => {
    if (deps.usageProvider === undefined) {
      throw new Error('invoicing requires a configured usage provider');
    }
    return createInvoiceEngine({
      registry,
      usageProvider: deps.usageProvider,
      rates: deps.billingRates ?? {},
    });
  };

  /**
   * Build the usage-alert engine, failing closed when no usage provider is wired or no thresholds
   * are configured (no thresholds ⇒ the feature is off, so there is nothing to evaluate).
   */
  const usageAlertEngine = (): ReturnType<typeof createUsageAlertEngine> => {
    if (deps.usageProvider === undefined) {
      throw new Error('usage alerts require a configured usage provider');
    }
    const thresholds = deps.usageAlertThresholds ?? [];
    if (thresholds.length === 0) {
      throw new Error('usage alerts require TENANTFORGE_USAGE_ALERT_THRESHOLDS to be set');
    }
    return createUsageAlertEngine({
      registry,
      usageProvider: deps.usageProvider,
      thresholds,
      emit: (event) => eventSink.emit(event),
    });
  };

  /** Emit a tenant-scoped event (best-effort, redacted; never throws / breaks the operation). */
  const observe = (
    event: string,
    fields: {
      outcome: 'ok' | 'error';
      tenantId?: string;
      durationMs?: number;
      context?: JsonObject;
      error?: string;
    },
  ): void => {
    const actor = currentActor();
    const correlationId = currentTrace()?.correlationId;
    eventSink.emit({
      event,
      at: new Date().toISOString(),
      outcome: fields.outcome,
      ...(actor !== undefined ? { actor } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
      ...(fields.tenantId !== undefined ? { tenantId: fields.tenantId } : {}),
      ...(fields.durationMs !== undefined ? { durationMs: fields.durationMs } : {}),
      ...(fields.context !== undefined ? { context: redactSecrets(fields.context) } : {}),
      ...(fields.error !== undefined ? { error: fields.error } : {}),
    });
  };

  /**
   * Assemble the point-in-time compliance report + its SHA-256 integrity digest from the registry
   * (and the audit store when wired). Shared by {@link TenantForge.complianceReport} (unsigned) and
   * {@link TenantForge.signedComplianceReport} (which adds the JWS over the same canonical bytes), so
   * the report content + digest are byte-identical across both surfaces. Emits the
   * `compliance.report_generated` audit event (unchanged behaviour for existing callers).
   */
  const assembleComplianceReport = async (): Promise<ComplianceReportResult> => {
    const tenants = await registry.list({ limit: MAX_SWEEP });
    // When an audit store is wired, attest erasure history (transitions to `deleted` — the
    // right-to-erasure evidence) plus a recent excerpt of control-plane activity.
    let audit: ComplianceReportOptions['audit'];
    if (auditLog !== undefined) {
      const transitions = await auditLog.query({ events: ['tenant.transition'], limit: 500 });
      const erasures = transitions.filter((e) => e.context?.['to'] === 'deleted');
      const recent = await auditLog.query({ limit: 25 });
      audit = { erasures, recent };
    }
    const report = buildComplianceReport(tenants, {
      allowedRegions,
      now: new Date(),
      ...(audit !== undefined ? { audit } : {}),
    });
    // Integrity anchor over the canonical report JSON (deterministic field order from the builder).
    const digest = createHash('sha256').update(JSON.stringify(report)).digest('hex');
    observe('compliance.report_generated', {
      outcome: report.isolation.compliant && report.residency.compliant ? 'ok' : 'error',
      context: {
        digest,
        tenants: report.inventory.total,
        isolationCompliant: report.isolation.compliant,
        residencyCompliant: report.residency.compliant,
      },
    });
    return { report, digest };
  };

  /**
   * Assemble + sign a point-in-time evidence bundle (ADR-0011 Phase 2). Pulls the registry tenants
   * and (when an audit store is wired) a bounded, **server-side-scoped** audit excerpt, delegates the
   * pure assembly to `buildEvidenceBundle` (which also re-scopes per tenant — defense in depth on the
   * BOLA boundary), then signs it. Fails closed without a signer (no unsigned bundle path; mirrors the
   * always-signed compliance/erasure discipline — master §2 / ADR-0011).
   */
  const assembleEvidenceBundle = async (options: {
    scope: EvidenceScope;
    tenantId?: string;
    erasureCertificates?: readonly string[];
  }): Promise<SignedEvidenceBundle> => {
    if (evidenceBundleSigner === undefined) {
      throw new Error(
        'evidenceBundle: no evidence-bundle signer configured (set TENANTFORGE_COMPLIANCE_SIGNING_KEY)',
      );
    }
    const tenants = await registry.list({ limit: MAX_SWEEP });
    // A bounded, already-redacted audit excerpt. For a per-tenant bundle, scope the query to that
    // tenant server-side (the builder re-filters as defense in depth — never trust a single layer).
    let auditExcerpt: TenantEvent[] | undefined;
    if (auditLog !== undefined) {
      auditExcerpt = await auditLog.query({
        limit: 25,
        ...(options.scope === 'tenant' && options.tenantId !== undefined
          ? { tenantId: options.tenantId }
          : {}),
      });
    }
    const bundle = buildEvidenceBundle(tenants, {
      scope: options.scope,
      ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
      allowedRegions,
      now: new Date(),
      ...(auditExcerpt !== undefined ? { auditExcerpt } : {}),
      ...(options.erasureCertificates !== undefined
        ? { erasureCertificates: options.erasureCertificates }
        : {}),
    });
    const jws = await evidenceBundleSigner.signBundle(bundle);
    observe('compliance.evidence_bundle_signed', {
      outcome:
        bundle.artifacts.isolation.compliant && bundle.artifacts.residency.compliant
          ? 'ok'
          : 'error',
      ...(bundle.tenantId !== undefined ? { tenantId: bundle.tenantId } : {}),
      context: {
        scope: bundle.scope,
        tenants: bundle.artifacts.inventory.total,
        isolationCompliant: bundle.artifacts.isolation.compliant,
        residencyCompliant: bundle.artifacts.residency.compliant,
        erasureCertificates: bundle.artifacts.erasureCertificates.length,
      },
    });
    return { bundle, jws };
  };

  /** Load a tenant by id or throw (offboard/suspend operate on a known tenant). */
  const requireTenant = async (id: string): Promise<TenantRecord> => {
    const tenant = await registry.getById(id);
    if (!tenant) throw new Error(`tenant ${id} not found`);
    return tenant;
  };

  /** The current calendar month [first day 00:00 UTC, now] — the default dunning/charge period. */
  const currentMonthPeriod = (): BillingPeriod => {
    const now = new Date();
    return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: now };
  };

  /** Read-only fleet orchestrator (no applies) — a placeholder runner suffices when none is wired. */
  const reconcileOrchestrator = () =>
    createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: migrationRunner ?? {
        applyToTenant: () =>
          Promise.reject(new Error('reconcilePlan: no migration runner is configured')),
      },
    });

  /** Run `fn`, returning `fallback` on any failure (best-effort detector for the digest roll-up). */
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };

  /**
   * Gather every detector's current findings and assemble the operator digest. Best-effort per
   * detector: one that can't run (e.g. cost without a usage provider, or audit without a store)
   * contributes nothing rather than failing the whole roll-up — the dedicated scans surface the
   * underlying error.
   */
  const gatherOperatorDigest = async (period: BillingPeriod): Promise<OperatorDigest> => {
    const retentionDays = deps.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const [auditAnomalies, costAnomalies, plan, retention, usage] = await Promise.all([
      safe<AuditAnomaly[]>(
        async () =>
          auditLog === undefined
            ? []
            : detectAuditAnomalies(await auditLog.query({ limit: 500 }), {}),
        [],
      ),
      safe<CostAnomaly[]>(
        async () => detectCostAnomalies((await costEngine().report(period)).rows, {}),
        [],
      ),
      safe<FleetReconcilePlan | null>(async () => reconcileOrchestrator().reconcilePlan(), null),
      safe<RetentionReport | null>(
        async () =>
          buildRetentionReport(await registry.list({ status: 'offboarding', limit: MAX_SWEEP }), {
            now: new Date(),
            retentionDays,
          }),
        null,
      ),
      safe<UsageAlertSweepReport | null>(async () => usageAlertEngine().checkAll(period), null),
    ]);
    return buildOperatorDigest({
      generatedAt: new Date().toISOString(),
      auditAnomalies,
      costAnomalies,
      drift: { target: plan?.target ?? null, pendingTenants: plan?.pendingTenants.length ?? 0 },
      retention: { eligible: retention?.eligible ?? 0, pending: retention?.pending ?? 0 },
      usage: {
        alertedTenants: usage?.alerted.length ?? 0,
        scanFailures: usage?.failed.length ?? 0,
      },
    });
  };

  /** Best-effort operator alert: email the digest for a non-`ok` severity. Never throws. */
  const maybeNotifyDigest = async (digest: OperatorDigest): Promise<void> => {
    const to = deps.operatorEmail;
    if (notifier === undefined || to === undefined || digest.severity === 'ok') return;
    try {
      const result = await notifier.notify({
        to,
        subject: `[TenantForge] operator digest — ${digest.headline}`,
        body: formatOperatorDigest(digest),
        idempotencyKey: `tenantforge:operator-digest:${digest.generatedAt}`,
        metadata: { severity: digest.severity },
      });
      observe('operator.digest_notified', {
        outcome: 'ok',
        context: {
          provider: result.provider,
          notificationId: result.id,
          severity: digest.severity,
        },
      });
    } catch {
      // An alert send must never break the digest it reports on (topic-notifications best-effort).
    }
  };

  /** Read a tenant's PSP customer reference from metadata, if present + non-empty. */
  const billingCustomerRef = (metadata: JsonObject): string | undefined => {
    const v = metadata['billingCustomerRef'];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };

  /** Read a tenant's billing receipt recipient from metadata, if present + non-empty. */
  const billingEmail = (metadata: JsonObject): string | undefined => {
    const v = metadata['billingEmail'];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };

  /** Best-effort operator alert (no PII in the body). Never throws (topic-notifications). */
  const alertOperator = async (body: string): Promise<void> => {
    const to = deps.operatorEmail;
    if (notifier === undefined || to === undefined) return;
    try {
      await notifier.notify({
        to,
        subject: '[TenantForge] self-serve account action',
        body,
        idempotencyKey: `operator-alert:${createHash('sha256').update(body).digest('hex')}`,
      });
    } catch {
      // An alert send must never break the action it reports on.
    }
  };

  /**
   * Compose the verified-, **signed**-erasure engine over the already-injected ports. Fails closed
   * when no certificate signer is configured — **erasure is always signed**, so there is no path
   * that erases a tenant without producing a verifiable certificate (master §2; ADR-0010 B8w). The
   * engine's `alertOperator` hook fires only in the rare fail-soft case (signing throws *after* the
   * irreversible erasure already completed — the cert is recorded unsigned and we alert, never roll
   * back).
   */
  const buildErasureEngine = (): ReturnType<typeof createErasureEngine> => {
    if (certificateSigner === undefined) {
      throw new Error(
        'erasure requires a configured certificate signer (TENANTFORGE_ERASURE_SIGNING_KEY) — ' +
          'an erasure is always cryptographically signed',
      );
    }
    return createErasureEngine({
      registry,
      provisioning,
      secretStore,
      signer: certificateSigner,
      ...(exporter ? { exporter } : {}),
      emit: (event) => eventSink.emit(event),
      alertOperator: (message) => {
        void alertOperator(message);
      },
    });
  };

  /**
   * Griefing tripwire / wrong-account safety net (red-team F7): on a self-serve destructive action
   * (cancel / erasure) alert **both** the operator and the tenant's verified email — best-effort, so a
   * notifier failure never blocks the action. The tenant slug (not PII) identifies the account.
   */
  const alertSelfServeDestructive = async (
    tenant: TenantRecord,
    action: 'cancel' | 'erasure',
    detail: { reversibleUntil?: string; executeAt?: string },
  ): Promise<void> => {
    if (notifier === undefined) return;
    const when =
      detail.reversibleUntil !== undefined
        ? `Reversible until ${detail.reversibleUntil}.`
        : detail.executeAt !== undefined
          ? `Scheduled to execute at ${detail.executeAt}; you can cancel until then.`
          : '';
    await alertOperator(`Self-serve ${action} requested for tenant ${tenant.slug}. ${when}`.trim());
    const to = billingEmail(tenant.metadata);
    if (to === undefined) return;
    try {
      await notifier.notify({
        to,
        subject: `Your TenantForge account ${action} request`,
        body: `A ${action} was requested for your account (${tenant.slug}). ${when} If you did not request this, contact support immediately.`,
        idempotencyKey: `selfserve-${action}:${tenant.id}:${detail.executeAt ?? detail.reversibleUntil ?? ''}`,
        metadata: { tenant_id: tenant.id },
      });
    } catch {
      // Best-effort — never block the destructive action on a notification failure.
    }
  };

  /**
   * Best-effort send the tenant the **erasure-completion** notice (review L2 / threat-model B8w: "the
   * tenant's verified email is alerted on execution"). The tenant record is erased by execution time,
   * so the address is the one captured at request time + carried on the pending-erasure record — it
   * cannot be read from the registry now. References the {@link ErasureCertificate} (its `verified`
   * flag + `erasedAt`) — booleans/references only, no secrets. Fully swallows its own errors: a
   * notifier failure must NEVER fail or roll back the erasure (the data is already gone).
   */
  const alertTenantErased = async (
    tenantEmail: string | undefined,
    certificate: ErasureCertificate,
  ): Promise<void> => {
    if (notifier === undefined || tenantEmail === undefined) return;
    try {
      await notifier.notify({
        to: tenantEmail,
        subject: 'Your TenantForge account has been erased',
        body:
          `Your requested account erasure has completed (${certificate.erasedAt}). ` +
          `Your data has been permanently deleted` +
          (certificate.verified
            ? ' and the deletion was verified.'
            : '; verification is pending — our team has been alerted.') +
          ` Erasure certificate reference: ${certificate.tenantId}@${certificate.erasedAt}.`,
        // Stable key (tenant id + completion instant) so an at-least-once retry never double-notifies.
        idempotencyKey: `selfserve-erased:${certificate.tenantId}:${certificate.erasedAt}`,
        metadata: { tenant_id: certificate.tenantId },
      });
    } catch {
      // Best-effort — never block / roll back the completed erasure on a notification failure.
    }
  };

  /**
   * Best-effort send a billing **receipt** (charge/refund confirmation) to the tenant's
   * `metadata.billingEmail`, recording a redacted `tenant.notified` event. Fully swallows its own
   * errors — a notifier/registry failure must never break the billing operation it confirms
   * (`topic-notifications`). No-op when no notifier is wired or the tenant has no billing email. The
   * recipient address is **not** put in the audit context (PII — master §5).
   */
  const sendReceipt = async (
    kind: ReceiptKind,
    args: { tenantId: string; amountMinor: number; currency: string; reference: string },
  ): Promise<void> => {
    if (notifier === undefined) return;
    try {
      const tenant = await registry.getById(args.tenantId);
      if (tenant === null) return;
      const to = billingEmail(tenant.metadata);
      if (to === undefined) return; // no recipient on file → nothing to send
      const { subject, body } = renderReceipt({
        kind,
        tenantSlug: tenant.slug,
        amountMinor: args.amountMinor,
        currency: args.currency,
        reference: args.reference,
        at: new Date().toISOString(),
      });
      const result = await notifier.notify({
        to,
        subject,
        body,
        idempotencyKey: receiptIdempotencyKey(kind, args.reference),
        metadata: { tenant_id: args.tenantId },
      });
      observe('tenant.notified', {
        tenantId: args.tenantId,
        outcome: 'ok',
        context: {
          provider: result.provider,
          notificationId: result.id,
          kind,
          reference: args.reference,
          status: result.status,
        },
      });
    } catch (error) {
      observe('tenant.notified', {
        tenantId: args.tenantId,
        outcome: 'error',
        context: { kind, reference: args.reference },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /**
   * Best-effort **email a usage alert** to the tenant's `metadata.billingEmail` (approaching/over
   * its plan allowance). Swallows its own errors — alerting must never break the sweep
   * (`topic-notifications`). No-op when no notifier is wired or no billing email is on file. The
   * recipient address is **not** put in the audit context (PII — master §5).
   *
   * @param alert - The tenant's alerts + the period they were evaluated over.
   * @returns Nothing; records a redacted `tenant.notified` event.
   */
  const notifyUsageAlert = async (alert: {
    tenantId: string;
    alerts: { metric: string; usedFraction: number; thresholdCrossed: number }[];
    periodStart: string;
    periodEnd: string;
  }): Promise<void> => {
    if (notifier === undefined) return;
    try {
      const tenant = await registry.getById(alert.tenantId);
      if (tenant === null) return;
      const to = billingEmail(tenant.metadata);
      if (to === undefined) return; // no recipient on file → nothing to send
      const peak = Math.max(...alert.alerts.map((a) => a.thresholdCrossed));
      const lines = alert.alerts
        .map(
          (a) => `  • ${a.metric}: ${Math.round(a.usedFraction * 100)}% of your included allowance`,
        )
        .join('\n');
      const result = await notifier.notify({
        to,
        subject: `Usage alert for ${tenant.slug}: approaching your plan allowance`,
        body:
          `Your project ${tenant.slug} has reached the following share of its included usage ` +
          `allowance for ${alert.periodStart}..${alert.periodEnd}:\n\n${lines}\n\n` +
          `Usage beyond your allowance is billed as overage. Consider upgrading your plan.`,
        // Dedupe per tenant + period + peak threshold so a re-run never double-notifies.
        idempotencyKey: `usage-alert:${alert.tenantId}:${alert.periodStart}..${alert.periodEnd}:${peak}`,
        metadata: { tenant_id: alert.tenantId },
      });
      observe('tenant.notified', {
        tenantId: alert.tenantId,
        outcome: 'ok',
        context: {
          provider: result.provider,
          notificationId: result.id,
          kind: 'usage-alert',
          status: result.status,
        },
      });
    } catch (error) {
      observe('tenant.notified', {
        tenantId: alert.tenantId,
        outcome: 'error',
        context: { kind: 'usage-alert' },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /**
   * Generate + **deliver** one tenant's invoice by email. Fails closed without a notifier; returns
   * a skip (not an error) when the tenant has no billing email. Records a redacted `tenant.invoiced`
   * event (never the recipient address — PII). Shared by `sendInvoice` + `sendInvoiceFleet`.
   */
  const deliverInvoice = async (
    tenantId: string,
    period: BillingPeriod,
  ): Promise<InvoiceSendResult> => {
    if (notifier === undefined) throw new Error('invoice delivery requires a configured notifier');
    const invoice = await invoiceEngine().invoice(tenantId, period); // validates provider + tenant
    const tenant = await registry.getById(tenantId);
    if (tenant === null) throw new Error(`tenant ${tenantId} not found`);
    const to = billingEmail(tenant.metadata);
    if (to === undefined) {
      return { tenantId, sent: false, reason: 'no billing email', totalUsd: invoice.totalUsd };
    }
    const { subject, body } = renderInvoiceEmail({
      tenantSlug: tenant.slug,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      currency: invoice.currency,
      lineItems: invoice.lineItems.map((li) => ({
        description: li.description,
        amountUsd: li.amountUsd,
      })),
      totalUsd: invoice.totalUsd,
    });
    const result = await notifier.notify({
      to,
      subject,
      body,
      idempotencyKey: invoiceEmailIdempotencyKey(tenantId, invoice.periodStart, invoice.periodEnd),
      metadata: { tenant_id: tenantId },
    });
    observe('tenant.invoiced', {
      tenantId,
      outcome: 'ok',
      context: {
        provider: result.provider,
        notificationId: result.id,
        status: result.status,
        totalUsd: invoice.totalUsd,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
      },
    });
    return { tenantId, sent: true, totalUsd: invoice.totalUsd };
  };

  /** Quote a plan change: load the tenant, read its current price, and prorate the delta. Pure-ish. */
  const quotePlanChange = async (
    id: string,
    newPriceUsd: number,
    opts?: { period?: BillingPeriod; asOf?: Date },
  ): Promise<{
    tenant: TenantRecord;
    oldPriceUsd: number;
    period: BillingPeriod;
    proratedDeltaMinor: number;
  }> => {
    if (!Number.isFinite(newPriceUsd) || newPriceUsd < 0) {
      throw new Error(`newPriceUsd must be a non-negative number, got ${newPriceUsd}`);
    }
    const tenant = await requireTenant(id);
    const current = tenant.metadata['priceUsd'];
    const oldPriceUsd = typeof current === 'number' ? current : 0;
    const period = opts?.period ?? currentMonthPeriod();
    assertPeriod(period);
    const asOf = opts?.asOf ?? new Date();
    const proratedDeltaMinor = proratePlanChangeMinor({
      oldPriceMinor: Math.round(oldPriceUsd * 100),
      newPriceMinor: Math.round(newPriceUsd * 100),
      periodStart: period.from.toISOString(),
      periodEnd: period.to.toISOString(),
      asOf: asOf.toISOString(),
    });
    return { tenant, oldPriceUsd, period, proratedDeltaMinor };
  };

  /** The tenant's most recent successful charge (id / amount / currency), or undefined. */
  const latestOkCharge = async (
    tenantId: string,
  ): Promise<{ chargeId: string; amountMinor: number; currency: string } | undefined> => {
    if (auditLog === undefined) return undefined;
    const charges = await auditLog.query({ events: ['tenant.charged'], tenantId, limit: 50 });
    const latest = charges.find(
      (e) => e.outcome === 'ok' && typeof e.context?.['chargeId'] === 'string',
    );
    if (latest === undefined) return undefined;
    const ctx = latest.context ?? {};
    const chargeId = ctx['chargeId'];
    if (typeof chargeId !== 'string') return undefined;
    return {
      chargeId,
      amountMinor: typeof ctx['amountMinor'] === 'number' ? ctx['amountMinor'] : 0,
      currency: typeof ctx['currency'] === 'string' ? ctx['currency'] : 'usd',
    };
  };

  /**
   * Look up a prior charge in the persisted audit trail by its PSP charge id, to recover the
   * tenant / currency / original amount for a refund. Returns `undefined` when no audit store is
   * wired or no matching `tenant.charged` event exists (the caller then needs an explicit currency).
   */
  const findChargeInAudit = async (
    chargeId: string,
  ): Promise<{ tenantId?: string; currency?: string; amountMinor?: number } | undefined> => {
    if (auditLog === undefined) return undefined;
    const events = await auditLog.query({ events: ['tenant.charged'], limit: MAX_SWEEP });
    const match = events.find((e) => e.context?.['chargeId'] === chargeId);
    if (match === undefined) return undefined;
    const ctx = match.context ?? {};
    const currency = typeof ctx['currency'] === 'string' ? ctx['currency'] : undefined;
    const amountMinor = typeof ctx['amountMinor'] === 'number' ? ctx['amountMinor'] : undefined;
    return {
      ...(match.tenantId !== undefined ? { tenantId: match.tenantId } : {}),
      ...(currency !== undefined ? { currency } : {}),
      ...(amountMinor !== undefined ? { amountMinor } : {}),
    };
  };

  /**
   * Refund a charge via the gateway (idempotent), emitting a redacted `tenant.refunded` event. The
   * shared implementation behind {@link TenantForge.refundCharge} and refund-on-offboard.
   */
  const refundChargeImpl = async (
    chargeId: string,
    opts: RefundOptions = {},
  ): Promise<RefundResult> => {
    if (paymentGateway === undefined) {
      throw new Error('refunds require a configured payment gateway');
    }
    const original = await findChargeInAudit(chargeId);
    const currency = opts.currency ?? original?.currency;
    if (currency === undefined) {
      throw new Error(
        `refund requires a currency (charge ${chargeId} not found in the audit trail — pass currency)`,
      );
    }
    // Bound a partial refund by the original amount when we know it (can't refund more than charged).
    assertRefundAmount(opts.amountMinor, original?.amountMinor);
    const tenantId = opts.tenantId ?? original?.tenantId;
    try {
      const result = await paymentGateway.refund({
        chargeId,
        ...(opts.amountMinor !== undefined ? { amountMinor: opts.amountMinor } : {}),
        currency,
        idempotencyKey: refundIdempotencyKey(chargeId, opts.amountMinor),
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        ...(tenantId !== undefined ? { metadata: { tenant_id: tenantId } } : {}),
      });
      observe('tenant.refunded', {
        ...(tenantId !== undefined ? { tenantId } : {}),
        outcome: 'ok',
        context: {
          provider: result.provider,
          refundId: result.id,
          chargeId,
          amountMinor: result.amountMinor,
          currency: result.currency,
          status: result.status,
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        },
      });
      // Best-effort refund receipt (only when we know which tenant — never blocks/breaks the refund).
      if (tenantId !== undefined) {
        await sendReceipt('refund', {
          tenantId,
          amountMinor: result.amountMinor,
          currency: result.currency,
          reference: result.id,
        });
      }
      return result;
    } catch (error) {
      observe('tenant.refunded', {
        ...(tenantId !== undefined ? { tenantId } : {}),
        outcome: 'error',
        context: {
          chargeId,
          ...(opts.amountMinor !== undefined ? { amountMinor: opts.amountMinor } : {}),
        },
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  /**
   * Invoice + charge one tenant via the gateway (idempotent), emitting a redacted `tenant.charged`
   * audit event. Assumes the gateway + customer ref exist (the callers check). Throws on a
   * zero-amount invoice or a gateway decline/error (attributed to the operator in scope).
   */
  const chargeTenant = async (
    id: string,
    customerRef: string,
    period: BillingPeriod,
    attempt = 0,
  ): Promise<ChargeResult> => {
    const invoice = await invoiceEngine().invoice(id, period);
    const { amountMinor, currency } = invoiceChargeAmount(invoice); // throws if not positive
    // Apply any available credit first, keyed by the **period** (stable across dunning retries), so a
    // re-charge consumes nothing more and credit is applied to a period exactly once.
    let creditApplied = 0;
    if (creditLedger !== undefined) {
      const { consumedMinor } = await creditLedger.consume({
        tenantId: id,
        amountMinor,
        currency,
        reason: 'applied to charge',
        reference: `tenantforge:credit-applied:${id}:${invoice.periodStart}..${invoice.periodEnd}`,
      });
      creditApplied = consumedMinor;
    }
    const toChargeMinor = amountMinor - creditApplied;
    try {
      // Fully covered by credit ⇒ no card charge (a synthetic, stable result); else charge the remainder.
      const result: ChargeResult =
        toChargeMinor <= 0
          ? {
              id: `credit:${invoice.periodStart}..${invoice.periodEnd}`,
              status: 'succeeded',
              amountMinor: 0,
              currency,
              provider: 'credit',
            }
          : await paymentGateway!.charge({
              amountMinor: toChargeMinor,
              currency,
              customerRef,
              // A dunning retry (attempt > 0) gets a distinct key so the PSP makes a fresh attempt.
              idempotencyKey: chargeIdempotencyKey(invoice, attempt),
              description: `TenantForge ${id} ${invoice.periodStart}..${invoice.periodEnd}`,
              metadata: { tenant_id: id },
            });
      observe('tenant.charged', {
        tenantId: id,
        outcome: 'ok',
        context: {
          provider: result.provider,
          chargeId: result.id,
          // The amount actually charged to the card (what a refund can reverse).
          amountMinor: toChargeMinor > 0 ? toChargeMinor : 0,
          currency,
          status: result.status,
          // Period covered — lets refund-on-offboard prorate the unused portion.
          periodStart: invoice.periodStart,
          periodEnd: invoice.periodEnd,
          ...(creditApplied > 0
            ? { creditAppliedMinor: creditApplied, originalAmountMinor: amountMinor }
            : {}),
        },
      });
      // Receipt only when the card was actually charged (best-effort; swallows its own errors).
      if (toChargeMinor > 0) {
        await sendReceipt('charge', {
          tenantId: id,
          amountMinor: toChargeMinor,
          currency,
          reference: result.id,
        });
      }
      return result;
    } catch (error) {
      observe('tenant.charged', {
        tenantId: id,
        outcome: 'error',
        context: {
          amountMinor: toChargeMinor,
          currency,
          ...(creditApplied > 0 ? { creditAppliedMinor: creditApplied } : {}),
        },
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  /** Validate + apply a status transition, returning the refreshed record. Emits a lifecycle event. */
  const transition = async (tenant: TenantRecord, to: TenantStatus): Promise<TenantRecord> => {
    try {
      assertTransition(tenant.status, to);
    } catch (error) {
      observe('tenant.transition', {
        tenantId: tenant.id,
        outcome: 'error',
        context: { from: tenant.status, to },
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    await registry.setStatus(tenant.id, to);
    // Any status change can flip routability (or precede a secret change) — drop the cached resolution.
    invalidateConnection(tenant.id);
    observe('tenant.transition', {
      tenantId: tenant.id,
      outcome: 'ok',
      context: { from: tenant.status, to },
    });
    const updated = await registry.getById(tenant.id);
    return updated ?? { ...tenant, status: to };
  };

  /** Irreversibly delete a tenant's project, crypto-shred its secret, and mark it deleted. */
  const purgeTenant = async (tenant: TenantRecord): Promise<TenantRecord> => {
    // Validate before the irreversible delete (rejects active/suspended — must offboard first).
    assertTransition(tenant.status, 'deleted');
    if (tenant.neonProjectId !== null) {
      await provisioning.deleteTenantProject(tenant.neonProjectId);
    }
    await secretStore.delete(tenant.id);
    return transition(tenant, 'deleted');
  };

  /** Create the Neon project for a provisioning-state tenant and activate it. */
  /**
   * Resolve + validate the region for provision/import (fail closed before any project is touched):
   * an explicit region is checked against the allow-list + any required jurisdiction; with no region
   * but a required residency the ResidencyRouter selects a compliant one; otherwise the configured
   * default (still allow-list-checked).
   */
  const resolveRegion = (
    regionOpt: string | undefined,
    residency: Jurisdiction | undefined,
  ): string => {
    if (regionOpt !== undefined) {
      const region = assertRegion(regionOpt);
      assertRegionAllowed(region, allowedRegions);
      if (residency !== undefined) assertResidency(region, residency);
      return region;
    }
    if (residency !== undefined) {
      return selectRegion({
        jurisdiction: residency,
        allowed: allowedRegions,
        preferred: defaultRegion,
      });
    }
    const region = assertRegion(defaultRegion);
    assertRegionAllowed(region, allowedRegions);
    return region;
  };

  const finishProvisioning = async (tenant: TenantRecord): Promise<ProvisionOutcome> => {
    const result = await provisioning.createTenantProject({
      slug: tenant.slug,
      region: tenant.region,
    });
    await registry.attachProject(tenant.id, result.neonProjectId);
    // Store the connection secret in the dedicated store (keyed by tenant id) — never the registry.
    await secretStore.set(tenant.id, result.connectionUri);
    assertTransition(tenant.status, 'active');
    await registry.setStatus(tenant.id, 'active');
    observe('tenant.provisioned', {
      tenantId: tenant.id,
      outcome: 'ok',
      context: { slug: tenant.slug, region: tenant.region },
    });
    const active = await registry.getById(tenant.id);
    return {
      tenant: active ?? { ...tenant, status: 'active' },
      connectionUri: result.connectionUri,
    };
  };

  /**
   * Charge every active tenant with a billing customer ref for the period (failure-isolated). The
   * shared implementation behind {@link TenantForge.chargeInvoiceFleet} and the billing run. Assumes
   * a payment gateway is configured (callers check).
   */
  const chargeFleetRun = async (period: BillingPeriod): Promise<FleetChargeReport> => {
    const active = await registry.list({ status: 'active', limit: MAX_SWEEP });
    const charged: (ChargeResult & { tenantId: string })[] = [];
    const skipped: { tenantId: string; reason: string }[] = [];
    const failed: { tenantId: string; error: string }[] = [];
    for (const tenant of active) {
      const customerRef = billingCustomerRef(tenant.metadata);
      if (customerRef === undefined) {
        skipped.push({ tenantId: tenant.id, reason: 'no billingCustomerRef' });
        continue;
      }
      try {
        charged.push({
          tenantId: tenant.id,
          ...(await chargeTenant(tenant.id, customerRef, period)),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A zero/no-charge invoice is an intentional skip, not a billing failure.
        if (/no positive amount to charge/.test(message)) {
          skipped.push({ tenantId: tenant.id, reason: 'zero invoice' });
        } else {
          failed.push({ tenantId: tenant.id, error: message });
        }
      }
    }
    return { generatedAt: new Date().toISOString(), charged, skipped, failed };
  };

  /**
   * Run a dunning sweep over the active fleet (failure-isolated, idempotent). The shared
   * implementation behind {@link TenantForge.runDunning} and the billing run. Assumes a payment
   * gateway is configured (callers check).
   */
  const dunningSweepRun = async (
    period: BillingPeriod,
    schedule: DunningSchedule,
  ): Promise<DunningReport> => {
    const report: DunningReport = {
      generatedAt: new Date().toISOString(),
      schedule,
      retried: [],
      failed: [],
      suspended: [],
      skipped: [],
    };
    // No persisted trail ⇒ no failure history to act on ⇒ nothing to dun (fail closed, not silent).
    if (auditLog === undefined) {
      for (const tenant of await registry.list({ status: 'active', limit: MAX_SWEEP })) {
        report.skipped.push({ tenantId: tenant.id, reason: 'no audit store' });
      }
      return report;
    }
    const active = await registry.list({ status: 'active', limit: MAX_SWEEP });
    for (const tenant of active) {
      const customerRef = billingCustomerRef(tenant.metadata);
      if (customerRef === undefined) {
        report.skipped.push({ tenantId: tenant.id, reason: 'no billingCustomerRef' });
        continue;
      }
      const charges = await auditLog.query({
        events: ['tenant.charged'],
        tenantId: tenant.id,
        limit: schedule.maxAttempts + 1,
      });
      const { consecutiveFailures, hoursSinceLastAttempt } = dunningStateFromCharges(
        charges,
        new Date(),
      );
      const decision = planDunning({ consecutiveFailures, hoursSinceLastAttempt, schedule });

      if (decision.action === 'wait') {
        report.skipped.push({
          tenantId: tenant.id,
          reason: consecutiveFailures === 0 ? 'no failures' : 'within backoff',
        });
        continue;
      }
      if (decision.action === 'suspend') {
        await transition(tenant, 'suspended');
        report.suspended.push({ tenantId: tenant.id, failures: consecutiveFailures });
        observe('tenant.dunning', {
          tenantId: tenant.id,
          outcome: 'ok',
          context: { action: 'suspend', failures: consecutiveFailures },
        });
        continue;
      }
      // retry
      try {
        const result = await chargeTenant(tenant.id, customerRef, period, decision.attempt);
        report.retried.push({ tenantId: tenant.id, attempt: decision.attempt, ...result });
        observe('tenant.dunning', {
          tenantId: tenant.id,
          outcome: 'ok',
          context: { action: 'retry', attempt: decision.attempt, status: result.status },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.failed.push({ tenantId: tenant.id, attempt: decision.attempt, error: message });
        observe('tenant.dunning', {
          tenantId: tenant.id,
          outcome: 'error',
          context: { action: 'retry', attempt: decision.attempt },
          error: message,
        });
      }
    }
    return report;
  };

  return {
    async health(): Promise<HealthReport> {
      let registryCheck: 'ok' | 'error' = 'ok';
      try {
        await registry.ping();
      } catch {
        registryCheck = 'error';
      }
      return {
        status: registryCheck === 'ok' ? 'ok' : 'degraded',
        checks: { registry: registryCheck },
      };
    },

    async migrate(): Promise<void> {
      await registry.migrate();
    },

    async provision(input: ProvisionInput): Promise<ProvisionOutcome> {
      const slug = assertSlug(input.slug);
      // Residency enforcement (std-privacy), fail closed before any project is created.
      const region = resolveRegion(input.region, input.residency);

      const existing = await registry.getBySlug(slug);
      if (existing) {
        // Resume an interrupted provision (record exists, no project yet).
        if (existing.status === 'provisioning' && existing.neonProjectId === null) {
          return finishProvisioning(existing);
        }
        // A tearing-down tenant still owns the slug — fail closed rather than collide.
        if (existing.status === 'offboarding' || existing.status === 'deleted') {
          throw new Error(`slug "${slug}" belongs to a ${existing.status} tenant`);
        }
        // Already provisioned (active/suspended) — idempotent no-op; the secret is not re-fetched.
        return { tenant: existing, connectionUri: null };
      }

      const created = await registry.create({
        slug,
        region,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
      return finishProvisioning(created);
    },

    async importTenant(input: ImportInput): Promise<ImportOutcome> {
      const slug = assertSlug(input.slug);
      const region = resolveRegion(input.region, input.residency);
      // Adoption is not a resume: a slug already in any state fails closed (no silent overwrite).
      const existing = await registry.getBySlug(slug);
      if (existing) {
        throw new Error(`slug "${slug}" is already in use (status: ${existing.status})`);
      }
      const created = await registry.create({
        slug,
        region,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
      // Adopt the EXISTING project — attach its id, store the operator-supplied secret, activate.
      // No Neon-API create (mirrors finishProvisioning minus project creation).
      await registry.attachProject(created.id, input.neonProjectId);
      await secretStore.set(created.id, input.connectionUri);
      assertTransition(created.status, 'active');
      await registry.setStatus(created.id, 'active');
      // Event carries slug/region/projectId — NEVER the inbound connection URI (master §5).
      observe('tenant.imported', {
        tenantId: created.id,
        outcome: 'ok',
        context: { slug, region, neonProjectId: input.neonProjectId },
      });
      const active = await registry.getById(created.id);
      return {
        tenant: active ?? { ...created, status: 'active', neonProjectId: input.neonProjectId },
      };
    },

    async issueSignupToken(opts: {
      slug: string;
      region?: string;
      planId?: string;
      ttlSeconds?: number;
    }): Promise<SignupTokenIssued> {
      const store = deps.signupTokenStore;
      if (store === undefined)
        throw new Error('signup tokens require a configured signup-token store');
      const slug = assertSlug(opts.slug); // fail closed on a bad slug before issuing
      const token = randomBytes(32).toString('base64url'); // raw — returned once, never stored
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const ttlSeconds = opts.ttlSeconds ?? 7 * 24 * 60 * 60; // default 7 days
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
      const record: SignupTokenRecord = {
        tokenHash,
        slug,
        ...(opts.region !== undefined ? { region: opts.region } : {}),
        ...(opts.planId !== undefined ? { planId: opts.planId } : {}),
        expiresAt,
        createdAt: now.toISOString(),
      };
      await store.create(record);
      // Audit the issue WITHOUT the raw token or hash (a credential — master §5).
      observe('signup.token_issued', {
        outcome: 'ok',
        context: { slug, expiresAt, ...(opts.planId !== undefined ? { planId: opts.planId } : {}) },
      });
      return { token, slug, expiresAt };
    },

    async redeemSignupToken(token: string): Promise<ProvisionOutcome> {
      const store = deps.signupTokenStore;
      if (store === undefined)
        throw new Error('signup tokens require a configured signup-token store');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const record = await store.findByHash(tokenHash);
      if (record === null) throw new Error('unknown signup token');
      assertRedeemable(record, new Date().toISOString()); // throws if expired / already redeemed
      const outcome = await this.provision({
        slug: record.slug,
        ...(record.region !== undefined ? { region: record.region } : {}),
        ...(record.planId !== undefined ? { metadata: { planId: record.planId } } : {}),
      });
      await store.markRedeemed(tokenHash, outcome.tenant.id, new Date().toISOString());
      observe('signup.token_redeemed', {
        tenantId: outcome.tenant.id,
        outcome: 'ok',
        context: { slug: record.slug },
      });
      return outcome;
    },

    async listSignupTokens(limit = 50): Promise<SignupTokenSummary[]> {
      const store = deps.signupTokenStore;
      if (store === undefined) return [];
      const now = new Date().toISOString();
      const rows = await store.list(limit);
      // Redacted: never expose the hash or raw token.
      return rows.map((r) => ({
        slug: r.slug,
        status: signupTokenStatus(r, now),
        ...(r.region !== undefined ? { region: r.region } : {}),
        ...(r.planId !== undefined ? { planId: r.planId } : {}),
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
        ...(r.redeemedAt !== undefined ? { redeemedAt: r.redeemedAt } : {}),
        ...(r.redeemedTenantId !== undefined ? { redeemedTenantId: r.redeemedTenantId } : {}),
      }));
    },

    async startSignup(input: StartSignupInput): Promise<{ signupId: string }> {
      const sr = deps.signupRequestStore;
      const ev = deps.emailVerificationStore;
      const cap = deps.captcha;
      if (sr === undefined || ev === undefined || cap === undefined || notifier === undefined) {
        throw new Error('self-serve signup is not configured');
      }
      // Verify the captcha BEFORE any cost-incurring work (email send / PSP) — fail closed.
      const captcha = await cap.verify(input.captchaToken, input.remoteIp);
      if (!captcha.success) throw new Error('captcha verification failed');
      const email = input.email.trim().toLowerCase();
      const signupId = randomUUID();
      const now = new Date();
      const nowIso = now.toISOString();
      await sr.create({
        id: signupId,
        email,
        status: 'started',
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      // 6-digit one-time code; persist only its hash (master §5).
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const codeHash = createHash('sha256').update(code).digest('hex');
      const ttlMs = deps.emailCodeTtlMs ?? 15 * 60 * 1000;
      await ev.put({
        email,
        codeHash,
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        attempts: 0,
        createdAt: nowIso,
      });
      await notifier.notify({
        to: email,
        subject: 'Your TenantForge verification code',
        body: `Your verification code is ${code}. It expires in ${Math.round(ttlMs / 60000)} minutes.`,
        idempotencyKey: `signup-verify:${signupId}`,
      });
      // Audit without the email or code (PII/secret — master §5).
      observe('signup.started', { outcome: 'ok', context: { signupId } });
      return { signupId };
    },

    async verifyEmail(signupId: string, code: string): Promise<void> {
      const sr = deps.signupRequestStore;
      const ev = deps.emailVerificationStore;
      if (sr === undefined || ev === undefined) {
        throw new Error('self-serve signup is not configured');
      }
      const req = await sr.get(signupId);
      if (req === null) throw new Error('unknown signup');
      const rec = await ev.get(req.email);
      if (rec === null) throw new Error('no verification code; request a new one');
      assertVerifiable(rec, new Date().toISOString()); // throws expired / locked / already verified
      const got = createHash('sha256').update(code).digest('hex');
      const match =
        got.length === rec.codeHash.length &&
        timingSafeEqual(Buffer.from(got), Buffer.from(rec.codeHash));
      if (!match) {
        const attempts = await ev.recordFailedAttempt(req.email);
        observe('signup.email_verify', { outcome: 'error', context: { signupId, attempts } });
        throw new Error('invalid verification code');
      }
      const nowIso = new Date().toISOString();
      await ev.markVerified(req.email, nowIso);
      await sr.update(signupId, { status: 'email_verified', updatedAt: nowIso });
      observe('signup.email_verified', { outcome: 'ok', context: { signupId } });
    },

    async createPaymentSetup(signupId: string): Promise<SignupPaymentSetup> {
      const sr = deps.signupRequestStore;
      const ps = deps.paymentSetup;
      if (sr === undefined || ps === undefined) {
        throw new Error('self-serve signup is not configured');
      }
      const req = await sr.get(signupId);
      if (req === null) throw new Error('unknown signup');
      // Card-testing guard: never open a PSP setup intent until the email is proven.
      if (req.status !== 'email_verified' && req.status !== 'payment_ready') {
        throw new Error('verify your email before adding a payment method');
      }
      let customerRef = req.customerRef;
      if (customerRef === undefined) {
        const customer = await ps.createCustomer({
          email: req.email,
          idempotencyKey: `signup-customer:${signupId}`,
          metadata: { signup_id: signupId },
        });
        customerRef = customer.customerRef;
        await sr.update(signupId, { customerRef, updatedAt: new Date().toISOString() });
      }
      const intent = await ps.createSetupIntent({
        customerRef,
        idempotencyKey: `signup-setup-intent:${signupId}`,
        metadata: { signup_id: signupId },
      });
      await sr.update(signupId, {
        setupIntentId: intent.setupIntentId,
        status: 'payment_ready',
        updatedAt: new Date().toISOString(),
      });
      observe('signup.payment_setup', { outcome: 'ok', context: { signupId } });
      return { clientSecret: intent.clientSecret, setupIntentId: intent.setupIntentId };
    },

    async completeSignup(signupId: string, input: CompleteSignupInput): Promise<SignupStatus> {
      const sr = deps.signupRequestStore;
      const ps = deps.paymentSetup;
      const q = deps.signupQueue;
      if (sr === undefined || ps === undefined || q === undefined) {
        throw new Error('self-serve signup is not configured');
      }
      const req = await sr.get(signupId);
      if (req === null) throw new Error('unknown signup');
      if (req.customerRef === undefined || req.setupIntentId === undefined) {
        throw new Error('add a payment method before completing signup');
      }
      // Never trust the client: confirm server-side that a payment method was actually saved.
      const intent = await ps.getSetupIntent(req.setupIntentId);
      if (intent.status !== 'succeeded' || intent.paymentMethodRef === undefined) {
        throw new Error('payment method not confirmed');
      }
      if (intent.customerRef !== req.customerRef) throw new Error('payment/customer mismatch');
      const slug = assertSlug(input.slug);
      const region = resolveRegion(input.region, input.residency);
      // Generic "unavailable" — never reveal whether the slug belongs to another tenant (no enumeration).
      const existing = await registry.getBySlug(slug);
      if (existing !== null) throw new Error('slug unavailable');
      const catalog = deps.plans ?? [];
      const plan = input.planId !== undefined ? findPlan(catalog, input.planId) : undefined;
      if (input.planId !== undefined && plan === undefined) throw new Error('unknown plan');
      // Billing link + plan recorded on the tenant; the worker's provision applies it (parity with
      // redeemSignupToken). The connection secret is generated then, never here.
      const metadata: JsonObject = {
        billingCustomerRef: req.customerRef,
        billingEmail: req.email,
        ...(plan !== undefined ? { planId: plan.id } : {}),
      };
      // Enqueue async provision (Neon project creation is slow); the worker runs tf.provision.
      await q.enqueue({ id: randomUUID(), type: 'provision', slug, region, metadata });
      const nowIso = new Date().toISOString();
      await sr.update(signupId, {
        slug,
        region,
        ...(plan !== undefined ? { planId: plan.id } : {}),
        status: 'provisioning',
        updatedAt: nowIso,
      });
      observe('signup.completed', { outcome: 'ok', context: { signupId, slug, region } });
      return { status: 'provisioning', slug };
    },

    async signupStatus(signupId: string): Promise<SignupStatus> {
      const sr = deps.signupRequestStore;
      if (sr === undefined) throw new Error('self-serve signup is not configured');
      const req = await sr.get(signupId);
      if (req === null) throw new Error('unknown signup');
      // Has the async provision finished? Resolve by the request's OWN slug (a request sees only its tenant).
      if (req.status === 'provisioning' && req.slug !== undefined) {
        const tenant = await registry.getBySlug(req.slug);
        if (tenant !== null && tenant.status === 'active') {
          await sr.update(signupId, {
            status: 'active',
            tenantId: tenant.id,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      const fresh = await sr.get(signupId);
      if (fresh === null) throw new Error('unknown signup');
      let connectionUri: string | undefined;
      // One-time reveal: only when active + not yet revealed; mark revealed so it never shows again.
      if (canRevealConnection(fresh) && fresh.tenantId !== undefined) {
        const uri = await secretStore.get(fresh.tenantId);
        if (uri !== null) {
          connectionUri = uri;
          await sr.update(signupId, { connectionRevealedAt: new Date().toISOString() });
        }
      }
      return {
        status: fresh.status,
        ...(fresh.slug !== undefined ? { slug: fresh.slug } : {}),
        ...(connectionUri !== undefined ? { connectionUri } : {}),
      };
    },

    async createWebhookSubscription(input: {
      url: string;
      eventTypes?: readonly string[];
    }): Promise<WebhookSubscriptionCreated> {
      const store = deps.webhookSubscriptionStore;
      if (store === undefined) {
        throw new Error('webhook subscriptions require a configured subscription store');
      }
      // SSRF: https-only (unless the documented local opt-out); fail closed before persisting.
      assertHttpsUrl(input.url, 'webhook subscription url', deps.allowInsecureWebhookUrl ?? false);
      const id = randomUUID();
      const secret = randomBytes(32).toString('base64url'); // shown once; never re-readable
      const eventTypes = [...(input.eventTypes ?? [])];
      const createdAt = new Date().toISOString();
      // The signing secret lives in the encrypted SecretStore, never the subscriptions table.
      await secretStore.set(webhookSecretKey(id), secret);
      await store.create({ id, url: input.url, eventTypes, active: true, createdAt });
      // Event carries id/url/filter — NEVER the signing secret (master §5).
      observe('webhook.subscription_created', {
        outcome: 'ok',
        context: { id, url: input.url, eventTypes },
      });
      return { id, url: input.url, secret, eventTypes, createdAt };
    },

    async listWebhookSubscriptions(limit = 50): Promise<WebhookSubscriptionSummary[]> {
      const store = deps.webhookSubscriptionStore;
      if (store === undefined) return [];
      const rows = await store.list(limit);
      return rows.map(toWebhookSubscriptionSummary); // no secret to redact — it isn't in the record
    },

    async deleteWebhookSubscription(id: string): Promise<boolean> {
      const store = deps.webhookSubscriptionStore;
      if (store === undefined) return false;
      const removed = await store.delete(id);
      if (removed) {
        await secretStore.delete(webhookSecretKey(id)); // crypto-shred the signing secret
        observe('webhook.subscription_deleted', { outcome: 'ok', context: { id } });
      }
      return removed;
    },

    async getTenant(id: string): Promise<TenantRecord | null> {
      return registry.getById(id);
    },

    async suspend(id: string): Promise<TenantRecord> {
      const tenant = await requireTenant(id);
      return transition(tenant, 'suspended');
    },

    async resume(id: string): Promise<TenantRecord> {
      const tenant = await requireTenant(id);
      // `resume` reactivates a *suspended* tenant. Reactivating an *offboarded* one is policy-gated
      // (retention window) — route it through `restore` so the gate can't be bypassed here
      // (complete mediation; master §2).
      if (tenant.status === 'offboarding') {
        throw new Error('cannot resume an offboarding tenant; use restore (retention-gated)');
      }
      return transition(tenant, 'active');
    },

    async restore(id: string): Promise<TenantRecord> {
      const tenant = await requireTenant(id);
      // Restore is the inverse of offboard: only an offboarding tenant can be restored.
      if (tenant.status !== 'offboarding') {
        throw new Error(`restore requires an offboarding tenant (status: ${tenant.status})`);
      }
      // Fail closed once the retention window has elapsed: the tenant is eligible for purge, so its
      // archive may be gone and policy forbids revival — past the window, restore is refused.
      const retentionDays = deps.retentionDays ?? DEFAULT_RETENTION_DAYS;
      if (isPurgeable(tenant, retentionCutoff(new Date(), retentionDays))) {
        throw new Error('tenant is past its retention window (eligible for purge); cannot restore');
      }
      // The Neon project was RETAINED at offboard (scaled to zero), so reviving is just the inverse
      // status transition — no re-provisioning, and the connection secret is intact.
      return transition(tenant, 'active');
    },

    async offboard(id: string): Promise<OffboardOutcome> {
      const tenant = await requireTenant(id);
      // Move into offboarding (validates the transition; blocks routing). The Neon project is
      // RETAINED (Neon scales it to zero ≈ $0) — reversible until purge; NOT deleted here.
      const offboarding = await transition(tenant, 'offboarding');
      const archive = exporter ? await exporter.exportTenant(offboarding) : null;
      return { tenant: offboarding, archive };
    },

    async exportTenantData(id: string): Promise<ExportResult> {
      const tenant = await requireTenant(id);
      if (exporter === undefined) {
        throw new Error('data export requires a configured exporter');
      }
      const result = await exporter.exportTenant(tenant);
      // Audit who exported what, when (compliance / DSAR trail). The location is a reference to the
      // written artifact (object-store URI), not tenant data — safe to record.
      observe('tenant.exported', {
        tenantId: id,
        outcome: 'ok',
        context: {
          location: result.location,
          ...(result.bytes !== undefined ? { bytes: result.bytes } : {}),
        },
      });
      return result;
    },

    exportHistory(limit = 20): Promise<TenantEvent[]> {
      if (auditLog === undefined) return Promise.resolve([]);
      return auditLog.query({ events: ['tenant.exported'], limit });
    },

    async purge(id: string): Promise<TenantRecord> {
      return purgeTenant(await requireTenant(id));
    },

    async erase(id: string, options: EraseOptions): Promise<SignedErasureCertificate> {
      const signed = await buildErasureEngine().erase(id, options);
      // The engine sets status directly (bypassing `transition`) — drop any cached resolution.
      invalidateConnection(id);
      return signed;
    },

    async erasureCertificatePublicKey(): Promise<import('jose').JWK | null> {
      return certificateSigner === undefined ? null : certificateSigner.publicKeyJwk();
    },

    async rehome(id: string, options: RehomeOptions): Promise<RehomeResult> {
      if (deps.dataMover === undefined) {
        throw new Error('rehome: a dataMover is required to copy tenant data between regions');
      }
      const engine = createRehomeEngine({
        registry,
        provisioning,
        secretStore,
        dataMover: deps.dataMover,
        allowedRegions,
        emit: (event) => eventSink.emit(event),
      });
      const result = await engine.rehome(id, options);
      // The new project means a new connection URI — drop any cached resolution.
      invalidateConnection(id);
      return result;
    },

    rotateSecret(id: string): Promise<RotationResult> {
      return createSecretRotationEngine({
        registry,
        provisioning,
        secretStore,
        onRotated: invalidateConnection,
        emit: (event) => eventSink.emit(event),
      }).rotate(id);
    },

    rotateSecrets(options?: { limit?: number }): Promise<RotationSweepReport> {
      return createSecretRotationEngine({
        registry,
        provisioning,
        secretStore,
        onRotated: invalidateConnection,
        emit: (event) => eventSink.emit(event),
      }).rotateAll(options);
    },

    snapshot(id: string): Promise<SnapshotResult> {
      return backupEngine().snapshot(id);
    },

    snapshotFleet(options?: { limit?: number }): Promise<BackupSweepReport> {
      return backupEngine().snapshotAll(options);
    },

    pruneSnapshots(options?: {
      limit?: number;
      policy?: RetentionPolicy;
    }): Promise<BackupSweepReport> {
      return backupEngine().pruneAll(options);
    },

    restoreSnapshot(id: string, snapshotId: string): Promise<void> {
      return backupEngine().restore(id, snapshotId);
    },

    archive(id: string): Promise<ArchiveResult> {
      return backupEngine().archive(id);
    },

    archiveFleet(options?: { limit?: number }): Promise<BackupSweepReport> {
      return backupEngine().archiveAll(options);
    },

    async purgeExpired(options: PurgeSweepOptions = {}): Promise<PurgeSweepReport> {
      const retentionDays = options.retentionDays ?? deps.retentionDays ?? DEFAULT_RETENTION_DAYS;
      const cutoff = retentionCutoff(options.now ?? new Date(), retentionDays);
      const offboarding = await registry.list({ status: 'offboarding', limit: MAX_SWEEP });
      const expired = offboarding.filter((t) => isPurgeable(t, cutoff));
      const purged: string[] = [];
      const failed: { tenantId: string; error: string }[] = [];
      // Sequential + failure-isolated: one tenant's failure never blocks the rest of the sweep.
      for (const tenant of expired) {
        try {
          await purgeTenant(tenant);
          purged.push(tenant.id);
        } catch (error) {
          failed.push({
            tenantId: tenant.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      observe('tenant.purge_sweep', {
        outcome: failed.length > 0 ? 'error' : 'ok',
        context: { scanned: offboarding.length, purged: purged.length, failed: failed.length },
      });
      return { scanned: offboarding.length, purged, failed };
    },

    async retentionReport(
      options: { retentionDays?: number; now?: Date } = {},
    ): Promise<RetentionReport> {
      const retentionDays = options.retentionDays ?? deps.retentionDays ?? DEFAULT_RETENTION_DAYS;
      const offboarding = await registry.list({ status: 'offboarding', limit: MAX_SWEEP });
      return buildRetentionReport(offboarding, { now: options.now ?? new Date(), retentionDays });
    },

    async getConnection(id: string): Promise<TenantConnection> {
      const start = performance.now();
      try {
        const conn = await router.resolve(id);
        // Emit the resolution outcome ONLY — never the connection URI (it is a secret).
        observe('tenant.connection_resolved', {
          tenantId: id,
          outcome: 'ok',
          durationMs: Math.round(performance.now() - start),
        });
        return conn;
      } catch (error) {
        observe('tenant.connection_denied', {
          tenantId: id,
          outcome: 'error',
          durationMs: Math.round(performance.now() - start),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    async migrateFleet(
      spec: FleetMigrationSpec,
      options?: MigrateFleetOptions,
    ): Promise<FleetMigrationReport> {
      if (!migrationRunner) {
        throw new Error('migrateFleet: no migration runner configured');
      }
      const orchestrator = createFleetOrchestrator({
        registry,
        connectionRouter: router,
        migrationRunner,
      });
      const report = await orchestrator.migrateFleet(spec, options);
      observe('fleet.migration', {
        outcome: report.failed.length > 0 ? 'error' : 'ok',
        context: {
          version: report.version,
          total: report.total,
          succeeded: report.succeeded.length,
          failed: report.failed.length,
          alreadyApplied: report.alreadyApplied,
        },
      });
      return report;
    },

    fleetStatus(options?: { limit?: number }): Promise<FleetDriftReport> {
      // migrationStatus is read-only (no applies) — a placeholder runner suffices when none is wired.
      const orchestrator = createFleetOrchestrator({
        registry,
        connectionRouter: router,
        migrationRunner: migrationRunner ?? {
          applyToTenant: () =>
            Promise.reject(new Error('fleetStatus: no migration runner is configured')),
        },
      });
      return orchestrator.migrationStatus(options);
    },

    reconcilePlan(options?: ReconcileFleetOptions): Promise<FleetReconcilePlan> {
      return reconcileOrchestrator().reconcilePlan(options);
    },

    async reconcileFleet(
      specs: readonly FleetMigrationSpec[],
      options?: ReconcileFleetOptions,
    ): Promise<FleetReconcileReport> {
      if (!migrationRunner) {
        throw new Error('reconcileFleet: no migration runner configured');
      }
      const orchestrator = createFleetOrchestrator({
        registry,
        connectionRouter: router,
        migrationRunner,
      });
      const report = await orchestrator.reconcileFleet(specs, options);
      observe('fleet.reconcile', {
        outcome: report.partial.length > 0 || report.canaryAborted === true ? 'error' : 'ok',
        context: {
          target: report.target,
          total: report.total,
          reconciled: report.reconciled.length,
          partial: report.partial.length,
          alreadyAtLatest: report.alreadyAtLatest,
          ...(report.canaryAborted === true ? { canaryAborted: true } : {}),
        },
      });
      return report;
    },

    reconcileHistory(limit = 20): Promise<TenantEvent[]> {
      // Degrades gracefully: no persisted audit trail ⇒ no history (not an error).
      if (auditLog === undefined) return Promise.resolve([]);
      return auditLog.query({ events: ['fleet.reconcile'], limit });
    },

    async usage(id: string, period: BillingPeriod): Promise<TenantUsage> {
      if (!usageProvider) {
        throw new Error('usage: no usage provider configured');
      }
      assertPeriod(period);
      const tenant = await requireTenant(id);
      if (tenant.neonProjectId === null) {
        throw new Error(`tenant ${id} has no provisioned project to meter`);
      }
      const consumption = aggregateConsumption(
        await usageProvider.getProjectConsumption(tenant.neonProjectId, period),
      );
      observe('tenant.metered', {
        tenantId: id,
        outcome: 'ok',
        context: {
          computeTimeSeconds: consumption.computeTimeSeconds,
          activeTimeSeconds: consumption.activeTimeSeconds,
          writtenDataBytes: consumption.writtenDataBytes,
          syntheticStorageBytes: consumption.syntheticStorageBytes,
        },
      });
      return {
        tenantId: id,
        neonProjectId: tenant.neonProjectId,
        period: { from: period.from.toISOString(), to: period.to.toISOString() },
        consumption,
      };
    },

    checkQuota(id: string, period: BillingPeriod, quota: Quota): Promise<QuotaCheckResult> {
      assertPeriod(period);
      return quotaEngine().check(id, period, quota);
    },

    checkQuotas(
      period: BillingPeriod,
      quota: Quota,
      options?: { limit?: number; enforce?: boolean },
    ): Promise<QuotaSweepReport> {
      assertPeriod(period);
      return quotaEngine().checkAll(period, quota, {
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
        // Enforcement (opt-in): suspend an over-quota tenant via the proper lifecycle transition.
        ...(options?.enforce === true
          ? {
              onBreach: async (tid: string) =>
                void (await transition(await requireTenant(tid), 'suspended')),
            }
          : {}),
      });
    },

    async checkUsageAlerts(
      period: BillingPeriod,
      options?: { limit?: number; notify?: boolean },
    ): Promise<UsageAlertSweepReport> {
      assertPeriod(period);
      const report = await usageAlertEngine().checkAll(period, {
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
      });
      // Optional best-effort email to each alerted tenant (audit/webhook already fired in the engine).
      if (options?.notify === true) {
        for (const a of report.alerted) {
          await notifyUsageAlert({
            tenantId: a.tenantId,
            alerts: a.alerts.map((x) => ({
              metric: x.metric,
              usedFraction: x.usedFraction,
              thresholdCrossed: x.thresholdCrossed,
            })),
            periodStart: period.from.toISOString(),
            periodEnd: period.to.toISOString(),
          });
        }
      }
      return report;
    },

    usageAlertHistory(limit = 20): Promise<TenantEvent[]> {
      if (auditLog === undefined) return Promise.resolve([]);
      return auditLog.query({ events: ['tenant.usage_alert'], limit });
    },

    async listTenants(options?: {
      status?: TenantStatus;
      limit?: number;
      cursor?: { createdAt: Date; id: string };
    }): Promise<TenantRecord[]> {
      return registry.list(options);
    },

    async complianceReport(): Promise<ComplianceReportResult> {
      return assembleComplianceReport();
    },

    async signedComplianceReport(): Promise<SignedComplianceReport> {
      // Fail closed without a signer — there is no unsigned "signed report" path (the JWS IS the
      // product; mirrors the always-signed erasure discipline — master §2 fail-closed / ADR-0011).
      if (complianceReportSigner === undefined) {
        throw new Error(
          'signedComplianceReport: no compliance-report signer configured (set TENANTFORGE_COMPLIANCE_SIGNING_KEY)',
        );
      }
      const { report, digest } = await assembleComplianceReport();
      // Authenticity anchor: EdDSA JWS over the SAME canonical report bytes the digest covers.
      const jws = await complianceReportSigner.signReport(report);
      observe('compliance.report_signed', {
        outcome: report.isolation.compliant && report.residency.compliant ? 'ok' : 'error',
        context: {
          digest,
          tenants: report.inventory.total,
          isolationCompliant: report.isolation.compliant,
          residencyCompliant: report.residency.compliant,
        },
      });
      return { report, jws, digest };
    },

    async complianceReportPublicKey(): Promise<import('jose').JWK | null> {
      return complianceReportSigner === undefined ? null : complianceReportSigner.publicKeyJwk();
    },

    async evidenceBundle(options: {
      scope: EvidenceScope;
      tenantId?: string;
      erasureCertificates?: readonly string[];
    }): Promise<SignedEvidenceBundle> {
      return assembleEvidenceBundle(options);
    },

    async evidenceBundlePublicKey(): Promise<import('jose').JWK | null> {
      return evidenceBundleSigner === undefined ? null : evidenceBundleSigner.publicKeyJwk();
    },

    async queryAudit(query: AuditQueryInput = {}): Promise<TenantEvent[]> {
      if (auditLog === undefined) return [];
      const q = normalizeAuditQuery(query); // validates + clamps (throws on bad limit/since)
      return auditLog.query({
        ...(q.events !== undefined ? { events: q.events } : {}),
        ...(q.tenantId !== undefined ? { tenantId: q.tenantId } : {}),
        ...(q.since !== undefined ? { since: q.since } : {}),
        limit: q.limit,
      });
    },

    async scanAuditAnomalies(
      opts: { since?: string; limit?: number; thresholds?: AnomalyThresholds } = {},
    ): Promise<AuditAnomaly[]> {
      if (auditLog === undefined) return [];
      // Read a recent window (default 500), then detect over it with the pure core.
      const q = normalizeAuditQuery(
        {
          ...(opts.since !== undefined ? { since: opts.since } : {}),
          limit: opts.limit ?? 500,
        },
        { defaultLimit: 500 },
      );
      const events = await auditLog.query({
        ...(q.since !== undefined ? { since: q.since } : {}),
        limit: q.limit,
      });
      return detectAuditAnomalies(events, opts.thresholds ?? {});
    },

    costReport(period: BillingPeriod): Promise<CostReport> {
      assertPeriod(period);
      return costEngine().report(period);
    },

    async scanCostAnomalies(
      period: BillingPeriod,
      thresholds: CostAnomalyThresholds = {},
    ): Promise<CostAnomaly[]> {
      assertPeriod(period);
      const report = await costEngine().report(period); // fails closed without a usage provider
      return detectCostAnomalies(report.rows, thresholds);
    },

    async operatorDigest(
      options: { period?: BillingPeriod; notify?: boolean } = {},
    ): Promise<OperatorDigest> {
      const period = options.period ?? currentMonthPeriod();
      assertPeriod(period);
      const digest = await gatherOperatorDigest(period);
      // Emit on the event stream (→ JSON logs, audit store, outbound webhooks/SIEM) as the alert
      // hook; a non-`ok` severity is recorded as outcome `error` so anomaly alerting can key off it.
      observe('operator.digest', {
        outcome: digest.severity === 'critical' || digest.severity === 'warning' ? 'error' : 'ok',
        context: {
          severity: digest.severity,
          totalIssues: digest.totalIssues,
          ...Object.fromEntries(digest.categories.map((c) => [c.category, c.severity])),
        },
      });
      if (options.notify === true) await maybeNotifyDigest(digest);
      return digest;
    },

    async invoice(id: string, period: BillingPeriod): Promise<Invoice> {
      assertPeriod(period);
      return invoiceEngine().invoice(id, period);
    },

    async invoiceFleet(period: BillingPeriod): Promise<FleetInvoiceReport> {
      assertPeriod(period);
      return invoiceEngine().invoiceFleet(period);
    },

    async sendInvoice(id: string, period: BillingPeriod): Promise<InvoiceSendResult> {
      assertPeriod(period);
      return deliverInvoice(id, period);
    },

    async sendInvoiceFleet(period: BillingPeriod): Promise<FleetInvoiceDeliveryReport> {
      assertPeriod(period);
      if (notifier === undefined) {
        throw new Error('invoice delivery requires a configured notifier');
      }
      const active = await registry.list({ status: 'active', limit: MAX_SWEEP });
      const sent: string[] = [];
      const skipped: { tenantId: string; reason: string }[] = [];
      const failed: { tenantId: string; error: string }[] = [];
      for (const tenant of active) {
        try {
          const result = await deliverInvoice(tenant.id, period);
          if (result.sent) sent.push(tenant.id);
          else skipped.push({ tenantId: tenant.id, reason: result.reason ?? 'skipped' });
        } catch (error) {
          failed.push({
            tenantId: tenant.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      sent.sort();
      return { generatedAt: new Date().toISOString(), sent, skipped, failed };
    },

    invoiceDeliveryHistory(limit = 20): Promise<TenantEvent[]> {
      if (auditLog === undefined) return Promise.resolve([]);
      return auditLog.query({ events: ['tenant.invoiced'], limit });
    },

    async chargeInvoice(id: string, period: BillingPeriod): Promise<ChargeResult> {
      assertPeriod(period);
      if (paymentGateway === undefined) {
        throw new Error('charging requires a configured payment gateway');
      }
      const tenant = await requireTenant(id);
      const customerRef = billingCustomerRef(tenant.metadata);
      if (customerRef === undefined) {
        throw new Error(`tenant ${id} has no billingCustomerRef in metadata`);
      }
      return chargeTenant(id, customerRef, period);
    },

    async chargeInvoiceFleet(period: BillingPeriod): Promise<FleetChargeReport> {
      assertPeriod(period);
      if (paymentGateway === undefined) {
        throw new Error('charging requires a configured payment gateway');
      }
      return chargeFleetRun(period);
    },

    chargeHistory(limit = 20): Promise<TenantEvent[]> {
      if (auditLog === undefined) return Promise.resolve([]);
      return auditLog.query({ events: ['tenant.charged'], limit });
    },

    async runDunning(
      period: BillingPeriod = currentMonthPeriod(),
      schedule: DunningSchedule = DEFAULT_DUNNING_SCHEDULE,
    ): Promise<DunningReport> {
      assertPeriod(period);
      if (paymentGateway === undefined) {
        throw new Error('dunning requires a configured payment gateway');
      }
      return dunningSweepRun(period, schedule);
    },

    dunningHistory(limit = 20): Promise<TenantEvent[]> {
      if (auditLog === undefined) return Promise.resolve([]);
      return auditLog.query({ events: ['tenant.dunning'], limit });
    },

    async billingRun(
      period: BillingPeriod = currentMonthPeriod(),
      opts: BillingRunOptions = {},
    ): Promise<BillingRunReport> {
      assertPeriod(period);
      if (paymentGateway === undefined) {
        throw new Error('billing run requires a configured payment gateway');
      }
      // Charge the fleet first (each charge is idempotent — safe if the scheduler double-fires),
      // then run dunning so a charge that just failed this run can begin its retry/escalation clock.
      const charge = await chargeFleetRun(period);
      const dunning = opts.skipDunning
        ? undefined
        : await dunningSweepRun(period, opts.dunningSchedule ?? DEFAULT_DUNNING_SCHEDULE);
      const report: BillingRunReport = {
        generatedAt: new Date().toISOString(),
        period: { from: period.from.toISOString(), to: period.to.toISOString() },
        charge,
        ...(dunning !== undefined ? { dunning } : {}),
      };
      // Roll-up audit event for the run (the per-tenant tenant.charged / tenant.dunning events are
      // emitted by the sweeps above). A failed charge OR dunning failure marks the run as `error`.
      const hadFailure = charge.failed.length > 0 || (dunning?.failed.length ?? 0) > 0;
      observe('billing.run', {
        outcome: hadFailure ? 'error' : 'ok',
        context: {
          period: report.period,
          charged: charge.charged.length,
          chargeSkipped: charge.skipped.length,
          chargeFailed: charge.failed.length,
          retried: dunning?.retried.length ?? 0,
          suspended: dunning?.suspended.length ?? 0,
          dunningFailed: dunning?.failed.length ?? 0,
          dunningRan: dunning !== undefined,
        },
      });
      return report;
    },

    billingRunHistory(limit = 20): Promise<TenantEvent[]> {
      if (auditLog === undefined) return Promise.resolve([]);
      return auditLog.query({ events: ['billing.run'], limit });
    },

    refundCharge(chargeId: string, opts: RefundOptions = {}): Promise<RefundResult> {
      return refundChargeImpl(chargeId, opts);
    },

    refundHistory(limit = 20): Promise<TenantEvent[]> {
      if (auditLog === undefined) return Promise.resolve([]);
      return auditLog.query({ events: ['tenant.refunded'], limit });
    },

    notificationHistory(limit = 20): Promise<TenantEvent[]> {
      if (auditLog === undefined) return Promise.resolve([]);
      return auditLog.query({ events: ['tenant.notified'], limit });
    },

    async refundUnusedPeriod(
      id: string,
      opts: { asOf?: Date; reason?: string } = {},
    ): Promise<RefundResult | null> {
      if (paymentGateway === undefined) {
        throw new Error('refunds require a configured payment gateway');
      }
      if (auditLog === undefined) {
        throw new Error('refund-on-offboard requires an audit store to find the charge to prorate');
      }
      // The most recent *successful* charge for this tenant — the one to prorate.
      const charges = await auditLog.query({
        events: ['tenant.charged'],
        tenantId: id,
        limit: MAX_SWEEP,
      });
      const latest = charges.find(
        (e) => e.outcome === 'ok' && e.context?.['chargeId'] !== undefined,
      );
      if (latest === undefined) return null; // nothing charged → nothing to refund
      const ctx = latest.context ?? {};
      const chargeId = ctx['chargeId'];
      const amountMinor = ctx['amountMinor'];
      const currency = ctx['currency'];
      const periodStart = ctx['periodStart'];
      const periodEnd = ctx['periodEnd'];
      if (
        typeof chargeId !== 'string' ||
        typeof amountMinor !== 'number' ||
        typeof currency !== 'string' ||
        typeof periodStart !== 'string' ||
        typeof periodEnd !== 'string'
      ) {
        throw new Error(
          `cannot prorate: latest charge for ${id} lacks amount/currency/period in the audit trail`,
        );
      }
      const refundMinor = prorateRefundMinor({
        chargeAmountMinor: amountMinor,
        periodStart,
        periodEnd,
        asOf: (opts.asOf ?? new Date()).toISOString(),
      });
      if (refundMinor <= 0) return null; // period fully consumed → nothing owed
      return refundChargeImpl(chargeId, {
        amountMinor: refundMinor,
        currency,
        tenantId: id,
        reason: opts.reason ?? 'offboard proration (unused period)',
      });
    },

    async tenantSummary(tenantId: string): Promise<TenantSummary | null> {
      const tenant = await registry.getById(tenantId);
      if (tenant === null) return null;
      // Curated projection — never leak raw metadata (internal flags / billingCustomerRef) or the
      // Neon project id to the tenant. Only the flat plan price is surfaced when set.
      const priceUsd = tenant.metadata['priceUsd'];
      return {
        id: tenant.id,
        slug: tenant.slug,
        region: tenant.region,
        status: tenant.status,
        createdAt: tenant.createdAt.toISOString(),
        ...(typeof priceUsd === 'number' ? { planPriceUsd: priceUsd } : {}),
      };
    },

    tenantCharges(tenantId: string, limit = 20): Promise<TenantEvent[]> {
      if (auditLog === undefined) return Promise.resolve([]);
      return auditLog.query({ events: ['tenant.charged'], tenantId, limit });
    },

    tenantRefunds(tenantId: string, limit = 20): Promise<TenantEvent[]> {
      if (auditLog === undefined) return Promise.resolve([]);
      return auditLog.query({ events: ['tenant.refunded'], tenantId, limit });
    },

    tenantNotifications(tenantId: string, limit = 20): Promise<TenantEvent[]> {
      if (auditLog === undefined) return Promise.resolve([]);
      return auditLog.query({ events: ['tenant.notified'], tenantId, limit });
    },

    async previewPlanChange(
      id: string,
      newPriceUsd: number,
      opts?: { period?: BillingPeriod; asOf?: Date },
    ): Promise<PlanChangePreview> {
      const q = await quotePlanChange(id, newPriceUsd, opts);
      return {
        tenantId: id,
        oldPriceUsd: q.oldPriceUsd,
        newPriceUsd,
        period: { from: q.period.from.toISOString(), to: q.period.to.toISOString() },
        proratedDeltaMinor: q.proratedDeltaMinor,
      };
    },

    async changePlan(
      id: string,
      newPriceUsd: number,
      opts: PlanChangeOptions = {},
    ): Promise<PlanChangeReport> {
      const q = await quotePlanChange(id, newPriceUsd, opts);
      // Apply the plan-price change (a metadata merge — never touches tenant content).
      await registry.updateMetadata(id, { priceUsd: newPriceUsd });
      invalidateConnection(id); // a metadata change drops any cached resolution for this tenant

      let settlement: PlanChangeReport['settlement'] = 'none';
      let settlementId: string | undefined;
      const delta = q.proratedDeltaMinor;
      const planRef = `tenantforge:plan-change:${id}:${q.period.from.toISOString()}..${q.period.to.toISOString()}:${Math.round(newPriceUsd * 100)}`;
      if (opts.settle === true && delta !== 0) {
        if (delta < 0 && creditLedger !== undefined) {
          // Downgrade with a credit ledger → grant the FULL (uncapped) credit to the balance, to be
          // drawn down on the next charge. No gateway / prior charge needed — the cap is gone.
          await creditLedger.grant({
            tenantId: id,
            amountMinor: -delta,
            currency: 'usd',
            reason: 'plan downgrade proration',
            reference: planRef,
          });
          settlement = 'credited';
        } else if (paymentGateway === undefined) {
          throw new Error('plan-change settlement requires a payment gateway (or a credit ledger)');
        } else {
          const customerRef = billingCustomerRef(q.tenant.metadata);
          if (customerRef === undefined) {
            settlement = 'skipped';
          } else if (delta > 0) {
            // Upgrade → charge the prorated delta as a one-off (recorded under tenant.plan_changed).
            const result = await paymentGateway.charge({
              amountMinor: delta,
              currency: 'usd',
              customerRef,
              idempotencyKey: planRef,
              description: `TenantForge plan change ${id}`,
              metadata: { tenant_id: id },
            });
            settlement = 'charged';
            settlementId = result.id;
          } else {
            // Downgrade, no credit ledger → refund against the latest charge, capped at it (legacy).
            const latest = await latestOkCharge(id);
            if (latest === undefined) {
              settlement = 'skipped';
            } else {
              const result = await refundChargeImpl(latest.chargeId, {
                amountMinor: Math.min(-delta, latest.amountMinor),
                currency: latest.currency,
                tenantId: id,
                reason: 'plan downgrade proration',
              });
              settlement = 'refunded';
              settlementId = result.id;
            }
          }
        }
      }
      observe('tenant.plan_changed', {
        tenantId: id,
        outcome: 'ok',
        context: {
          oldPriceUsd: q.oldPriceUsd,
          newPriceUsd,
          proratedDeltaMinor: delta,
          settlement,
          ...(settlementId !== undefined ? { settlementId } : {}),
        },
      });
      return {
        tenantId: id,
        oldPriceUsd: q.oldPriceUsd,
        newPriceUsd,
        period: { from: q.period.from.toISOString(), to: q.period.to.toISOString() },
        proratedDeltaMinor: delta,
        settlement,
        ...(settlementId !== undefined ? { settlementId } : {}),
      };
    },

    planChangeHistory(limit = 20): Promise<TenantEvent[]> {
      if (auditLog === undefined) return Promise.resolve([]);
      return auditLog.query({ events: ['tenant.plan_changed'], limit });
    },

    async tenantPaymentSetup(tenantId: string): Promise<SignupPaymentSetup> {
      const ps = deps.paymentSetup;
      if (ps === undefined) throw new Error('self-serve payment is not configured');
      const tenant = await requireTenant(tenantId);
      // Read the tenant's PSP customer from its OWN metadata (server-derived id) — fail closed when
      // it has none, so a SetupIntent is never opened against a missing/foreign customer (red-team F5).
      const customerRef = billingCustomerRef(tenant.metadata);
      if (customerRef === undefined) {
        throw new Error('no billing customer on file; cannot add a payment method');
      }
      const intent = await ps.createSetupIntent({
        customerRef,
        idempotencyKey: `tenant-setup-intent:${tenantId}`,
        metadata: { tenant_id: tenantId },
      });
      observe('tenant.payment_setup', { tenantId, outcome: 'ok' });
      return { clientSecret: intent.clientSecret, setupIntentId: intent.setupIntentId };
    },

    async confirmTenantPaymentMethod(
      tenantId: string,
      setupIntentId: string,
    ): Promise<TenantPaymentMethodResult> {
      const ps = deps.paymentSetup;
      if (ps === undefined) throw new Error('self-serve payment is not configured');
      const tenant = await requireTenant(tenantId);
      const customerRef = billingCustomerRef(tenant.metadata);
      if (customerRef === undefined) {
        throw new Error('no billing customer on file; cannot set a payment method');
      }
      // Never trust the client's "card saved": read the intent back server-side.
      const intent = await ps.getSetupIntent(setupIntentId);
      if (intent.status !== 'succeeded' || intent.paymentMethodRef === undefined) {
        throw new Error('payment method not confirmed');
      }
      // PSP-side BOLA: the intent's customer MUST be THIS tenant's billing customer — a SetupIntent
      // for customer X cannot be applied to tenant Y (red-team F5; mirrors completeSignup).
      if (intent.customerRef !== customerRef) throw new Error('payment/customer mismatch');
      // Make it the PSP default FIRST — this is the step the off-session charge path actually reads
      // (the gateway charges the customer's invoice_settings.default_payment_method). Fail closed: if
      // the PSP set-default throws, do NOT write local metadata or report success — otherwise the
      // customer sees "card updated" while future charges keep using the old default (review M1).
      await ps.setDefaultPaymentMethod(customerRef, intent.paymentMethodRef);
      // Mirror the default reference locally for display/audit only (the PSP is the source of truth).
      await registry.updateMetadata(tenantId, { defaultPaymentMethodRef: intent.paymentMethodRef });
      invalidateConnection(tenantId);
      // Audit with a reference only — never the PAN/card data (master §5).
      observe('tenant.payment_method_updated', {
        tenantId,
        outcome: 'ok',
        context: { setupIntentId },
      });
      return { tenantId, hasDefault: true, setupIntentId };
    },

    async tenantInvoices(tenantId: string, months = 3): Promise<Invoice[]> {
      // Bound the trailing window (1..12) — an unbounded range is both slow and a DoS lever.
      const count = Math.min(12, Math.max(1, Math.floor(months)));
      const engine = invoiceEngine(); // fails closed without a usage provider
      await requireTenant(tenantId); // 404s a stale session naming a gone tenant
      const ref = new Date();
      const invoices: Invoice[] = [];
      for (let i = 0; i < count; i += 1) {
        const from = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - i, 1));
        // The current month runs to "now"; prior months run to their last instant.
        const to =
          i === 0
            ? ref
            : new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - i + 1, 1) - 1);
        invoices.push(await engine.invoice(tenantId, { from, to }));
      }
      return invoices; // newest period first
    },

    async requestTenantStepUp(tenantId: string, action: 'cancel' | 'erasure'): Promise<void> {
      const store = deps.oneTimeCodeStore;
      if (store === undefined || notifier === undefined) {
        throw new Error('step-up is not configured');
      }
      const tenant = await requireTenant(tenantId);
      const to = billingEmail(tenant.metadata);
      if (to === undefined) throw new Error('no verified email on file for step-up');
      // A 6-digit single-use code; persist only its hash (master §5). Independent of the OIDC token.
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const codeHash = createHash('sha256').update(code).digest('hex');
      const ttlMs = deps.stepUpCodeTtlMs ?? 10 * 60 * 1000;
      await store.put({
        tenantId,
        action,
        codeHash,
        expiresAtMs: Date.now() + ttlMs,
        attempts: 0,
      });
      await notifier.notify({
        to,
        subject: `Confirm your TenantForge ${action} request`,
        body: `Your confirmation code for the requested ${action} is ${code}. It expires in ${Math.round(ttlMs / 60000)} minutes. If you did not request this, ignore this email and review your account.`,
        idempotencyKey: `stepup:${tenantId}:${action}:${codeHash}`,
      });
      // Audit the REQUEST without the code or email (PII/secret — master §5).
      observe('tenant.stepup_requested', { tenantId, outcome: 'ok', context: { action } });
    },

    async verifyTenantStepUp(
      tenantId: string,
      action: 'cancel' | 'erasure',
      code: string,
    ): Promise<boolean> {
      const store = deps.oneTimeCodeStore;
      if (store === undefined) throw new Error('step-up is not configured');
      const codeHash = createHash('sha256').update(code).digest('hex');
      const maxAttempts = deps.stepUpMaxAttempts ?? 5;
      const result = await store.verify(tenantId, action, codeHash, maxAttempts, Date.now());
      observe('tenant.stepup_verified', {
        tenantId,
        outcome: result.outcome === 'ok' ? 'ok' : 'error',
        context: { action, result: result.outcome },
      });
      return result.outcome === 'ok';
    },

    async cancelTenant(tenantId: string): Promise<TenantCancelResult> {
      const tenant = await requireTenant(tenantId);
      // Self-serve cancel = offboard (project RETAINED, scaled to zero) — reversible until purge,
      // NEVER purge. `offboarding` tenants are excluded from billing/dunning sweeps (they filter to
      // `active`), so a cancelled tenant isn't charged or dunned (red-team F3c).
      const offboarding = await transition(tenant, 'offboarding');
      const retentionDays = deps.retentionDays ?? DEFAULT_RETENTION_DAYS;
      const reversibleUntil = new Date(
        offboarding.updatedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      observe('tenant.offboarded', {
        tenantId,
        outcome: 'ok',
        context: { selfServe: true, reversibleUntil },
      });
      // Griefing tripwire / wrong-account safety net: alert the operator and the tenant (best-effort).
      await alertSelfServeDestructive(tenant, 'cancel', { reversibleUntil });
      return { tenantId, status: offboarding.status, reversibleUntil };
    },

    async requestTenantErasure(
      tenantId: string,
      reason: string,
    ): Promise<TenantErasureRequestResult> {
      const store = deps.pendingErasureStore;
      if (store === undefined) throw new Error('self-serve erasure is not configured');
      // Always-signed: never SCHEDULE an erasure that can't later be signed (so there is never an
      // erased-but-unsignable case). Fail closed at request time if no signer is configured.
      if (certificateSigner === undefined) {
        throw new Error(
          'self-serve erasure requires a configured certificate signer ' +
            '(TENANTFORGE_ERASURE_SIGNING_KEY) — an erasure is always cryptographically signed',
        );
      }
      const tenant = await requireTenant(tenantId);
      const windowMs = deps.erasureUndoWindowMs ?? 48 * 60 * 60 * 1000;
      const requestedAt = new Date();
      const executeAt = new Date(requestedAt.getTime() + windowMs);
      // Capture the tenant's verified email NOW (review L2): by execution time the tenant record is
      // erased, so the address can't be read then to send the completion notice. Stored on the record
      // (PII — never logged/audited). Absent here ⇒ no tenant email on file ⇒ operator-only on execute.
      const tenantEmail = billingEmail(tenant.metadata);
      const created = await store.create({
        id: randomUUID(),
        tenantId,
        requestedAt: requestedAt.toISOString(),
        executeAt: executeAt.toISOString(),
        status: 'pending',
        reason,
        ...(tenantEmail !== undefined ? { tenantEmail } : {}),
      });
      // One in-flight erasure per tenant — a second request while one is active is rejected.
      if (created === null) throw new Error('an erasure is already in progress for this tenant');
      // The tenant KEEPS SERVING during the window (no suspend — avoids a timer-delayed self-DoS,
      // red-team F2). Schedule only; the executor runs after executeAt if it wins the atomic flip.
      observe('tenant.erasure_requested', {
        tenantId,
        outcome: 'ok',
        context: { executeAt: created.executeAt },
      });
      await alertSelfServeDestructive(tenant, 'erasure', { executeAt: created.executeAt });
      return {
        tenantId,
        requestedAt: created.requestedAt,
        executeAt: created.executeAt,
        status: created.status,
      };
    },

    async cancelTenantErasure(tenantId: string): Promise<boolean> {
      const store = deps.pendingErasureStore;
      if (store === undefined) throw new Error('self-serve erasure is not configured');
      await requireTenant(tenantId);
      // Atomic flip pending → cancelled. Wins only if the executor hadn't already claimed it.
      const cancelled = await store.cancel(tenantId, Date.now());
      observe('tenant.erasure_cancelled', {
        tenantId,
        outcome: cancelled !== null ? 'ok' : 'error',
      });
      return cancelled !== null;
    },

    async pendingErasure(tenantId: string): Promise<PendingErasureView | null> {
      const store = deps.pendingErasureStore;
      if (store === undefined) return null;
      const rec = await store.getActive(tenantId);
      if (rec === null) return null;
      // Safe projection — no id/reason leaked to the client.
      return { requestedAt: rec.requestedAt, executeAt: rec.executeAt, status: rec.status };
    },

    async executePendingErasure(id: string): Promise<SignedErasureCertificate | null> {
      const store = deps.pendingErasureStore;
      if (store === undefined) throw new Error('self-serve erasure is not configured');
      // The SINGLE point that gates destruction: win pending → processing or do nothing. A lost flip
      // (cancelled, or an at-least-once redelivery of a non-pending record) acks and exits WITHOUT
      // erasing — idempotent across redelivery, and a cancel that raced us already won (red-team F2).
      const claimed = await store.claimForProcessing(id);
      if (claimed === null) return null;
      // Always-signed engine (fails closed without a signer). A scheduled erasure could only have
      // been created while a signer was configured (requestTenantErasure gates it), so this is sound.
      const engine = buildErasureEngine();
      // A claimed (formerly `pending`) record always carries the reason set at request time; the `??`
      // is a type-level guard now that `reason` is optional (cleared only on the terminal transition).
      const signed = await engine.erase(claimed.tenantId, {
        reason: claimed.reason ?? 'self-serve erasure',
      });
      const certificate = signed.certificate;
      invalidateConnection(claimed.tenantId);
      await store.markDone(id);
      observe('tenant.erased', {
        tenantId: claimed.tenantId,
        outcome: certificate.verified && signed.jws !== undefined ? 'ok' : 'error',
        context: { verified: certificate.verified, signed: signed.jws !== undefined },
      });
      // Alert operator AND the tenant that the erasure executed (threat-model B8w: both alerted on
      // execution). The tenant record is now gone, so the tenant notice uses the email CAPTURED at
      // request time (`claimed.tenantEmail`) — review L2. Both are best-effort and never throw, so a
      // notifier failure cannot fail/roll back the already-completed erasure.
      await alertOperator(
        `Self-serve erasure executed for tenant ${claimed.tenantId} (verified: ${certificate.verified}, signed: ${signed.jws !== undefined}).`,
      );
      await alertTenantErased(claimed.tenantEmail, certificate);
      return signed;
    },

    async duePendingErasures(limit = 100): Promise<{ id: string; tenantId: string }[]> {
      const store = deps.pendingErasureStore;
      if (store === undefined) return [];
      const due = await store.listDue(Date.now(), limit);
      return due.map((r) => ({ id: r.id, tenantId: r.tenantId }));
    },

    async erasureSweep(options: { limit?: number } = {}): Promise<ErasureSweepReport> {
      const store = deps.pendingErasureStore;
      // No store wired ⇒ nothing can ever be scheduled ⇒ a clean no-op report (fail soft).
      if (store === undefined) return { scanned: 0, processed: [], skipped: [], failed: [] };
      const limit = options.limit ?? 100;
      const due = await store.listDue(Date.now(), limit);
      const processed: string[] = [];
      const skipped: string[] = [];
      const failed: { id: string; tenantId: string; error: string }[] = [];
      // Sequential + failure-isolated: one tenant's erasure failure never blocks the rest of the
      // sweep (mirrors purgeExpired). Each call wins-or-loses the atomic `pending → processing` flip
      // inside executePendingErasure, so a cancel / redelivery / concurrent sweep that already claimed
      // a record returns null → recorded as `skipped`, never re-deleted (idempotent — red-team F2).
      for (const rec of due) {
        try {
          const certificate = await this.executePendingErasure(rec.id);
          if (certificate === null) skipped.push(rec.id);
          else processed.push(rec.id);
        } catch (error) {
          failed.push({
            id: rec.id,
            tenantId: rec.tenantId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      observe('tenant.erasure_sweep', {
        outcome: failed.length > 0 ? 'error' : 'ok',
        context: {
          scanned: due.length,
          processed: processed.length,
          skipped: skipped.length,
          failed: failed.length,
        },
      });
      return { scanned: due.length, processed, skipped, failed };
    },

    async setIncludedUsage(id: string, allowance: IncludedUsage): Promise<TenantRecord> {
      const tenant = await registry.getById(id);
      if (!tenant) throw new Error(`tenant ${id} not found`);
      // Validate each provided dimension: finite and non-negative (allowances are never negative).
      const dims = [
        'computeTimeSeconds',
        'activeTimeSeconds',
        'syntheticStorageBytes',
        'writtenDataBytes',
      ] as const;
      const included: IncludedUsage = {};
      for (const dim of dims) {
        const v = allowance[dim];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          throw new Error(
            `included ${dim} must be a finite, non-negative number, got ${String(v)}`,
          );
        }
        included[dim] = v;
      }
      // Merge the allowances into metadata (never touches tenant content); {} clears them.
      await registry.updateMetadata(id, { includedUsage: included as unknown as JsonObject });
      invalidateConnection(id);
      observe('tenant.allowance_set', {
        tenantId: id,
        outcome: 'ok',
        context: { includedUsage: included as unknown as JsonObject },
      });
      const updated = await registry.getById(id);
      if (!updated) throw new Error(`tenant ${id} not found`);
      return updated;
    },

    listPlans(): PlanDefinition[] {
      return deps.plans ?? [];
    },

    async assignPlan(tenantId: string, planId: string): Promise<TenantRecord> {
      const catalog = deps.plans ?? [];
      if (catalog.length === 0)
        throw new Error('no plan catalog configured (set TENANTFORGE_PLANS)');
      const plan = findPlan(catalog, planId);
      if (plan === undefined) throw new Error(`unknown plan: ${planId}`);
      const tenant = await registry.getById(tenantId);
      if (!tenant) throw new Error(`tenant ${tenantId} not found`);
      // The plan fully defines the tenant's billing: price + allowances + the plan id.
      const patch = planAssignment(plan);
      await registry.updateMetadata(tenantId, {
        planId: patch.planId,
        priceUsd: patch.priceUsd,
        includedUsage: patch.includedUsage as unknown as JsonObject,
      });
      invalidateConnection(tenantId);
      observe('tenant.plan_assigned', {
        tenantId,
        outcome: 'ok',
        context: { planId: patch.planId, priceUsd: patch.priceUsd },
      });
      const updated = await registry.getById(tenantId);
      if (!updated) throw new Error(`tenant ${tenantId} not found`);
      return updated;
    },

    async grantCredit(
      tenantId: string,
      amountMinor: number,
      opts: { currency?: string; reason?: string } = {},
    ): Promise<void> {
      if (creditLedger === undefined) {
        throw new Error('granting credit requires a configured credit ledger');
      }
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
        throw new Error(`credit amount must be a positive integer, got ${amountMinor}`);
      }
      const currency = (opts.currency ?? 'usd').toLowerCase();
      const reason = opts.reason ?? 'operator credit';
      await creditLedger.grant({ tenantId, amountMinor, currency, reason });
      observe('tenant.credit_granted', {
        tenantId,
        outcome: 'ok',
        context: { amountMinor, currency, reason },
      });
    },

    async creditBalance(tenantId: string, currency = 'usd'): Promise<number> {
      if (creditLedger === undefined) return 0;
      return creditLedger.balance(tenantId, currency.toLowerCase());
    },

    creditHistory(
      tenantId: string,
      limit = 20,
    ): Promise<import('../ports/credit-ledger.js').CreditEntry[]> {
      if (creditLedger === undefined) return Promise.resolve([]);
      return creditLedger.history(tenantId, limit);
    },

    creditGrantHistory(limit = 20): Promise<TenantEvent[]> {
      if (auditLog === undefined) return Promise.resolve([]);
      return auditLog.query({ events: ['tenant.credit_granted'], limit });
    },

    async ingestPaymentWebhook(rawBody: string, signature: string): Promise<PaymentEvent> {
      if (paymentWebhookVerifier === undefined) {
        throw new Error('payment webhook ingestion requires a configured verifier');
      }
      // Verify the signature over the RAW body + normalize (throws on bad/stale/malformed).
      const event = paymentWebhookVerifier.verify(rawBody, signature);
      observe('payment.webhook', {
        outcome: event.type === 'charge.failed' ? 'error' : 'ok',
        ...(event.tenantRef !== undefined ? { tenantId: event.tenantRef } : {}),
        context: {
          provider: event.provider,
          eventId: event.id,
          type: event.type,
          rawType: event.rawType,
          occurredAt: event.occurredAt,
          ...(event.chargeId !== undefined ? { chargeId: event.chargeId } : {}),
          ...(event.amountMinor !== undefined ? { amountMinor: event.amountMinor } : {}),
          ...(event.currency !== undefined ? { currency: event.currency } : {}),
        },
      });
      return Promise.resolve(event);
    },

    paymentWebhookHistory(limit = 20): Promise<TenantEvent[]> {
      if (auditLog === undefined) return Promise.resolve([]);
      return auditLog.query({ events: ['payment.webhook'], limit });
    },

    async close(): Promise<void> {
      // Release any pg-backed pools the adapters own (audit store, credit ledger, signup tokens).
      await (auditLog as { close?: () => Promise<void> } | undefined)?.close?.();
      await (creditLedger as { close?: () => Promise<void> } | undefined)?.close?.();
      await (deps.signupTokenStore as { close?: () => Promise<void> } | undefined)?.close?.();
      await (deps.emailVerificationStore as { close?: () => Promise<void> } | undefined)?.close?.();
      await (deps.signupRequestStore as { close?: () => Promise<void> } | undefined)?.close?.();
      await (deps.signupQueue as { close?: () => Promise<void> } | undefined)?.close?.();
      await (
        deps.webhookSubscriptionStore as { close?: () => Promise<void> } | undefined
      )?.close?.();
      await registry.close();
    },
  };
}

/**
 * Build the erasure-certificate signer from config. With a configured Ed25519 key → a real signer
 * (fails fast on malformed key material). In a **non-production** context with no key → an
 * **ephemeral** keypair (a clear stderr warning is emitted; not verifiable across restarts).
 *
 * Production with no key fails closed **here, independently** of {@link loadConfig}'s validation
 * (defense in depth / complete mediation — the guard must not be action-at-a-distance). Exported so
 * the guard is directly testable against a `Config` that bypasses `loadConfig`/superRefine.
 *
 * @param config - Validated configuration.
 * @returns The certificate signer.
 * @throws Error if production has no key, or a configured key is malformed (startup fail-fast).
 */
export async function buildCertificateSigner(config: Config): Promise<CertificateSigner> {
  if (config.erasureSigningKey !== undefined) {
    return createEd25519CertificateSigner({ privateKey: config.erasureSigningKey });
  }
  // No key configured → the ephemeral-key path. `loadConfig`'s superRefine already rejects this in
  // production, but DO NOT rely on that action-at-a-distance: re-check locally so the guard holds for
  // ANY Config (a hand-built object, a future construction path, a test) that bypasses superRefine.
  // Complete mediation / fail closed (master §2) — an ephemeral signing key in prod is exactly the
  // always-signed-but-unverifiable failure this design forbids.
  if (config.env === 'production') {
    throw new Error(
      'refusing an ephemeral erasure-signing key in production: set TENANTFORGE_ERASURE_SIGNING_KEY',
    );
  }
  process.stderr.write(
    `[tenantforge] WARNING: TENANTFORGE_ERASURE_SIGNING_KEY is not set (TENANTFORGE_ENV=${config.env}). ` +
      `Generating an EPHEMERAL Ed25519 erasure-signing key for this process — NON-PRODUCTION ONLY. ` +
      `Certificates signed now are NOT verifiable across restarts. Set a real key for any persistent deployment.\n`,
  );
  return createEphemeralCertificateSigner();
}

/**
 * Build the compliance-report signer from config (ADR-0011 Phase 1). Mirrors
 * {@link buildCertificateSigner} discipline exactly: a configured Ed25519 key → a real signer (fails
 * fast on malformed material); a **non-production** context with no key → an **ephemeral** keypair
 * (stderr warning; not verifiable across restarts).
 *
 * Production with no key fails closed **here, independently** of {@link loadConfig}'s validation
 * (defense in depth / complete mediation — the guard must not be action-at-a-distance). Exported so
 * the guard is directly testable against a `Config` that bypasses `loadConfig`/superRefine.
 *
 * @param config - Validated configuration.
 * @returns The compliance-report signer.
 * @throws Error if production has no key, or a configured key is malformed (startup fail-fast).
 */
export async function buildComplianceReportSigner(config: Config): Promise<ComplianceReportSigner> {
  if (config.complianceSigningKey !== undefined) {
    return createEd25519ComplianceReportSigner({ privateKey: config.complianceSigningKey });
  }
  if (config.env === 'production') {
    throw new Error(
      'refusing an ephemeral compliance-signing key in production: set TENANTFORGE_COMPLIANCE_SIGNING_KEY',
    );
  }
  process.stderr.write(
    `[tenantforge] WARNING: TENANTFORGE_COMPLIANCE_SIGNING_KEY is not set (TENANTFORGE_ENV=${config.env}). ` +
      `Generating an EPHEMERAL Ed25519 compliance-signing key for this process — NON-PRODUCTION ONLY. ` +
      `Signed reports are NOT verifiable across restarts. Set a real key for any persistent deployment.\n`,
  );
  return createEphemeralComplianceReportSigner();
}

/**
 * Build the evidence-bundle signer from config (ADR-0011 Phase 2). **Reuses the compliance evidence
 * signing key** (`TENANTFORGE_COMPLIANCE_SIGNING_KEY`) — the bundle is part of the same evidence layer
 * as the signed report, distinguished only by a distinct `typ`/`kid`, so we add **no third prod key**
 * (the locked decision in ADR-0011). Mirrors {@link buildComplianceReportSigner} discipline exactly:
 * a configured key → a real signer (fails fast on malformed material); a **non-production** context
 * with no key → an **ephemeral** keypair (stderr warning; not verifiable across restarts).
 *
 * Production with no key fails closed **here, independently** of {@link loadConfig}'s validation
 * (defense in depth / complete mediation — not action-at-a-distance). Exported so the guard is
 * directly testable against a `Config` that bypasses `loadConfig`/superRefine.
 *
 * @param config - Validated configuration.
 * @returns The evidence-bundle signer.
 * @throws Error if production has no key, or a configured key is malformed (startup fail-fast).
 */
export async function buildEvidenceBundleSigner(config: Config): Promise<EvidenceBundleSigner> {
  if (config.complianceSigningKey !== undefined) {
    return createEd25519EvidenceBundleSigner({ privateKey: config.complianceSigningKey });
  }
  if (config.env === 'production') {
    throw new Error(
      'refusing an ephemeral evidence-bundle signing key in production: set TENANTFORGE_COMPLIANCE_SIGNING_KEY',
    );
  }
  process.stderr.write(
    `[tenantforge] WARNING: TENANTFORGE_COMPLIANCE_SIGNING_KEY is not set (TENANTFORGE_ENV=${config.env}). ` +
      `Generating an EPHEMERAL Ed25519 evidence-bundle signing key for this process — NON-PRODUCTION ONLY. ` +
      `Signed bundles are NOT verifiable across restarts. Set a real key for any persistent deployment.\n`,
  );
  return createEphemeralEvidenceBundleSigner();
}

/**
 * Build a {@link TenantForge} wired to the production adapters (Neon API + Postgres registry) from
 * validated configuration. This is the production composition root.
 *
 * @param config - Validated configuration (see {@link loadConfig}).
 * @param opts - Optional overrides; `eventSink` replaces the default JSON-to-stdout sink (e.g. a
 *   fan-out of JSON + a metrics sink at the composition root).
 * @returns A control-plane API backed by live adapters.
 */
export async function tenantForgeFromConfig(
  config: Config,
  opts?: { eventSink?: EventSink },
): Promise<TenantForge> {
  // Transport-security opt-outs (default false → TLS enforced everywhere). These are the documented
  // "leaky endpoint" escape hatches for local dev only (README §TLS, master §5).
  const allowInsecureDb = config.allowInsecureDb;
  const allowInsecureUrls = config.allowInsecureUrls;
  // Build the erasure-certificate signer up front so a bad key FAILS FAST at startup (not at erasure
  // time). Always-signed: a configured key → Ed25519 signer; in non-prod with no key → an EPHEMERAL
  // keypair (with a clear warning). Production with no key is already rejected by loadConfig.
  const certificateSigner = await buildCertificateSigner(config);
  // The compliance-report signer (ADR-0011) — same fail-fast discipline, distinct key/purpose.
  const complianceReportSigner = await buildComplianceReportSigner(config);
  // The evidence-bundle signer (ADR-0011 Phase 2) — reuses the SAME compliance evidence key (no third
  // prod key), distinct only by typ/kid. Same fail-fast discipline.
  const evidenceBundleSigner = await buildEvidenceBundleSigner(config);
  const registry = createPgTenantRegistry({
    connectionString: config.databaseUrl,
    allowInsecure: allowInsecureDb,
  });
  const provisioning = createNeonProvisioningProvider({
    apiKey: config.neonApiKey,
    orgId: config.neonOrgId,
    allowInsecure: allowInsecureUrls,
    ...(config.neonApiBaseUrl ? { baseUrl: config.neonApiBaseUrl } : {}),
    // Propagate the active trace to the upstream so a tenant operation is traceable across the
    // boundary into the Neon API (W3C trace context). No-op outside any request trace scope.
    traceHeaders: () => {
      const traceparent = outboundTraceparent();
      return traceparent === undefined ? {} : { [TRACEPARENT_HEADER]: traceparent };
    },
  });
  // Per-tenant connection secrets: the Neon-prioritized default is an AES-256-GCM-encrypted store in
  // the control-plane DB (encryption key separate from the DB credential — separation of duties).
  // `vault` selects the HashiCorp Vault backend instead; both satisfy the same SecretStore port.
  const secretStore =
    config.secretBackend === 'vault'
      ? createVaultSecretStore({
          address: config.vault!.address,
          token: config.vault!.token,
          mountPath: config.vault!.mount,
          pathPrefix: config.vault!.pathPrefix,
          allowInsecure: allowInsecureUrls,
          ...(config.vault!.namespace !== undefined ? { namespace: config.vault!.namespace } : {}),
        })
      : createNeonPgSecretStore({
          connectionString: config.databaseUrl,
          key: deriveKey(config.secretKey!),
          allowInsecure: allowInsecureDb,
        });
  // Offboard export: the Neon-prioritized default retains the project (scale-to-zero, no data
  // movement); `pg-dump` instead dumps the tenant DB to an object store (filesystem for now —
  // S3/GCS object stores follow behind the ObjectStore port). Both satisfy the TenantExporter port.
  const exporter =
    config.exporter === 'pg-dump'
      ? createPgDumpExporter({
          resolveConnectionUri: (tenant) => secretStore.get(tenant.id),
          objectStore: createFilesystemObjectStore({ dir: config.exportDir! }),
          dump: (uri) => spawnPgDump(uri, { allowInsecure: allowInsecureDb }),
        })
      : createNeonArchiveExporter();
  // Persisted audit trail (compliance evidence): when enabled, store events in Postgres and fan the
  // event stream out to it as well, so the compliance report can attest erasure history + a recent
  // excerpt. Disabled by default (the stdout JSON stream remains the only record).
  const baseSink = opts?.eventSink ?? createJsonEventSink();
  const auditLog =
    config.auditLog === 'pg'
      ? createPgAuditLogStore({
          connectionString: config.databaseUrl,
          allowInsecure: allowInsecureDb,
        })
      : undefined;
  // Managed webhook subscriptions (durable, cross-instance). The dispatch sink fans every event out
  // to each matching active subscription, signed with its own secret (loaded from the SecretStore).
  const webhookSubscriptionStore = createPgWebhookSubscriptionStore({
    connectionString: config.databaseUrl,
    allowInsecure: allowInsecureDb,
  });
  const subscriptionSink = createSubscriptionWebhookEventSink({
    store: webhookSubscriptionStore,
    secretStore,
    allowInsecureUrl: allowInsecureUrls,
    onError: (event, error) =>
      process.stderr.write(`webhook subscription delivery failed for ${event.event}: ${error}\n`),
  });
  const eventSink = createFanOutEventSink([
    baseSink,
    ...(auditLog !== undefined ? [createAuditLogEventSink(auditLog)] : []),
    subscriptionSink,
  ]);
  // Credit ledger: durable Postgres (authoritative) or process-local memory; absent = credit off.
  const creditLedger =
    config.creditLedger === 'pg'
      ? createPgCreditLedger({
          connectionString: config.databaseUrl,
          allowInsecure: allowInsecureDb,
        })
      : config.creditLedger === 'memory'
        ? createInMemoryCreditLedger()
        : undefined;
  const signupTokenStore =
    config.signupTokenStore === 'pg'
      ? createPgSignupTokenStore({
          connectionString: config.databaseUrl,
          allowInsecure: allowInsecureDb,
        })
      : config.signupTokenStore === 'memory'
        ? createInMemorySignupTokenStore()
        : undefined;
  // Self-serve signup (public, payment-gated). Wired only when enabled (a signup secret is set);
  // config validation guarantees Stripe + a captcha + a notifier are present. The lifecycle queue
  // producer enqueues the async `provision` command the worker then runs.
  const signupEnabled = config.signupSecret !== undefined;
  const usePgSignupStore = config.signupStore === 'pg';
  const paymentSetup = signupEnabled
    ? createStripeSetup({
        secretKey: config.stripeSecretKey!,
        allowInsecure: allowInsecureUrls,
        ...(config.stripeApiBaseUrl !== undefined ? { baseUrl: config.stripeApiBaseUrl } : {}),
      })
    : undefined;
  const captcha =
    signupEnabled && config.captcha.provider === 'turnstile'
      ? createTurnstileVerifier({ secretKey: config.captcha.secret! })
      : undefined;
  const emailVerificationStore = signupEnabled
    ? usePgSignupStore
      ? createPgEmailVerificationStore({
          connectionString: config.databaseUrl,
          allowInsecure: allowInsecureDb,
        })
      : createInMemoryEmailVerificationStore()
    : undefined;
  const signupRequestStore = signupEnabled
    ? usePgSignupStore
      ? createPgSignupRequestStore({
          connectionString: config.databaseUrl,
          allowInsecure: allowInsecureDb,
        })
      : createInMemorySignupRequestStore()
    : undefined;
  const signupQueue = signupEnabled
    ? createPgMessageQueue({ connectionString: config.databaseUrl, allowInsecure: allowInsecureDb })
    : undefined;
  return createTenantForge({
    registry,
    provisioning,
    secretStore,
    certificateSigner,
    complianceReportSigner,
    evidenceBundleSigner,
    migrationRunner: createPgMigrationRunner({ allowInsecure: allowInsecureDb }),
    exporter,
    eventSink,
    ...(creditLedger !== undefined ? { creditLedger } : {}),
    ...(signupTokenStore !== undefined ? { signupTokenStore } : {}),
    ...(paymentSetup !== undefined ? { paymentSetup } : {}),
    ...(captcha !== undefined ? { captcha } : {}),
    ...(emailVerificationStore !== undefined ? { emailVerificationStore } : {}),
    ...(signupRequestStore !== undefined ? { signupRequestStore } : {}),
    ...(signupQueue !== undefined ? { signupQueue } : {}),
    emailCodeTtlMs: config.emailCodeTtlMs,
    webhookSubscriptionStore,
    allowInsecureWebhookUrl: allowInsecureUrls,
    ...(auditLog !== undefined ? { auditLog } : {}),
    usageProvider: createNeonUsageProvider({
      apiKey: config.neonApiKey,
      orgId: config.neonOrgId,
      ...(config.neonApiBaseUrl ? { baseUrl: config.neonApiBaseUrl } : {}),
    }),
    defaultRegion: config.defaultRegion,
    allowedRegions: config.allowedRegions,
    retentionDays: config.retentionDays,
    connectionCacheTtlMs: config.connectionCacheTtlMs,
    // pg_dump → pg_restore mover so re-homing works out of the box (needs pg_dump/pg_restore on PATH).
    dataMover: createPgDataMover({
      dumpOptions: { allowInsecure: allowInsecureDb },
      restoreOptions: { allowInsecure: allowInsecureDb },
    }),
    // Neon-branch snapshots for scheduled backups (instant, copy-on-write restore points).
    snapshots: createNeonSnapshotProvider({
      apiKey: config.neonApiKey,
      allowInsecure: allowInsecureUrls,
      ...(config.neonApiBaseUrl ? { baseUrl: config.neonApiBaseUrl } : {}),
    }),
    // Unit cost rates for the per-tenant cost/margin report (empty = zero cost).
    ...(config.costRates !== undefined ? { costRates: config.costRates } : {}),
    ...(config.billingRates !== undefined ? { billingRates: config.billingRates } : {}),
    usageAlertThresholds: config.usageAlertThresholds,
    ...(config.plans !== undefined ? { plans: config.plans } : {}),
    // Payment gateway (PSP): wired only when explicitly configured (charging is money movement).
    // Stripe ships; swap in any other provider behind the PaymentGateway port at this seam.
    ...(config.paymentGateway === 'stripe'
      ? {
          paymentGateway: createStripeGateway({
            secretKey: config.stripeSecretKey!,
            allowInsecure: allowInsecureUrls,
            ...(config.stripeApiBaseUrl !== undefined ? { baseUrl: config.stripeApiBaseUrl } : {}),
          }),
        }
      : {}),
    // Inbound PSP webhook verifier — wired when a webhook signing secret is configured.
    ...(config.paymentGateway === 'stripe' && config.paymentWebhookSecret !== undefined
      ? {
          paymentWebhookVerifier: createStripeWebhookVerifier({
            signingSecret: config.paymentWebhookSecret,
          }),
        }
      : {}),
    // Billing-receipt notifier: `log` records an auditable receipt trail; `http` POSTs each receipt
    // to a relay (https). A successful charge/refund best-effort notifies metadata.billingEmail.
    ...(config.notifier === 'log'
      ? { notifier: createLogNotifier() }
      : config.notifier === 'http' && config.notifierHttp !== undefined
        ? {
            notifier: createHttpNotifier({
              url: config.notifierHttp.url,
              allowInsecure: allowInsecureUrls,
              ...(config.notifierHttp.secret !== undefined
                ? { secret: config.notifierHttp.secret }
                : {}),
            }),
          }
        : {}),
    ...(config.operatorEmail !== undefined ? { operatorEmail: config.operatorEmail } : {}),
    // Off-Neon archive tier (pg_dump → object store) — enabled when an export object store is
    // configured (TENANTFORGE_EXPORT_DIR); archives use the `archives/` key prefix. Retention is the
    // object store's lifecycle policy. Without it, archive() fails closed.
    ...(config.exportDir !== undefined
      ? {
          archiveExporter: createPgDumpExporter({
            resolveConnectionUri: (tenant) => secretStore.get(tenant.id),
            objectStore: createFilesystemObjectStore({ dir: config.exportDir }),
            dump: (uri) => spawnPgDump(uri, { allowInsecure: allowInsecureDb }),
            keyPrefix: 'archives',
          }),
        }
      : {}),
    // Self-serve portal step-up + erasure-undo stores. The step-up code store is in-memory (short-
    // lived second-factor codes; per-instance is acceptable). The pending-erasure store selects
    // `pg` (durable + cross-replica — the cancel/claim flips are atomic SQL conditional updates that
    // hold across replicas and survive restarts) or `memory` (default; single-instance correct).
    // `pg` is the operational prerequisite for flipping TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE on
    // in multi-replica / restart-sensitive production (ADR-0010 / threat-model B8w / red-team F2);
    // the destructive actions ship behind that feature flag (OFF by default) regardless.
    oneTimeCodeStore: createInMemoryOneTimeCodeStore(),
    pendingErasureStore:
      config.pendingErasureStore === 'pg'
        ? createPgPendingErasureStore({
            connectionString: config.databaseUrl,
            allowInsecure: allowInsecureDb,
          })
        : createInMemoryPendingErasureStore(),
    ...(config.stepUpCodeTtlMs !== undefined ? { stepUpCodeTtlMs: config.stepUpCodeTtlMs } : {}),
    ...(config.erasureUndoWindowMs !== undefined
      ? { erasureUndoWindowMs: config.erasureUndoWindowMs }
      : {}),
  });
}

/**
 * Build a {@link TenantForge} directly from the environment (convenience for entrypoints).
 *
 * @param env - The environment to read (defaults to `process.env`).
 * @returns A control-plane API backed by live adapters.
 */
export function tenantForgeFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<TenantForge> {
  return tenantForgeFromConfig(loadConfig(env));
}

/**
 * Build a handler that applies a queue-delivered {@link LifecycleCommand} to a {@link TenantForge}
 * (for the queue-driven lifecycle consumer). Maps each command to its lib operation; `purge` is not
 * a queue command, so the irreversible hard-delete is never triggered by a message.
 *
 * @param tf - The control-plane API.
 * @returns An async handler suitable for `createLifecycleConsumer({ handle })`.
 */
export function createLifecycleHandler(
  tf: TenantForge,
): (command: LifecycleCommand) => Promise<void> {
  return async (command: LifecycleCommand): Promise<void> => {
    switch (command.type) {
      case 'provision':
        await tf.provision({
          slug: command.slug,
          ...(command.region !== undefined ? { region: command.region } : {}),
          ...(command.residency !== undefined ? { residency: command.residency } : {}),
          ...(command.metadata !== undefined ? { metadata: command.metadata as JsonObject } : {}),
        });
        return;
      case 'suspend':
        await tf.suspend(command.tenantId);
        return;
      case 'resume':
        await tf.resume(command.tenantId);
        return;
      case 'offboard':
        await tf.offboard(command.tenantId);
        return;
    }
  };
}

export { loadConfig } from './config.js';
