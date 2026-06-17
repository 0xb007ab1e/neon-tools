import { assertRoutable } from '../core/index.js';
import type { ConnectionRouter, TenantConnection } from '../ports/connection-router.js';
import type { SecretStore } from '../ports/secret-store.js';
import type { TenantRegistry } from '../ports/tenant-registry.js';

/** Collaborators for {@link createConnectionRouter}. */
export interface ConnectionRouterDeps {
  /** Source of tenant records (status drives routability). */
  registry: TenantRegistry;
  /** Source of the per-tenant connection secret (keyed by tenant id). */
  secretStore: SecretStore;
}

/**
 * Create a {@link ConnectionRouter} that resolves a tenant id to its connection, scoped to that
 * tenant's project.
 *
 * Fails closed at every step: the tenant must exist, be **routable** (active + provisioned — see
 * {@link assertRoutable}), and have a stored connection secret. The tenant id must be derived
 * server-side by the caller, never from client input (BOLA — std-owasp-api / topic-multi-tenancy).
 * The resolved URI is a secret and is never logged.
 *
 * @param deps - The registry and secret store.
 * @returns A connection router.
 */
export function createConnectionRouter(deps: ConnectionRouterDeps): ConnectionRouter {
  const { registry, secretStore } = deps;
  return {
    async resolve(tenantId: string): Promise<TenantConnection> {
      const tenant = await registry.getById(tenantId);
      if (!tenant) throw new Error(`tenant ${tenantId} not found`);
      assertRoutable(tenant); // throws (fail closed) for non-active / unprovisioned tenants
      const connectionUri = await secretStore.get(tenant.id);
      if (connectionUri === null) {
        throw new Error(`tenant ${tenantId} has no stored connection secret`);
      }
      return { tenantId: tenant.id, connectionUri };
    },
  };
}
