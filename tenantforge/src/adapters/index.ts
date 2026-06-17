/**
 * Adapters: concrete implementations of the ports, injected at a composition root (ARCHITECTURE §3).
 * Each is the imperative shell around the pure core and is integration-tested, not unit-covered.
 */
export {
  createNeonProvisioningProvider,
  type NeonProvisioningOptions,
} from './neon-api/provisioning-provider.js';
export { createPgTenantRegistry, type PgRegistryOptions } from './neon-pg/registry.js';
export {
  createPgMigrationRunner,
  type PgMigrationRunnerOptions,
} from './neon-pg/migration-runner.js';
export { createInMemorySecretStore } from './secret-store.js';
export { createNeonPgSecretStore, type NeonPgSecretStoreOptions } from './neon-pg/secret-store.js';
export { deriveKey, seal, open } from './secret-crypto.js';
export { createConnectionRouter, type ConnectionRouterDeps } from './connection-router.js';
export { createNeonArchiveExporter } from './neon-archive-exporter.js';
export { createJsonEventSink, createNoopEventSink } from './event-sink.js';
export {
  createFleetOrchestrator,
  type FleetOrchestrator,
  type FleetOrchestratorDeps,
  type FleetMigrationSpec,
  type MigrateFleetOptions,
  type FleetMigrationReport,
  type TenantMigrationFailure,
} from './fleet-orchestrator.js';
