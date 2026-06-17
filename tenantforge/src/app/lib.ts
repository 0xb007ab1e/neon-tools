import {
  assertRegion,
  assertSlug,
  assertTransition,
  type JsonObject,
  type TenantRecord,
  type TenantStatus,
} from '../core/index.js';
import { createNeonProvisioningProvider } from '../adapters/neon-api/provisioning-provider.js';
import { createPgTenantRegistry } from '../adapters/neon-pg/registry.js';
import { createNeonPgSecretStore } from '../adapters/neon-pg/secret-store.js';
import { deriveKey } from '../adapters/secret-crypto.js';
import { createConnectionRouter } from '../adapters/connection-router.js';
import {
  createFleetOrchestrator,
  type FleetMigrationReport,
  type FleetMigrationSpec,
  type MigrateFleetOptions,
} from '../adapters/fleet-orchestrator.js';
import { createPgMigrationRunner } from '../adapters/neon-pg/migration-runner.js';
import type { ProvisioningProvider } from '../ports/provisioning-provider.js';
import type { TenantRegistry } from '../ports/tenant-registry.js';
import type { ExportResult, TenantExporter } from '../ports/tenant-exporter.js';
import type { SecretStore } from '../ports/secret-store.js';
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
   * Dedicated store for per-tenant connection secrets (keyed by tenant id). The connection URI is
   * stored here on provision and deleted on offboard — never persisted in the registry (master §5).
   */
  secretStore: SecretStore;
  /**
   * Exports a tenant's data before deletion on offboard. Optional, but offboarding fails closed
   * unless an exporter is present or export is explicitly skipped (privacy — export-then-delete).
   */
  exporter?: TenantExporter;
  /**
   * Applies a migration to one tenant database. Required only for {@link TenantForge.migrateFleet};
   * when absent, that method fails closed.
   */
  migrationRunner?: MigrationRunner;
}

/** Options for {@link TenantForge.offboard}. */
export interface OffboardInput {
  /**
   * Skip the export-before-delete step. Requires a `reason` and is only safe when the tenant holds
   * no exportable data (e.g. a never-activated tenant). Without it, offboarding needs an exporter.
   */
  skipExport?: boolean;
  /** Why export was skipped (recorded for audit). Required when `skipExport` is true. */
  reason?: string;
}

/** The result of offboarding a tenant. */
export interface OffboardOutcome {
  /** The tenant record (deleted). */
  tenant: TenantRecord;
  /** The export reference, or null when export was skipped. */
  export: ExportResult | null;
}

/** A request to provision a tenant. */
export interface ProvisionInput {
  /** Desired slug (validated + normalized). */
  slug: string;
  /** Region override; defaults to the configured default region. */
  region?: string;
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
   * Resume a suspended tenant back to active.
   *
   * @param id - The tenant id.
   * @returns The updated record.
   */
  resume(id: string): Promise<TenantRecord>;

  /**
   * Offboard a tenant: export its data, then **irreversibly** delete its Neon project, then mark it
   * deleted. Export precedes deletion (privacy); fails closed if export is required but unavailable.
   *
   * @param id - The tenant id.
   * @param input - Whether to skip export (with a reason).
   * @returns The deleted tenant record and the export reference (null if skipped).
   */
  offboard(id: string, input?: OffboardInput): Promise<OffboardOutcome>;

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
  const router = createConnectionRouter({ registry, secretStore });

  /** Load a tenant by id or throw (offboard/suspend operate on a known tenant). */
  const requireTenant = async (id: string): Promise<TenantRecord> => {
    const tenant = await registry.getById(id);
    if (!tenant) throw new Error(`tenant ${id} not found`);
    return tenant;
  };

  /** Validate + apply a status transition, returning the refreshed record. */
  const transition = async (tenant: TenantRecord, to: TenantStatus): Promise<TenantRecord> => {
    assertTransition(tenant.status, to);
    await registry.setStatus(tenant.id, to);
    const updated = await registry.getById(tenant.id);
    return updated ?? { ...tenant, status: to };
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

    async offboard(id: string, input: OffboardInput = {}): Promise<OffboardOutcome> {
      const tenant = await requireTenant(id);
      // Move into offboarding first (validates the transition; blocks routing).
      const offboarding = await transition(tenant, 'offboarding');

      // Export-then-delete (privacy). Fail closed if export is required but no exporter is wired.
      let exported: ExportResult | null = null;
      if (input.skipExport) {
        if (!input.reason) {
          throw new Error('offboard: skipExport requires a reason (recorded for audit)');
        }
      } else {
        if (!exporter) {
          throw new Error(
            'offboard: no exporter configured; pass { skipExport: true, reason } only if the tenant has no exportable data',
          );
        }
        exported = await exporter.exportTenant(offboarding);
      }

      // Irreversible: destroy the tenant's Neon project, crypto-shred its secret, then mark deleted.
      if (offboarding.neonProjectId !== null) {
        await provisioning.deleteTenantProject(offboarding.neonProjectId);
      }
      await secretStore.delete(offboarding.id);
      const deleted = await transition(offboarding, 'deleted');
      return { tenant: deleted, export: exported };
    },

    async getConnection(id: string): Promise<TenantConnection> {
      return router.resolve(id);
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
      return orchestrator.migrateFleet(spec, options);
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
  // Persistent, AES-256-GCM-encrypted secret store in the control-plane DB (the Neon-prioritized
  // production adapter). The encryption key is separate from the DB credential (separation of
  // duties). Vault / cloud-SM / fetch-from-Neon-API backends can be swapped in behind the port.
  const secretStore = createNeonPgSecretStore({
    connectionString: config.databaseUrl,
    key: deriveKey(config.secretKey),
  });
  return createTenantForge({
    registry,
    provisioning,
    secretStore,
    migrationRunner: createPgMigrationRunner(),
    defaultRegion: config.defaultRegion,
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

export { loadConfig } from './config.js';
