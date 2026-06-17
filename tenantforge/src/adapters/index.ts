/**
 * Adapters: concrete implementations of the ports, injected at a composition root (ARCHITECTURE §3).
 * Each is the imperative shell around the pure core and is integration-tested, not unit-covered.
 */
export {
  createNeonProvisioningProvider,
  type NeonProvisioningOptions,
} from './neon-api/provisioning-provider.js';
export { createPgTenantRegistry, type PgRegistryOptions } from './neon-pg/registry.js';
