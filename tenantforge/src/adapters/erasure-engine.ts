import { buildErasureCertificate, type ErasureCertificate } from '../core/erasure.js';
import { redactSecrets, type TenantEvent } from '../core/observability.js';
import type { ProvisioningProvider } from '../ports/provisioning-provider.js';
import type { SecretStore } from '../ports/secret-store.js';
import type { TenantExporter } from '../ports/tenant-exporter.js';
import type { TenantRegistry } from '../ports/tenant-registry.js';

/** Collaborators for {@link createErasureEngine} (ports injected at the composition root). */
export interface ErasureEngineDeps {
  /** Tenant registry (read the record, mark it deleted, verify the final status). */
  registry: TenantRegistry;
  /** Provisioning provider (delete the tenant's Neon project). */
  provisioning: ProvisioningProvider;
  /** Secret store (crypto-shred the connection secret, verify it is unreadable). */
  secretStore: SecretStore;
  /** Optional exporter for a final subject export before destruction. */
  exporter?: TenantExporter;
  /** Optional audit sink; the engine redacts context before emitting (master §5). */
  emit?: (event: TenantEvent) => void;
  /** Injectable clock (for a deterministic `erasedAt`). Defaults to `() => new Date()`. */
  now?: () => Date;
}

/** Options for {@link ErasureEngine.erase}. */
export interface EraseOptions {
  /** Audit reason (no secrets), e.g. a GDPR Art. 17 request reference. */
  reason: string;
  /**
   * Produce a final export for the subject before destruction. Defaults to **true when an exporter
   * is configured**. Setting it `true` without an exporter fails closed (the subject's data would be
   * destroyed without being returned).
   */
  export?: boolean;
}

/** Right-to-erasure engine (ARCHITECTURE #17). */
export interface ErasureEngine {
  /**
   * Erase a tenant: optional final export → delete the Neon project → crypto-shred the connection
   * secret → mark the record `deleted` → **verify** the post-conditions → return an auditable
   * certificate.
   *
   * @param tenantId - The tenant to erase.
   * @param options - The audit reason and export choice.
   * @returns The erasure certificate (inspect `verified`).
   */
  erase(tenantId: string, options: EraseOptions): Promise<ErasureCertificate>;
}

/**
 * Create an {@link ErasureEngine} — automated, audited right-to-erasure (GDPR Art. 17 / CCPA;
 * workflow-data-lifecycle), composing the existing ports. Unlike `purge` (which requires an
 * offboarded tenant), erasure is the **legal-override** path: it erases a tenant **from any state**,
 * then verifies and certifies the result.
 *
 * The control-plane registry holds **no tenant content** (only non-PII control metadata —
 * ARCHITECTURE §4), so erasing the personal data means destroying the tenant's Neon **project** and
 * its **connection secret**, then confirming the secret is unreadable and the record is `deleted`.
 * The returned {@link ErasureCertificate} is the audit evidence; its context is redacted before any
 * event is emitted, and it never contains secrets.
 *
 * Erasure is **destructive and runs the steps before verifying** — `erase` returns the certificate
 * rather than throwing on a failed post-condition (the data is already gone); a `verified === false`
 * certificate (emitted with `outcome: 'error'`) signals a remediation/investigation, not a retry of
 * destruction.
 *
 * @param deps - Registry, provisioning, secret store, and optional exporter / audit sink / clock.
 * @returns An erasure engine.
 */
export function createErasureEngine(deps: ErasureEngineDeps): ErasureEngine {
  const now = deps.now ?? ((): Date => new Date());

  return {
    async erase(tenantId: string, options: EraseOptions): Promise<ErasureCertificate> {
      const tenant = await deps.registry.getById(tenantId);
      if (tenant === null) {
        throw new Error(`erase: tenant not found: ${tenantId}`);
      }

      // 1. Optional final export for the subject (before destruction).
      let exported = false;
      let exportLocation: string | undefined;
      const wantExport = options.export ?? deps.exporter !== undefined;
      if (wantExport) {
        if (deps.exporter === undefined) {
          throw new Error('erase: export requested but no exporter is configured');
        }
        const result = await deps.exporter.exportTenant(tenant);
        exported = true;
        exportLocation = result.location;
      }

      // 2. Destroy the data: delete the project (if any) + crypto-shred the connection secret.
      let projectDeleted = false;
      if (tenant.neonProjectId !== null) {
        await deps.provisioning.deleteTenantProject(tenant.neonProjectId);
        projectDeleted = true;
      }
      await deps.secretStore.delete(tenantId);

      // 3. Mark the record deleted (erasure overrides the offboard-first rule of purge).
      await deps.registry.setStatus(tenantId, 'deleted');

      // 4. Verify the post-conditions.
      const secretShredded = (await deps.secretStore.get(tenantId)) === null;
      const after = await deps.registry.getById(tenantId);
      const statusDeleted = after?.status === 'deleted';

      const certificate = buildErasureCertificate({
        tenant,
        reason: options.reason,
        erasedAt: now().toISOString(),
        exported,
        ...(exportLocation !== undefined ? { exportLocation } : {}),
        projectDeleted,
        secretShredded,
        statusDeleted,
      });

      // 5. Audit (redacted; never throws on the sink). outcome reflects whether erasure is proven.
      deps.emit?.({
        event: 'tenant.erased',
        at: certificate.erasedAt,
        outcome: certificate.verified ? 'ok' : 'error',
        tenantId,
        context: redactSecrets({
          reason: options.reason,
          exported,
          projectDeleted,
          verified: certificate.verified,
        }),
      });

      return certificate;
    },
  };
}
