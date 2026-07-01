import type { TenantRecord } from '../core/domain.js';

/** The artifact produced by exporting a tenant's data before deletion. */
export interface ExportResult {
  /** Where the export was written (e.g. an object-store URI). A reference, not the data itself. */
  location: string;
  /** Size of the export in bytes, when known. */
  bytes?: number;
}

/**
 * Port: export a tenant's data before its database is destroyed.
 *
 * Offboarding is **export-then-delete** (privacy / data-lifecycle): the export must succeed before
 * the irreversible {@link import('./provisioning-provider.js').ProvisioningProvider.deleteTenantProject}
 * runs, so an erasure request still yields the tenant their data. Adapters:
 * {@link import('../adapters/pg-dump/exporter.js')} (logical `pg_dump`) and
 * {@link import('../adapters/neon-archive-exporter.js')}. Until an exporter is injected, offboarding
 * fails closed unless export is explicitly skipped with a recorded reason.
 */
export interface TenantExporter {
  /**
   * Export the tenant's data to durable storage and return a reference to it.
   *
   * @param tenant - The tenant being offboarded.
   * @returns A reference to the written export.
   */
  exportTenant(tenant: TenantRecord): Promise<ExportResult>;
}
