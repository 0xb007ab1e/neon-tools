import type { TenantRecord } from './domain.js';

/**
 * Post-condition checks proving a tenant's data is gone after erasure.
 *
 * Erasure is provably complete only when both hold; the registry itself holds **no tenant content**
 * (only non-PII control metadata — ARCHITECTURE §4), so destroying the connection secret + the Neon
 * project, then confirming the secret is unreadable and the record is `deleted`, erases the personal
 * data (GDPR Art. 17 / CCPA).
 */
export interface ErasureVerification {
  /** The connection secret is gone (`SecretStore.get` returned null) — crypto-shredded. */
  secretShredded: boolean;
  /** The registry shows the tenant as `deleted`. */
  statusDeleted: boolean;
}

/** Inputs to {@link buildErasureCertificate}: the tenant plus the outcome of each erasure step. */
export interface ErasureSteps {
  /** The tenant as loaded before erasure (its id + slug are recorded on the certificate). */
  tenant: TenantRecord;
  /** Audit reason for the erasure (no secrets), e.g. a GDPR Art. 17 request reference. */
  reason: string;
  /** Completion instant (ISO-8601 UTC). */
  erasedAt: string;
  /** Whether a final export was produced for the subject before destruction. */
  exported: boolean;
  /** Reference to that export, when produced (a location, not the data itself). */
  exportLocation?: string;
  /** Whether the tenant's Neon project was deleted (false when it was never provisioned). */
  projectDeleted: boolean;
  /** Verification: the connection secret is unreadable. */
  secretShredded: boolean;
  /** Verification: the registry record is `deleted`. */
  statusDeleted: boolean;
}

/**
 * The auditable record of an erasure — what was attempted and whether it is provably complete
 * (GDPR Art. 17 / CCPA evidence; workflow-data-lifecycle). Returned by the ErasureEngine and safe to
 * persist/log (it contains no secrets — only references and booleans).
 */
export interface ErasureCertificate {
  /** The erased tenant's id. */
  tenantId: string;
  /** The erased tenant's slug (at erasure time). */
  slug: string;
  /** The recorded reason for erasure. */
  reason: string;
  /** Completion instant (ISO-8601 UTC). */
  erasedAt: string;
  /** Whether a final export was produced for the subject. */
  exported: boolean;
  /** Reference to that export, when produced. */
  exportLocation?: string;
  /** Whether the tenant's Neon project was deleted. */
  projectDeleted: boolean;
  /** The post-condition checks. */
  verification: ErasureVerification;
  /** True iff **every** post-condition holds — the erasure is provably complete. */
  verified: boolean;
}

/**
 * Build an {@link ErasureCertificate} from the recorded erasure steps + verification — the pure
 * decision for what counts as a *provably complete* erasure (data-handling critical path, master §4).
 * `verified` is the conjunction of the post-conditions; the orchestrator destroys the data, this
 * judges whether the destruction is confirmed.
 *
 * @param steps - The tenant, the audit reason, and each step's outcome + verification result.
 * @returns The erasure certificate.
 */
export function buildErasureCertificate(steps: ErasureSteps): ErasureCertificate {
  const verification: ErasureVerification = {
    secretShredded: steps.secretShredded,
    statusDeleted: steps.statusDeleted,
  };
  return {
    tenantId: steps.tenant.id,
    slug: steps.tenant.slug,
    reason: steps.reason,
    erasedAt: steps.erasedAt,
    exported: steps.exported,
    ...(steps.exportLocation !== undefined ? { exportLocation: steps.exportLocation } : {}),
    projectDeleted: steps.projectDeleted,
    verification,
    verified: verification.secretShredded && verification.statusDeleted,
  };
}
