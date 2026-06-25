/**
 * Ports: the interfaces the pure core owns and depends on. Adapters implement these and are injected
 * at the composition root (ports & adapters / hexagonal — ARCHITECTURE §3).
 */
export type {
  ProvisioningProvider,
  ProvisionRequest,
  ProvisionResult,
} from './provisioning-provider.js';
export type { TenantRegistry, NewTenant } from './tenant-registry.js';
export type { TenantExporter, ExportResult } from './tenant-exporter.js';
export type { SecretStore } from './secret-store.js';
export type { CertificateSigner } from './certificate-signer.js';
export type { EventSink } from './event-sink.js';
export type { UsageProvider } from './usage-provider.js';
export type { MessageQueue, QueueMessage } from './message-queue.js';
export type { MigrationRunner, MigrationExecution } from './migration-runner.js';
export type { ConnectionRouter, TenantConnection } from './connection-router.js';
export type {
  OneTimeCodeStore,
  OneTimeCodeRecord,
  OneTimeCodeVerification,
} from './one-time-code-store.js';
export type {
  PendingErasureStore,
  PendingErasureRecord,
  PendingErasureStatus,
} from './pending-erasure-store.js';
export type { EvidenceStore, EvidencePutOptions } from './evidence-store.js';
