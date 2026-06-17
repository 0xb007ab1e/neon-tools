import type { TenantRecord } from './domain.js';

/** The subset of a tenant record needed to decide routability. */
export type RoutableTenant = Pick<TenantRecord, 'id' | 'status' | 'neonProjectId'>;

/**
 * Assert that a tenant may receive live traffic and return its Neon project id.
 *
 * **Fails closed** (master §2): only `active` tenants with a provisioned project are routable.
 * A `provisioning` tenant has no project yet; `suspended` is deliberately disabled; `offboarding`
 * and `deleted` are being or have been torn down. The tenant id is derived server-side by the
 * caller — never from client input (BOLA — std-owasp-api).
 *
 * @param tenant - The tenant's id, status, and project id.
 * @returns The Neon project id to connect to.
 * @throws Error if the tenant is not active, or is active without a provisioned project.
 */
export function assertRoutable(tenant: RoutableTenant): string {
  if (tenant.status !== 'active') {
    throw new Error(`tenant ${tenant.id} is not routable (status: ${tenant.status})`);
  }
  if (tenant.neonProjectId === null) {
    throw new Error(`tenant ${tenant.id} is active but has no provisioned project`);
  }
  return tenant.neonProjectId;
}
