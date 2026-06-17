import type { TenantRecord } from '../core/index.js';
import type { ExportResult, TenantExporter } from '../ports/tenant-exporter.js';

/**
 * Create a {@link TenantExporter} that "archives" a tenant by **retaining its Neon project**.
 *
 * The Neon-prioritized archive strategy (chosen over a `pg_dump`-to-blob export): on offboard the
 * project is not deleted — it is left in place, where Neon auto scales-to-zero (≈ $0 idle) and
 * remains fully restorable during the retention window. A later {@link import('./index.js')} purge
 * performs the irreversible hard-delete. This adapter just produces the durable reference (the
 * project); no API call is needed since retention is the default of not-deleting.
 *
 * A `pg_dump`-to-object-store (S3/GCS/R2) exporter can be added behind the same port in its own
 * branch when off-Neon durability is required.
 *
 * @returns A retain-the-project archiver.
 */
export function createNeonArchiveExporter(): TenantExporter {
  return {
    exportTenant(tenant: TenantRecord): Promise<ExportResult> {
      if (tenant.neonProjectId === null) {
        // Never provisioned — nothing to retain.
        return Promise.resolve({ location: 'none:unprovisioned' });
      }
      return Promise.resolve({ location: `neon-project:${tenant.neonProjectId}` });
    },
  };
}
