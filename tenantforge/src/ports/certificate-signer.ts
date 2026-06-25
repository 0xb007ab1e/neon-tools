import type { JWK } from 'jose';
import type { ErasureCertificate } from '../core/erasure.js';

/**
 * Port: cryptographically sign an {@link ErasureCertificate} so an auditor / data subject can
 * **verify** the erasure attestation came from the operator and was not tampered with (GDPR Art. 17
 * evidence; workflow-data-lifecycle, std-owasp #8 — software/data integrity).
 *
 * The signature is a **compact JWS over the certificate claims, using EdDSA (Ed25519)** — an approved
 * asymmetric primitive (`@rules/topic-cryptography.md`), delegated to a vetted library (`jose`),
 * never hand-rolled (master §1). The signing key is **private** and comes from config / a secret
 * manager (never hardcoded — `@rules/workflow-secrets.md`); only the matching **public** JWK is
 * exposed here, for publishing to verifiers.
 *
 * Designed so a **KMS/HSM-resident signer can drop in behind this same port** later (the engine
 * depends on the abstraction, not the in-process key — `@rules/topic-dependency-injection.md`).
 */
export interface CertificateSigner {
  /**
   * Sign an erasure certificate, returning a **compact JWS** (`header.payload.signature`) whose
   * payload is the certificate's claims. The protected header pins `alg: "EdDSA"`; verifiers must
   * reject any other algorithm (no alg-confusion / `alg:none` — std-cwe).
   *
   * The certificate carries **no secrets** (only ids, references, and booleans — see
   * {@link ErasureCertificate}); the signer never logs the claims or key material.
   *
   * @param certificate - The pure certificate built by `buildErasureCertificate`.
   * @returns The compact JWS string (safe to persist/transport alongside the certificate).
   */
  sign(certificate: ErasureCertificate): Promise<string>;

  /**
   * The **public** verification key as a JWK (`kty: "OKP"`, `crv: "Ed25519"`), publishable to
   * auditors / data subjects so they can verify a signed certificate with
   * `verifyErasureCertificate`. Contains no private material (`d` is never present).
   *
   * @returns The public Ed25519 JWK.
   */
  publicKeyJwk(): Promise<JWK>;
}
