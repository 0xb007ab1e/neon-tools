import type { JWK } from 'jose';
import type { ComplianceReport } from '../core/compliance.js';

/**
 * Port: cryptographically sign a {@link ComplianceReport} so an auditor can **independently verify**
 * the attestation came from the operator and was not tampered with (std-owasp #8 — software/data
 * integrity; the compliance evidence layer, ADR-0011 Phase 1). This **upgrades** the report's
 * integrity anchor from a bare SHA-256 digest (proves only that bytes are unchanged) to an EdDSA
 * signature (proves authenticity, offline-verifiable with only the public key).
 *
 * It reuses the **same signing mechanism** as the erasure {@link import('./certificate-signer.js').CertificateSigner}
 * — a compact JWS over the report claims, using EdDSA (Ed25519) via the vetted `jose` library, never
 * hand-rolled (master §1, `@rules/topic-cryptography.md`) — but is a **distinct port with a distinct
 * purpose/`typ`** so the two artifact classes (erasure certificate vs compliance report) can never be
 * confused under the same key (cross-type confusion — std-cwe). The signing key is **private** and
 * comes from config / a secret manager (never hardcoded — `@rules/workflow-secrets.md`); only the
 * matching **public** JWK is exposed here, for publishing to verifiers.
 *
 * Designed so a **KMS/HSM-resident signer can drop in behind this same port** later (the engine
 * depends on the abstraction, not the in-process key — `@rules/topic-dependency-injection.md`).
 */
export interface ComplianceReportSigner {
  /**
   * Sign a compliance report, returning a **compact JWS** (`header.payload.signature`) whose payload
   * is the report's canonical claims. The protected header pins `alg: "EdDSA"` and the compliance-
   * report `typ`; verifiers must reject any other algorithm or type (no alg-confusion / `alg:none`,
   * no cross-type confusion — std-cwe).
   *
   * The report carries **no secrets** (counts, booleans, ids, and an already-redacted audit
   * excerpt — see {@link ComplianceReport}); the signer never logs the claims or key material.
   *
   * @param report - The pure report built by `buildComplianceReport`.
   * @returns The compact JWS string (safe to persist/transport alongside the report).
   */
  signReport(report: ComplianceReport): Promise<string>;

  /**
   * The **public** verification key as a JWK (`kty: "OKP"`, `crv: "Ed25519"`), publishable to
   * auditors so they can verify a signed report with `verifyComplianceReport`. Contains no private
   * material (`d` is never present).
   *
   * @returns The public Ed25519 JWK.
   */
  publicKeyJwk(): Promise<JWK>;
}
