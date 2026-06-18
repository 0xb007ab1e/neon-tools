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
  retentionCutoff,
  type BillingPeriod,
  type Jurisdiction,
  type JsonObject,
  type TenantRecord,
  type TenantStatus,
  type TenantUsage,
} from '../core/index.js';
import { createNeonProvisioningProvider } from '../adapters/neon-api/provisioning-provider.js';
import { createPgTenantRegistry } from '../adapters/neon-pg/registry.js';
import { createNeonPgSecretStore } from '../adapters/neon-pg/secret-store.js';
import { createVaultSecretStore } from '../adapters/vault/secret-store.js';
import { deriveKey } from '../adapters/secret-crypto.js';
import { createConnectionRouter } from '../adapters/connection-router.js';
import { createNeonArchiveExporter } from '../adapters/neon-archive-exporter.js';
import { createJsonEventSink, createNoopEventSink } from '../adapters/event-sink.js';
import {
  createFleetOrchestrator,
  type FleetMigrationReport,
  type FleetMigrationSpec,
  type MigrateFleetOptions,
} from '../adapters/fleet-orchestrator.js';
import { createPgMigrationRunner } from '../adapters/neon-pg/migration-runner.js';
import { createNeonUsageProvider } from '../adapters/neon-api/usage-provider.js';
import type { LifecycleCommand } from '../adapters/lifecycle-command.js';
import type { ProvisioningProvider } from '../ports/provisioning-provider.js';
import type { TenantRegistry } from '../ports/tenant-registry.js';
import type { ExportResult, TenantExporter } from '../ports/tenant-exporter.js';
import type { SecretStore } from '../ports/secret-store.js';
import type { EventSink } from '../ports/event-sink.js';
import type { UsageProvider } from '../ports/usage-provider.js';
import type { MigrationRunner } from '../ports/migration-runner.js';
import type { TenantConnection } from '../ports/connection-router.js';
import { loadConfig, type Config } from './config.js';

export type { Config } from './config.js';
export type {
  FleetMigrationSpec,
  MigrateFleetOptions,
  FleetMigrationReport,
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
  /** Region override; defaults to the configured default region. */
  region?: string;
  /**
   * Required data-residency jurisdiction (e.g. `eu`). When set, the chosen region must belong to it
   * or provisioning fails closed (std-privacy).
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

/** The TenantForge control-plane API (library surface). */
export interface TenantForge {
  /** Apply the control-plane registry migrations idempotently. */
  migrate(): Promise<void>;

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
  listTenants(options?: { status?: TenantStatus; limit?: number }): Promise<TenantRecord[]>;

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
  const router = createConnectionRouter({ registry, secretStore });
  const eventSink = deps.eventSink ?? createNoopEventSink();

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
    eventSink.emit({
      event,
      at: new Date().toISOString(),
      outcome: fields.outcome,
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
    async migrate(): Promise<void> {
      await registry.migrate();
    },

    async provision(input: ProvisionInput): Promise<ProvisionOutcome> {
      const slug = assertSlug(input.slug);
      const region = assertRegion(input.region ?? defaultRegion);
      // Residency enforcement (std-privacy): the region must be on the org allow-list and satisfy
      // any required jurisdiction — both fail closed before any project is created.
      assertRegionAllowed(region, allowedRegions);
      if (input.residency !== undefined) {
        assertResidency(region, input.residency);
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

    async listTenants(options?: {
      status?: TenantStatus;
      limit?: number;
    }): Promise<TenantRecord[]> {
      return registry.list(options);
    },

    async close(): Promise<void> {
      await registry.close();
    },
  };
}

/**
 * Build a {@link TenantForge} wired to the production adapters (Neon API + Postgres registry) from
 * validated configuration. This is the production composition root.
 *
 * @param config - Validated configuration (see {@link loadConfig}).
 * @returns A control-plane API backed by live adapters.
 */
export function tenantForgeFromConfig(config: Config): TenantForge {
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
  return createTenantForge({
    registry,
    provisioning,
    secretStore,
    migrationRunner: createPgMigrationRunner(),
    exporter: createNeonArchiveExporter(),
    eventSink: createJsonEventSink(),
    usageProvider: createNeonUsageProvider({
      apiKey: config.neonApiKey,
      orgId: config.neonOrgId,
      ...(config.neonApiBaseUrl ? { baseUrl: config.neonApiBaseUrl } : {}),
    }),
    defaultRegion: config.defaultRegion,
    allowedRegions: config.allowedRegions,
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
