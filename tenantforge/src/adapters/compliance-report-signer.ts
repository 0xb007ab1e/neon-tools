import { SignJWT, type JWK } from 'jose';
import type { ComplianceReport } from '../core/compliance.js';
import {
  complianceReportClaims,
  COMPLIANCE_REPORT_ALG,
  COMPLIANCE_REPORT_TYP,
} from '../core/compliance-cert.js';
import type { ComplianceReportSigner } from '../ports/compliance-report-signer.js';
import {
  importEd25519PrivateKey,
  generateEphemeralEd25519,
  type Ed25519PrivateKey,
} from './certificate-signer.js';

/**
 * A protected-header `kid` distinguishing the **compliance-report** signing purpose from the erasure
 * certificate's (ADR-0011: a distinct `kid`/purpose for evidence vs erasure certs). Even when both
 * are signed by the same physical Ed25519 key, the `kid` + the distinct `typ` make the two artifact
 * classes unambiguous to a verifier (defense in depth against cross-type confusion — std-cwe).
 */
export const COMPLIANCE_REPORT_KID = 'tenantforge-compliance-report';

/** Options for {@link createEd25519ComplianceReportSigner}. */
export interface Ed25519ComplianceReportSignerOptions {
  /**
   * The Ed25519 **private** signing key material. One of a **PKCS#8 PEM** string
   * (`-----BEGIN PRIVATE KEY-----…`) or a **private JWK** (`{ kty: "OKP", crv: "Ed25519", d, x }`) as
   * an object or JSON string. Comes from `TENANTFORGE_COMPLIANCE_SIGNING_KEY` (a secret from env / the
   * secret manager — never hardcoded or logged; `@rules/workflow-secrets.md`). The format is
   * auto-detected: a string beginning with `-----BEGIN` is PEM, otherwise it is parsed as JWK.
   */
  privateKey: string | JWK;
}

/** Build a {@link ComplianceReportSigner} from a key + its public JWK (shared by configured + ephemeral). */
function signerFrom(key: Ed25519PrivateKey, publicJwk: JWK): ComplianceReportSigner {
  // Freeze the published public JWK so a caller can't mutate the shared object.
  const frozenPublic: JWK = Object.freeze({ ...publicJwk });
  return {
    async signReport(report: ComplianceReport): Promise<string> {
      // Compact JWS over the canonical report body. The protected header pins the algorithm, the
      // domain `typ`, and the compliance `kid`; the verifier re-pins alg + typ (no alg-confusion /
      // no cross-type confusion — std-cwe).
      return new SignJWT({ report: complianceReportClaims(report) })
        .setProtectedHeader({
          alg: COMPLIANCE_REPORT_ALG,
          typ: COMPLIANCE_REPORT_TYP,
          kid: COMPLIANCE_REPORT_KID,
        })
        .sign(key);
    },
    publicKeyJwk(): Promise<JWK> {
      return Promise.resolve({ ...frozenPublic });
    },
  };
}

/**
 * Create an EdDSA (Ed25519) {@link ComplianceReportSigner} from a configured private key — the
 * compliance evidence layer's report signer (ADR-0011 Phase 1).
 *
 * Signs each {@link ComplianceReport} as a **compact JWS** (EdDSA) under the compliance-report `typ`
 * + `kid` and exposes the matching public JWK for verification/publishing. Crypto is delegated to
 * `jose` — never hand-rolled (master §1, topic-cryptography). The key is loaded once at construction
 * so a bad key **fails fast at startup** (12-Factor; `@rules/topic-config-environments.md`).
 *
 * Reuses the same Ed25519 mechanism as the erasure {@link import('../ports/certificate-signer.js').CertificateSigner}
 * but is a **distinct signer with a distinct purpose** (the locked decision in ADR-0011) — they may
 * even share key material, but a report and an erasure certificate can never be confused.
 *
 * @param options - The Ed25519 private key (PKCS#8 PEM or JWK).
 * @returns A configured compliance-report signer (resolves once the key is imported + validated).
 * @throws Error if the key material is malformed or not an Ed25519 private key.
 */
export async function createEd25519ComplianceReportSigner(
  options: Ed25519ComplianceReportSignerOptions,
): Promise<ComplianceReportSigner> {
  const { key, publicJwk } = await importEd25519PrivateKey(
    options.privateKey,
    'TENANTFORGE_COMPLIANCE_SIGNING_KEY',
  );
  return signerFrom(key, publicJwk);
}

/**
 * Create a compliance-report signer backed by a **freshly generated, in-memory** Ed25519 keypair —
 * for **dev/test/CI only**, when no signing key is configured in a non-production context.
 *
 * The key exists only for the process lifetime: reports signed across restarts are **not** verifiable
 * against a stable published key, and the private key is never persisted. NEVER use in production —
 * production fails fast without a configured key (see the composition-root startup validation).
 *
 * @returns An ephemeral compliance-report signer.
 */
export async function createEphemeralComplianceReportSigner(): Promise<ComplianceReportSigner> {
  const { key, publicJwk } = await generateEphemeralEd25519();
  return signerFrom(key, publicJwk);
}
