import { SignJWT, type JWK } from 'jose';
import type { EvidenceBundle } from '../core/evidence-bundle.js';
import {
  evidenceBundleClaims,
  EVIDENCE_BUNDLE_ALG,
  EVIDENCE_BUNDLE_TYP,
} from '../core/evidence-bundle.js';
import type { EvidenceBundleSigner } from '../ports/evidence-bundle-signer.js';
import {
  importEd25519PrivateKey,
  generateEphemeralEd25519,
  type Ed25519PrivateKey,
} from './certificate-signer.js';

/**
 * A protected-header `kid` distinguishing the **evidence-bundle** signing purpose from the erasure
 * certificate's and the compliance report's (ADR-0011: distinct `kid`/purpose per artifact class).
 * Even when all three are signed by the same physical Ed25519 key (the bundle reuses the compliance
 * key — no third prod key), the `kid` + the distinct `typ` make the artifact classes unambiguous to
 * a verifier (defense in depth against cross-type confusion — std-cwe).
 */
export const EVIDENCE_BUNDLE_KID = 'tenantforge-evidence-bundle';

/** Options for {@link createEd25519EvidenceBundleSigner}. */
export interface Ed25519EvidenceBundleSignerOptions {
  /**
   * The Ed25519 **private** signing key material. One of a **PKCS#8 PEM** string
   * (`-----BEGIN PRIVATE KEY-----…`) or a **private JWK** (`{ kty: "OKP", crv: "Ed25519", d, x }`) as
   * an object or JSON string. Per ADR-0011 the bundle reuses the **compliance** evidence key
   * (`TENANTFORGE_COMPLIANCE_SIGNING_KEY`) — a secret from env / the secret manager (never hardcoded
   * or logged; `@rules/workflow-secrets.md`). The format is auto-detected: a string beginning with
   * `-----BEGIN` is PEM, otherwise it is parsed as JWK.
   */
  privateKey: string | JWK;
}

/** Build an {@link EvidenceBundleSigner} from a key + its public JWK (shared by configured + ephemeral). */
function signerFrom(key: Ed25519PrivateKey, publicJwk: JWK): EvidenceBundleSigner {
  // Freeze the published public JWK so a caller can't mutate the shared object.
  const frozenPublic: JWK = Object.freeze({ ...publicJwk });
  return {
    async signBundle(bundle: EvidenceBundle): Promise<string> {
      // Compact JWS over the canonical bundle body. The protected header pins the algorithm, the
      // domain `typ`, and the evidence-bundle `kid`; the verifier re-pins alg + typ (no alg-confusion
      // / no cross-type confusion — std-cwe).
      return new SignJWT({ bundle: evidenceBundleClaims(bundle) })
        .setProtectedHeader({
          alg: EVIDENCE_BUNDLE_ALG,
          typ: EVIDENCE_BUNDLE_TYP,
          kid: EVIDENCE_BUNDLE_KID,
        })
        .sign(key);
    },
    publicKeyJwk(): Promise<JWK> {
      return Promise.resolve({ ...frozenPublic });
    },
  };
}

/**
 * Create an EdDSA (Ed25519) {@link EvidenceBundleSigner} from a configured private key — the
 * compliance evidence layer's bundle signer (ADR-0011 Phase 2).
 *
 * Signs each {@link EvidenceBundle} as a **compact JWS** (EdDSA) under the evidence-bundle `typ` +
 * `kid` and exposes the matching public JWK for verification/publishing. Crypto is delegated to
 * `jose` — never hand-rolled (master §1, topic-cryptography). The key is loaded once at construction
 * so a bad key **fails fast at startup** (12-Factor; `@rules/topic-config-environments.md`).
 *
 * Per ADR-0011 the bundle **reuses the compliance evidence signing key** (no third prod key); it is a
 * **distinct signer with a distinct purpose** — a bundle and a report (or an erasure certificate) can
 * never be confused, even sharing key material.
 *
 * @param options - The Ed25519 private key (PKCS#8 PEM or JWK).
 * @returns A configured evidence-bundle signer (resolves once the key is imported + validated).
 * @throws Error if the key material is malformed or not an Ed25519 private key.
 */
export async function createEd25519EvidenceBundleSigner(
  options: Ed25519EvidenceBundleSignerOptions,
): Promise<EvidenceBundleSigner> {
  const { key, publicJwk } = await importEd25519PrivateKey(
    options.privateKey,
    'TENANTFORGE_COMPLIANCE_SIGNING_KEY',
  );
  return signerFrom(key, publicJwk);
}

/**
 * Create an evidence-bundle signer backed by a **freshly generated, in-memory** Ed25519 keypair —
 * for **dev/test/CI only**, when no signing key is configured in a non-production context.
 *
 * The key exists only for the process lifetime: bundles signed across restarts are **not** verifiable
 * against a stable published key, and the private key is never persisted. NEVER use in production —
 * production fails fast without a configured key (see the composition-root startup validation).
 *
 * @returns An ephemeral evidence-bundle signer.
 */
export async function createEphemeralEvidenceBundleSigner(): Promise<EvidenceBundleSigner> {
  const { key, publicJwk } = await generateEphemeralEd25519();
  return signerFrom(key, publicJwk);
}
