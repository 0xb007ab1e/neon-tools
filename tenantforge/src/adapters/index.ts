/**
 * Adapters: concrete implementations of the ports, injected at a composition root (ARCHITECTURE §3).
 * Each is the imperative shell around the pure core and is integration-tested, not unit-covered.
 */
export {
  createNeonProvisioningProvider,
  type NeonProvisioningOptions,
} from './neon-api/provisioning-provider.js';
export { createPgTenantRegistry, type PgRegistryOptions } from './neon-pg/registry.js';
export { createNeonUsageProvider, type NeonUsageOptions } from './neon-api/usage-provider.js';
export {
  createPgMigrationRunner,
  type PgMigrationRunnerOptions,
} from './neon-pg/migration-runner.js';
export { createInMemorySecretStore } from './secret-store.js';
export { createTokenAuthenticator } from './auth/token-authenticator.js';
export {
  createOidcAuthenticator,
  type OidcAuthenticatorOptions,
} from './auth/oidc-authenticator.js';
export type { Authenticator, Principal, HttpCredential, HttpRole } from '../ports/authenticator.js';
export { createInMemoryRateLimitStore } from './rate-limit-store.js';
export {
  createPgRateLimitStore,
  type PgRateLimitStore,
  type PgRateLimitStoreOptions,
} from './neon-pg/rate-limit-store.js';
export type { RateLimitStore, RateLimitHit } from '../ports/rate-limit-store.js';
export { createNeonPgSecretStore, type NeonPgSecretStoreOptions } from './neon-pg/secret-store.js';
export { createVaultSecretStore, type VaultSecretStoreOptions } from './vault/secret-store.js';
export {
  createAwsSecretsManagerStore,
  type AwsSecretsManagerStoreOptions,
  type SecretsManagerClientLike,
} from './aws-secrets-manager/secret-store.js';
export {
  createGcpSecretManagerStore,
  type GcpSecretManagerStoreOptions,
  type GcpSecretManagerClientLike,
} from './gcp-secret-manager/secret-store.js';
export {
  createAzureKeyVaultStore,
  type AzureKeyVaultStoreOptions,
} from './azure-key-vault/secret-store.js';
export { deriveKey, seal, open } from './secret-crypto.js';
export { createConnectionRouter, type ConnectionRouterDeps } from './connection-router.js';
export { createNeonArchiveExporter } from './neon-archive-exporter.js';
export {
  createPgDumpExporter,
  spawnPgDump,
  type PgDumpExporterDeps,
  type SpawnPgDumpOptions,
  type DumpFn,
} from './pg-dump/exporter.js';
export {
  createFilesystemObjectStore,
  type FilesystemObjectStoreOptions,
} from './object-store/filesystem.js';
export {
  createS3ObjectStore,
  type S3ObjectStoreOptions,
  type S3ClientLike,
} from './object-store/s3.js';
export {
  createGcsObjectStore,
  type GcsObjectStoreOptions,
  type GcsClientLike,
} from './object-store/gcs.js';
export {
  createAzureBlobObjectStore,
  type AzureBlobObjectStoreOptions,
  type AzureBlobClientLike,
} from './object-store/azure-blob.js';
export type { ObjectStore, PutResult } from '../ports/object-store.js';
export { createJsonEventSink, createNoopEventSink } from './event-sink.js';
export { parseLifecycleCommand, type LifecycleCommand } from './lifecycle-command.js';
export { createInMemoryQueue, type InMemoryQueue } from './in-memory-queue.js';
export {
  createPgMessageQueue,
  type PgMessageQueue,
  type PgMessageQueueOptions,
} from './neon-pg/message-queue.js';
export {
  createSqsMessageQueue,
  type SqsMessageQueue,
  type SqsMessageQueueOptions,
  type SqsClientLike,
} from './sqs/message-queue.js';
export {
  createPubSubMessageQueue,
  type PubSubMessageQueue,
  type PubSubMessageQueueOptions,
  type PubSubClientLike,
  type PubSubPulledMessage,
} from './pubsub/message-queue.js';
export {
  createLifecycleConsumer,
  type LifecycleConsumer,
  type LifecycleConsumerDeps,
  type ConsumeReport,
} from './lifecycle-consumer.js';
export {
  createFleetOrchestrator,
  type FleetOrchestrator,
  type FleetOrchestratorDeps,
  type FleetMigrationSpec,
  type MigrateFleetOptions,
  type FleetMigrationReport,
  type TenantMigrationFailure,
} from './fleet-orchestrator.js';
