import type { JWK } from 'jose';
import type { EvidenceBundle } from '../core/evidence-bundle.js';

/**
 * Port: cryptographically sign an {@link EvidenceBundle} so an auditor can **independently verify**
 * the evidence pack came from the operator and was not tampered with (std-owasp #8 — software/data
 * integrity; the compliance evidence layer, ADR-0011 Phase 2). Verification is the product: an
 * auditor verifies a bundle **offline with only the public key**.
 *
 * It reuses the **same signing mechanism** as the erasure
 * {@link import('./certificate-signer.js').CertificateSigner} and the
 * {@link import('./compliance-report-signer.js').ComplianceReportSigner} — a compact JWS over the
 * bundle claims, using EdDSA (Ed25519) via the vetted `jose` library, never hand-rolled (master §1,
 * `@rules/topic-cryptography.md`) — but is a **distinct port with a distinct purpose/`typ`** so the
 * three artifact classes (erasure certificate, compliance report, evidence bundle) can never be
 * confused under the same key (cross-type confusion — std-cwe). Per ADR-0011 the bundle **reuses the
 * compliance evidence signing key** (`TENANTFORGE_COMPLIANCE_SIGNING_KEY`) — no third prod key — and
 * is distinguished only by the `typ`/`kid` the verifier pins.
 *
 * The signing key is **private** and comes from config / a secret manager (never hardcoded —
 * `@rules/workflow-secrets.md`); only the matching **public** JWK is exposed here, for publishing to
 * verifiers. A **KMS/HSM-resident signer can drop in behind this same port** later (the engine
 * depends on the abstraction, not the in-process key — `@rules/topic-dependency-injection.md`).
 */
export interface EvidenceBundleSigner {
  /**
   * Sign an evidence bundle, returning a **compact JWS** (`header.payload.signature`) whose payload
   * is the bundle's canonical claims. The protected header pins `alg: "EdDSA"` and the evidence-
   * bundle `typ`; verifiers must reject any other algorithm or type (no alg-confusion / `alg:none`,
   * no cross-type confusion — std-cwe).
   *
   * The bundle carries **no secrets** (counts, booleans, ids, a redacted audit excerpt, and the
   * already-signed erasure-certificate JWS strings — see {@link EvidenceBundle}); the signer never
   * logs the claims or key material.
   *
   * @param bundle - The pure bundle built by `buildEvidenceBundle`.
   * @returns The compact JWS string (safe to persist/transport alongside the bundle).
   */
  signBundle(bundle: EvidenceBundle): Promise<string>;

  /**
   * The **public** verification key as a JWK (`kty: "OKP"`, `crv: "Ed25519"`), publishable to
   * auditors so they can verify a signed bundle with `verifyEvidenceBundle`. Contains no private
   * material (`d` is never present).
   *
   * @returns The public Ed25519 JWK.
   */
  publicKeyJwk(): Promise<JWK>;
}
