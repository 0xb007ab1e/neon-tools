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
  invoiceChargeAmount,
  chargeIdempotencyKey,
  type TenantEvent,
  retentionCutoff,
  selectRegion,
  buildComplianceReport,
  type ComplianceReport,
  type ComplianceReportOptions,
  type BillingPeriod,
  type Jurisdiction,
  type JsonObject,
  type TenantRecord,
  type TenantStatus,
  type TenantUsage,
  type ErasureCertificate,
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
import { createErasureEngine, type EraseOptions } from '../adapters/erasure-engine.js';
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
import type { ChargeResult, PaymentGateway } from '../ports/payment-gateway.js';
import { createStripeGateway } from '../adapters/payment/stripe-gateway.js';
import type { UsageProvider } from '../ports/usage-provider.js';
import type { MigrationRunner } from '../ports/migration-runner.js';
import type { TenantConnection } from '../ports/connection-router.js';
import { createHash } from 'node:crypto';
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

export type { ChargeRequest, ChargeResult, PaymentGateway } from '../ports/payment-gateway.js';
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
   * Payment gateway (PSP) for {@link TenantForge.chargeInvoice}. Optional and swappable behind the
   * {@link PaymentGateway} port (Stripe ships; others plug in the same way). Absent ⇒ charging fails
   * closed. Charging is a money-moving outward action — never auto-wired without explicit config.
   */
  paymentGateway?: PaymentGateway;
  /**
   * Persisted audit trail. When provided, {@link TenantForge.complianceReport} includes erasure
   * history + a recent audit excerpt; absent = the report omits the `audit` section. (Wire the
   * matching {@link createAuditLogEventSink} into the event sink so the trail is populated.)
   */
  auditLog?: AuditLogStore;
}

/** Default retention window (days) an archived tenant is kept before {@link TenantForge.purgeExpired}. */
const DEFAULT_RETENTION_DAYS = 30;
/** Upper bound on offboarding tenants scanned per sweep. */
const MAX_SWEEP = 100_000;

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
   * Resume a tenant back to active — from `suspended`, or restoring an `offboarding` (archived)
   * tenant during its retention window (the Neon project and connection secret were retained).
   *
   * @param id - The tenant id.
   * @returns The updated record.
   */
  resume(id: string): Promise<TenantRecord>;

  /**
   * Offboard a tenant: stop serving and **archive** it — the Neon project is retained (scaled to
   * zero ≈ $0 idle) for the retention window, not deleted. **Reversible** via {@link TenantForge.resume}
   * until {@link TenantForge.purge}. This honors export-then-delete by keeping the data recoverable
   * during retention (`@rules/workflow-data-lifecycle.md`).
   *
   * @param id - The tenant id.
   * @returns The tenant record (`offboarding`) and a reference to the retained archive.
   */
  offboard(id: string): Promise<OffboardOutcome>;

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
   * Erase a tenant under a right-to-erasure request (GDPR Art. 17 / CCPA — ErasureEngine #17): an
   * optional final export, then delete the project, crypto-shred the secret, mark `deleted`, verify,
   * and return an auditable {@link ErasureCertificate}. Unlike {@link TenantForge.purge}, erasure is
   * the legal-override path — it applies from **any** state, not just an offboarded tenant. Inspect
   * the certificate's `verified` flag; a `false` is a remediation signal (the data is already gone).
   *
   * @param id - The tenant to erase.
   * @param options - The audit reason and export choice.
   * @returns The erasure certificate.
   */
  erase(id: string, options: EraseOptions): Promise<ErasureCertificate>;

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
   * Generate a point-in-time **compliance report** over the fleet — physical-isolation and
   * data-residency attestations derived from the registry — with a SHA-256 integrity digest. Emits
   * *evidence* (queryable facts), not a legal certification.
   *
   * @returns The report and its digest.
   */
  complianceReport(): Promise<ComplianceReportResult>;

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
    eventSink.emit({
      event,
      at: new Date().toISOString(),
      outcome: fields.outcome,
      ...(actor !== undefined ? { actor } : {}),
      ...(fields.tenantId !== undefined ? { tenantId: fields.tenantId } : {}),
      ...(fields.durationMs !== undefined ? { durationMs: fields.durationMs } : {}),
      ...(fields.context !== undefined ? { context: redactSecrets(fields.context) } : {}),
      ...(fields.error !== undefined ? { error: fields.error } : {}),
    });
  };

  /** Load a tenant by id or throw (offboard/suspend operate on a known tenant). */
  const requireTenant = async (id: string): Promise<TenantRecord> => {
    const tenant = await registry.getById(id);
    if (!tenant) throw new Error(`tenant ${id} not found`);
    return tenant;
  };

  /** Read a tenant's PSP customer reference from metadata, if present + non-empty. */
  const billingCustomerRef = (metadata: JsonObject): string | undefined => {
    const v = metadata['billingCustomerRef'];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
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
  ): Promise<ChargeResult> => {
    const invoice = await invoiceEngine().invoice(id, period);
    const { amountMinor, currency } = invoiceChargeAmount(invoice); // throws if not positive
    try {
      const result = await paymentGateway!.charge({
        amountMinor,
        currency,
        customerRef,
        idempotencyKey: chargeIdempotencyKey(invoice),
        description: `TenantForge ${id} ${invoice.periodStart}..${invoice.periodEnd}`,
      });
      observe('tenant.charged', {
        tenantId: id,
        outcome: 'ok',
        context: {
          provider: result.provider,
          chargeId: result.id,
          amountMinor,
          currency,
          status: result.status,
        },
      });
      return result;
    } catch (error) {
      observe('tenant.charged', {
        tenantId: id,
        outcome: 'error',
        context: { amountMinor, currency },
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
      // Residency enforcement (std-privacy), fail closed before any project is created:
      // - explicit region → validate it's known, allow-listed, and satisfies any required jurisdiction;
      // - region omitted + residency required → the ResidencyRouter (#16) *selects* a compliant region
      //   from the allow-list (preferring the default when it qualifies);
      // - neither → the configured default, still allow-list-checked.
      let region: string;
      if (input.region !== undefined) {
        region = assertRegion(input.region);
        assertRegionAllowed(region, allowedRegions);
        if (input.residency !== undefined) {
          assertResidency(region, input.residency);
        }
      } else if (input.residency !== undefined) {
        region = selectRegion({
          jurisdiction: input.residency,
          allowed: allowedRegions,
          preferred: defaultRegion,
        });
      } else {
        region = assertRegion(defaultRegion);
        assertRegionAllowed(region, allowedRegions);
      }

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

    async getTenant(id: string): Promise<TenantRecord | null> {
      return registry.getById(id);
    },

    async suspend(id: string): Promise<TenantRecord> {
      const tenant = await requireTenant(id);
      return transition(tenant, 'suspended');
    },

    async resume(id: string): Promise<TenantRecord> {
      const tenant = await requireTenant(id);
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

    async purge(id: string): Promise<TenantRecord> {
      return purgeTenant(await requireTenant(id));
    },

    async erase(id: string, options: EraseOptions): Promise<ErasureCertificate> {
      // Compose the ErasureEngine over the already-injected ports; audit through the same sink.
      const engine = createErasureEngine({
        registry,
        provisioning,
        secretStore,
        ...(exporter ? { exporter } : {}),
        emit: (event) => eventSink.emit(event),
      });
      const certificate = await engine.erase(id, options);
      // The engine sets status directly (bypassing `transition`) — drop any cached resolution.
      invalidateConnection(id);
      return certificate;
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
      const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
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
      // Read-only (no applies) — a placeholder runner suffices when none is wired.
      const orchestrator = createFleetOrchestrator({
        registry,
        connectionRouter: router,
        migrationRunner: migrationRunner ?? {
          applyToTenant: () =>
            Promise.reject(new Error('reconcilePlan: no migration runner is configured')),
        },
      });
      return orchestrator.reconcilePlan(options);
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

    async listTenants(options?: {
      status?: TenantStatus;
      limit?: number;
      cursor?: { createdAt: Date; id: string };
    }): Promise<TenantRecord[]> {
      return registry.list(options);
    },

    async complianceReport(): Promise<ComplianceReportResult> {
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
    },

    costReport(period: BillingPeriod): Promise<CostReport> {
      assertPeriod(period);
      return costEngine().report(period);
    },

    async invoice(id: string, period: BillingPeriod): Promise<Invoice> {
      assertPeriod(period);
      return invoiceEngine().invoice(id, period);
    },

    async invoiceFleet(period: BillingPeriod): Promise<FleetInvoiceReport> {
      assertPeriod(period);
      return invoiceEngine().invoiceFleet(period);
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
    },

    chargeHistory(limit = 20): Promise<TenantEvent[]> {
      if (auditLog === undefined) return Promise.resolve([]);
      return auditLog.query({ events: ['tenant.charged'], limit });
    },

    async close(): Promise<void> {
      // Release the audit store's own pool (the pg adapter owns one) before the registry.
      await (auditLog as { close?: () => Promise<void> } | undefined)?.close?.();
      await registry.close();
    },
  };
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
export function tenantForgeFromConfig(
  config: Config,
  opts?: { eventSink?: EventSink },
): TenantForge {
  const registry = createPgTenantRegistry({ connectionString: config.databaseUrl });
  const provisioning = createNeonProvisioningProvider({
    apiKey: config.neonApiKey,
    orgId: config.neonOrgId,
    ...(config.neonApiBaseUrl ? { baseUrl: config.neonApiBaseUrl } : {}),
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
          ...(config.vault!.namespace !== undefined ? { namespace: config.vault!.namespace } : {}),
        })
      : createNeonPgSecretStore({
          connectionString: config.databaseUrl,
          key: deriveKey(config.secretKey!),
        });
  // Offboard export: the Neon-prioritized default retains the project (scale-to-zero, no data
  // movement); `pg-dump` instead dumps the tenant DB to an object store (filesystem for now —
  // S3/GCS object stores follow behind the ObjectStore port). Both satisfy the TenantExporter port.
  const exporter =
    config.exporter === 'pg-dump'
      ? createPgDumpExporter({
          resolveConnectionUri: (tenant) => secretStore.get(tenant.id),
          objectStore: createFilesystemObjectStore({ dir: config.exportDir! }),
          dump: (uri) => spawnPgDump(uri),
        })
      : createNeonArchiveExporter();
  // Persisted audit trail (compliance evidence): when enabled, store events in Postgres and fan the
  // event stream out to it as well, so the compliance report can attest erasure history + a recent
  // excerpt. Disabled by default (the stdout JSON stream remains the only record).
  const baseSink = opts?.eventSink ?? createJsonEventSink();
  const auditLog =
    config.auditLog === 'pg'
      ? createPgAuditLogStore({ connectionString: config.databaseUrl })
      : undefined;
  const eventSink =
    auditLog !== undefined
      ? createFanOutEventSink([baseSink, createAuditLogEventSink(auditLog)])
      : baseSink;
  return createTenantForge({
    registry,
    provisioning,
    secretStore,
    migrationRunner: createPgMigrationRunner(),
    exporter,
    eventSink,
    ...(auditLog !== undefined ? { auditLog } : {}),
    usageProvider: createNeonUsageProvider({
      apiKey: config.neonApiKey,
      orgId: config.neonOrgId,
      ...(config.neonApiBaseUrl ? { baseUrl: config.neonApiBaseUrl } : {}),
    }),
    defaultRegion: config.defaultRegion,
    allowedRegions: config.allowedRegions,
    connectionCacheTtlMs: config.connectionCacheTtlMs,
    // pg_dump → pg_restore mover so re-homing works out of the box (needs pg_dump/pg_restore on PATH).
    dataMover: createPgDataMover(),
    // Neon-branch snapshots for scheduled backups (instant, copy-on-write restore points).
    snapshots: createNeonSnapshotProvider({
      apiKey: config.neonApiKey,
      ...(config.neonApiBaseUrl ? { baseUrl: config.neonApiBaseUrl } : {}),
    }),
    // Unit cost rates for the per-tenant cost/margin report (empty = zero cost).
    ...(config.costRates !== undefined ? { costRates: config.costRates } : {}),
    ...(config.billingRates !== undefined ? { billingRates: config.billingRates } : {}),
    // Payment gateway (PSP): wired only when explicitly configured (charging is money movement).
    // Stripe ships; swap in any other provider behind the PaymentGateway port at this seam.
    ...(config.paymentGateway === 'stripe'
      ? {
          paymentGateway: createStripeGateway({
            secretKey: config.stripeSecretKey!,
            ...(config.stripeApiBaseUrl !== undefined ? { baseUrl: config.stripeApiBaseUrl } : {}),
          }),
        }
      : {}),
    // Off-Neon archive tier (pg_dump → object store) — enabled when an export object store is
    // configured (TENANTFORGE_EXPORT_DIR); archives use the `archives/` key prefix. Retention is the
    // object store's lifecycle policy. Without it, archive() fails closed.
    ...(config.exportDir !== undefined
      ? {
          archiveExporter: createPgDumpExporter({
            resolveConnectionUri: (tenant) => secretStore.get(tenant.id),
            objectStore: createFilesystemObjectStore({ dir: config.exportDir }),
            dump: (uri) => spawnPgDump(uri),
            keyPrefix: 'archives',
          }),
        }
      : {}),
  });
}

/**
 * Build a {@link TenantForge} directly from the environment (convenience for entrypoints).
 *
 * @param env - The environment to read (defaults to `process.env`).
 * @returns A control-plane API backed by live adapters.
 */
export function tenantForgeFromEnv(env: NodeJS.ProcessEnv = process.env): TenantForge {
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
