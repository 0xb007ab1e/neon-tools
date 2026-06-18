import { assertRehomeTarget } from '../core/residency-router.js';
import { redactSecrets, type TenantEvent } from '../core/observability.js';
import type { Jurisdiction } from '../core/residency.js';
import type { ProvisioningProvider } from '../ports/provisioning-provider.js';
import type { SecretStore } from '../ports/secret-store.js';
import type { TenantDataMover } from '../ports/tenant-data-mover.js';
import type { TenantRegistry } from '../ports/tenant-registry.js';

/** Collaborators for {@link createRehomeEngine}. */
export interface RehomeEngineDeps {
  /** Tenant registry (read the record, relocate it). */
  registry: TenantRegistry;
  /** Provisioning provider (create the new project, delete the old). */
  provisioning: ProvisioningProvider;
  /** Secret store (read the source URI, re-key to the new project). */
  secretStore: SecretStore;
  /** Copies the tenant's data from the old project to the new one. */
  dataMover: TenantDataMover;
  /** Allow-listed regions (residency enforcement). Empty/omitted = all known regions. */
  allowedRegions?: readonly string[];
  /** Optional audit sink; context is redacted before emit. */
  emit?: (event: TenantEvent) => void;
  /** Injectable clock. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/** Options for {@link RehomeEngine.rehome}. */
export interface RehomeOptions {
  /** The target region to move the tenant to. */
  region: string;
  /** Required jurisdiction the target region must satisfy (optional). */
  residency?: Jurisdiction;
}

/** The outcome of re-homing a tenant. */
export interface RehomeResult {
  /** The tenant id. */
  tenantId: string;
  /** Region the tenant moved from. */
  fromRegion: string;
  /** Region the tenant moved to. */
  toRegion: string;
  /** Whether the old project was deleted (best-effort; false ⇒ an orphan to clean up). */
  oldProjectDeleted: boolean;
}

/** Re-homes a provisioned tenant to a new region (#5). */
export interface RehomeEngine {
  /**
   * Move an **active** tenant to a new region: provision a new project there, copy the data, switch
   * the registry + connection secret over, then decommission the old project.
   *
   * @param tenantId - The tenant to relocate.
   * @param options - The target region + optional required jurisdiction.
   * @returns The re-home result.
   */
  rehome(tenantId: string, options: RehomeOptions): Promise<RehomeResult>;
}

/**
 * Create a {@link RehomeEngine} that relocates a provisioned tenant to a new region — for a residency
 * change (e.g. a customer moves to the EU) or latency optimization. A Neon project is region-bound,
 * so re-homing means **provision-new → copy → swap → delete-old**, composing the existing ports
 * (data movement is delegated to an injected {@link TenantDataMover}).
 *
 * **Fail closed / never lose data:** the target region is validated first (allow-list + jurisdiction,
 * and must differ from the current — `assertRehomeTarget`); the new project is created and the data
 * copied **before** anything is switched; a copy failure deletes the freshly-created target and
 * leaves the source untouched. Only after the registry + secret point at the new project is the old
 * project deleted (best-effort — a delete failure leaves a tracked orphan, not data loss). The
 * connection URIs are secrets and are never logged.
 *
 * @param deps - Registry, provisioning, secret store, data mover, and optional allow-list / audit / clock.
 * @returns A re-home engine.
 */
export function createRehomeEngine(deps: RehomeEngineDeps): RehomeEngine {
  const now = deps.now ?? ((): Date => new Date());
  const allowed = deps.allowedRegions ?? [];

  return {
    async rehome(tenantId: string, options: RehomeOptions): Promise<RehomeResult> {
      const tenant = await deps.registry.getById(tenantId);
      if (tenant === null) throw new Error(`rehome: tenant not found: ${tenantId}`);
      if (tenant.status !== 'active' || tenant.neonProjectId === null) {
        throw new Error(`rehome: tenant ${tenantId} must be active and provisioned`);
      }
      // Validate the target (allow-list + jurisdiction + differs from current) before touching anything.
      assertRehomeTarget(tenant.region, options.region, {
        allowed,
        ...(options.residency !== undefined ? { jurisdiction: options.residency } : {}),
      });

      const fromUri = await deps.secretStore.get(tenantId);
      if (fromUri === null) throw new Error(`rehome: no connection secret for tenant ${tenantId}`);
      const oldProjectId = tenant.neonProjectId;

      // 1. Provision the new project + 2. copy the data — both before any switch-over.
      const created = await deps.provisioning.createTenantProject({
        slug: tenant.slug,
        region: options.region,
      });
      try {
        await deps.dataMover.move({ from: fromUri, to: created.connectionUri });
      } catch (error) {
        // Roll back the half-built target; the source tenant is untouched.
        await deps.provisioning.deleteTenantProject(created.neonProjectId);
        throw error;
      }

      // 3. Switch the registry + connection secret to the new project.
      await deps.registry.relocate(tenantId, options.region, created.neonProjectId);
      await deps.secretStore.set(tenantId, created.connectionUri);

      // 4. Decommission the old project (best-effort — data already lives on the new one).
      let oldProjectDeleted = true;
      try {
        await deps.provisioning.deleteTenantProject(oldProjectId);
      } catch {
        oldProjectDeleted = false;
      }

      deps.emit?.({
        event: 'tenant.rehomed',
        at: now().toISOString(),
        outcome: oldProjectDeleted ? 'ok' : 'error',
        tenantId,
        context: redactSecrets({
          fromRegion: tenant.region,
          toRegion: options.region,
          oldProjectDeleted,
        }),
      });

      return {
        tenantId,
        fromRegion: tenant.region,
        toRegion: options.region,
        oldProjectDeleted,
      };
    },
  };
}
