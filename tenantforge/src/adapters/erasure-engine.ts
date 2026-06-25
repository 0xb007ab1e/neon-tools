import { buildErasureCertificate } from '../core/erasure.js';
import type { SignedErasureCertificate } from '../core/erasure-cert.js';
import { redactSecrets, type TenantEvent } from '../core/observability.js';
import type { CertificateSigner } from '../ports/certificate-signer.js';
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
  /**
   * Cryptographic signer for the erasure certificate (EdDSA/Ed25519 compact JWS). **Required** — an
   * erasure always produces a signed certificate (no unsigned path). The composition root validates
   * the signing key at startup and refuses to *schedule* an erasure without one, so by the time this
   * engine runs the signer is present and its key is sound.
   */
  signer: CertificateSigner;
  /** Optional exporter for a final subject export before destruction. */
  exporter?: TenantExporter;
  /** Optional audit sink; the engine redacts context before emitting (master §5). */
  emit?: (event: TenantEvent) => void;
  /**
   * Optional best-effort operator alert. Invoked (and its own errors swallowed) only in the rare
   * **fail-soft** case where signing throws *after* the irreversible erasure already completed — the
   * data is gone, so we record the certificate **unsigned** and alert rather than roll back.
   */
  alertOperator?: (message: string) => void | Promise<void>;
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
   * secret → mark the record `deleted` → **verify** the post-conditions → **cryptographically sign**
   * the certificate → return the signed result.
   *
   * @param tenantId - The tenant to erase.
   * @param options - The audit reason and export choice.
   * @returns The signed erasure certificate (inspect `.certificate.verified`; `.jws` is the EdDSA
   *   compact JWS — present on every path except the rare post-erasure signing-failure fail-soft).
   */
  erase(tenantId: string, options: EraseOptions): Promise<SignedErasureCertificate>;
}

/**
 * Create an {@link ErasureEngine} — automated, audited right-to-erasure (GDPR Art. 17 / CCPA;
 * workflow-data-lifecycle), composing the existing ports. Unlike `purge` (which requires an
 * offboarded tenant), erasure is the **legal-override** path: it erases a tenant **from any state**,
 * then verifies, **signs**, and certifies the result.
 *
 * The control-plane registry holds **no tenant content** (only non-PII control metadata —
 * ARCHITECTURE §4), so erasing the personal data means destroying the tenant's Neon **project** and
 * its **connection secret**, then confirming the secret is unreadable and the record is `deleted`.
 * The returned {@link SignedErasureCertificate} is the audit evidence: the certificate never
 * contains secrets, and its `.jws` is an **EdDSA/Ed25519 compact JWS** an auditor/data-subject can
 * verify with `verifyErasureCertificate` against the operator's published public JWK (std-owasp #8).
 *
 * Erasure is **destructive and runs the steps before verifying/signing** — `erase` returns the
 * certificate rather than throwing on a failed post-condition (the data is already gone); a
 * `verified === false` certificate (emitted with `outcome: 'error'`) signals a remediation, not a
 * retry of destruction. Likewise, if **signing** throws after the destruction completed, the engine
 * **fails soft**: it records the certificate **unsigned** (`.jws` absent), emits an error event +
 * an operator alert, and never rolls back (the data cannot be un-erased). The signing key is
 * validated at startup, so this path is rare.
 *
 * @param deps - Registry, provisioning, secret store, signer, and optional exporter / sink / clock.
 * @returns An erasure engine.
 */
export function createErasureEngine(deps: ErasureEngineDeps): ErasureEngine {
  const now = deps.now ?? ((): Date => new Date());

  return {
    async erase(tenantId: string, options: EraseOptions): Promise<SignedErasureCertificate> {
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

      // 5. Sign the certificate. The destruction (steps 2–3) is already done and irreversible, so a
      // signing failure here must NOT roll back — fail soft: record the certificate unsigned, emit
      // an error, and alert the operator (the key was validated at startup, so this is rare).
      let jws: string | undefined;
      let signError: string | undefined;
      try {
        jws = await deps.signer.sign(certificate);
      } catch (error) {
        signError = error instanceof Error ? error.message : String(error);
        // Best-effort operator alert; never let the alert (or its failure) affect the result.
        try {
          await deps.alertOperator?.(
            `Erasure certificate signing FAILED for tenant ${tenantId} after the data was already ` +
              `erased — the certificate is recorded UNSIGNED and is not independently verifiable. ` +
              `Investigate the signing key. (${signError})`,
          );
        } catch {
          // swallow — alerting must never throw on the completed erasure path
        }
      }

      // 6. Audit (redacted; never throws on the sink). `outcome` reflects whether erasure is proven
      // AND signed; a missing signature degrades the outcome to `error` so it's investigated.
      deps.emit?.({
        event: 'tenant.erased',
        at: certificate.erasedAt,
        outcome: certificate.verified && jws !== undefined ? 'ok' : 'error',
        tenantId,
        context: redactSecrets({
          reason: options.reason,
          exported,
          projectDeleted,
          verified: certificate.verified,
          signed: jws !== undefined,
          ...(signError !== undefined ? { signError } : {}),
        }),
      });

      return jws !== undefined ? { certificate, jws } : { certificate };
    },
  };
}
