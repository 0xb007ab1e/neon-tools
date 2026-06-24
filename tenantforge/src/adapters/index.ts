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
export {
  createInMemoryOneTimeCodeStore,
  type InMemoryOneTimeCodeStore,
} from './one-time-code-store.js';
export type {
  OneTimeCodeStore,
  OneTimeCodeRecord,
  OneTimeCodeVerification,
} from '../ports/one-time-code-store.js';
export {
  createInMemoryPendingErasureStore,
  type InMemoryPendingErasureStore,
} from './pending-erasure-store.js';
export type {
  PendingErasureStore,
  PendingErasureRecord,
  PendingErasureStatus,
} from '../ports/pending-erasure-store.js';
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
// Notifiers (billing receipts) — `log`/`http` are env-selectable; SES/SMTP are hand-wired via
// createTenantForge with an injected client/transport (zero-dep, like the cloud secret stores).
export type { Notifier, Notification, NotificationResult } from '../ports/notifier.js';
export { createLogNotifier } from './notify/log-notifier.js';
export { createHttpNotifier, type HttpNotifierOptions } from './notify/http-notifier.js';
export {
  createSesNotifier,
  type SesNotifierOptions,
  type SesClientLike,
} from './notify/ses-notifier.js';
export {
  createSmtpNotifier,
  type SmtpNotifierOptions,
  type SmtpTransportLike,
} from './notify/smtp-notifier.js';
export {
  createAzureKeyVaultStore,
  type AzureKeyVaultStoreOptions,
} from './azure-key-vault/secret-store.js';
export { deriveKey, seal, open } from './secret-crypto.js';
export { createConnectionRouter, type ConnectionRouterDeps } from './connection-router.js';
export {
  createCachingConnectionRouter,
  type CachingConnectionRouter,
  type CachingConnectionRouterDeps,
} from './caching-connection-router.js';
export { createNeonArchiveExporter } from './neon-archive-exporter.js';
export {
  createPgDumpExporter,
  spawnPgDump,
  type PgDumpExporterDeps,
  type SpawnPgDumpOptions,
  type DumpFn,
} from './pg-dump/exporter.js';
export {
  createPgDataMover,
  spawnPgRestore,
  type PgDataMoverOptions,
  type SpawnPgRestoreOptions,
} from './pg-dump/data-mover.js';
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
export { createJsonEventSink, createNoopEventSink, createFanOutEventSink } from './event-sink.js';
export { createMetricsEventSink, type MetricsEventSink } from './metrics-event-sink.js';
export {
  createWebhookEventSink,
  type WebhookEventSink,
  type WebhookEventSinkOptions,
  type WebhookDeliveryOutcome,
} from './webhook-event-sink.js';
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
  createNatsMessageQueue,
  type NatsMessageQueue,
  type NatsMessageQueueOptions,
  type NatsClientLike,
  type NatsPulledMessage,
} from './nats/message-queue.js';
export {
  createLifecycleConsumer,
  type LifecycleConsumer,
  type LifecycleConsumerDeps,
  type ConsumeReport,
} from './lifecycle-consumer.js';
export {
  createErasureEngine,
  type ErasureEngine,
  type ErasureEngineDeps,
  type EraseOptions,
} from './erasure-engine.js';
export {
  createRehomeEngine,
  type RehomeEngine,
  type RehomeEngineDeps,
  type RehomeOptions,
  type RehomeResult,
} from './rehome-engine.js';
export {
  createSecretRotationEngine,
  type SecretRotationEngine,
  type SecretRotationEngineDeps,
  type RotationResult,
  type RotationSweepReport,
} from './secret-rotation-engine.js';
export type { TenantDataMover } from '../ports/tenant-data-mover.js';
export {
  createFleetOrchestrator,
  type FleetOrchestrator,
  type FleetOrchestratorDeps,
  type FleetMigrationSpec,
  type MigrateFleetOptions,
  type FleetMigrationReport,
  type TenantMigrationFailure,
} from './fleet-orchestrator.js';
