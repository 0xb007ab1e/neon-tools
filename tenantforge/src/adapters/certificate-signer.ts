import {
  SignJWT,
  importPKCS8,
  importJWK,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type KeyObject,
  type JWK,
} from 'jose';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { ErasureCertificate } from '../core/erasure.js';
import { erasureCertClaims, ERASURE_CERT_ALG, ERASURE_CERT_TYP } from '../core/erasure-cert.js';
import type { CertificateSigner } from '../ports/certificate-signer.js';

/** A private signing key as accepted by `jose`: a `CryptoKey`/`KeyObject` (the Ed25519 private key). */
type PrivateKey = CryptoKey | KeyObject;

/** Options for {@link createEd25519CertificateSigner}. */
export interface Ed25519CertificateSignerOptions {
  /**
   * The Ed25519 **private** signing key material. One of:
   * - a **PKCS#8 PEM** string (`-----BEGIN PRIVATE KEY-----…`), or
   * - a **private JWK** (`{ kty: "OKP", crv: "Ed25519", d, x }`) as an object or JSON string.
   *
   * Comes from `TENANTFORGE_ERASURE_SIGNING_KEY` (a secret from env / the secret manager — never
   * hardcoded or logged; `@rules/workflow-secrets.md`). The format is auto-detected: a string
   * beginning with `-----BEGIN` is PEM, otherwise it is parsed as JWK.
   */
  privateKey: string | JWK;
}

/**
 * Coerce a private-key input (PKCS#8 PEM or JWK) into a `jose` key + derive the matching **public**
 * JWK. Fails closed on anything that isn't an Ed25519 private key (master §2, topic-cryptography).
 *
 * @param input - The PEM string or JWK (object/JSON).
 * @returns The imported private key and its public JWK.
 * @throws Error if the material is malformed or not an Ed25519 private key.
 */
async function importEd25519PrivateKey(
  input: string | JWK,
): Promise<{ key: PrivateKey; publicJwk: JWK }> {
  let jwk: JWK;
  if (typeof input === 'string' && input.trimStart().startsWith('-----BEGIN')) {
    // PKCS#8 PEM → the signing key (kept NON-extractable — the private key never leaves the
    // process as bytes). Derive the public JWK via Node's KeyObject (no need to make the private
    // key extractable just to publish the public half).
    const key = (await importPKCS8(input, ERASURE_CERT_ALG)) as PrivateKey;
    const pubKeyObject = createPublicKey(createPrivateKey(input));
    const exported = pubKeyObject.export({ format: 'jwk' }) as JWK;
    if (exported.kty !== 'OKP' || exported.crv !== 'Ed25519') {
      throw new Error('TENANTFORGE_ERASURE_SIGNING_KEY: PEM is not an Ed25519 (OKP) private key');
    }
    return { key, publicJwk: stripPrivate(exported) };
  }
  // Otherwise treat as JWK (object or JSON string).
  try {
    jwk = typeof input === 'string' ? (JSON.parse(input) as JWK) : input;
  } catch {
    throw new Error('TENANTFORGE_ERASURE_SIGNING_KEY: not valid PKCS#8 PEM or JWK JSON');
  }
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string') {
    throw new Error(
      'TENANTFORGE_ERASURE_SIGNING_KEY: JWK must be an Ed25519 private key (kty=OKP, crv=Ed25519, d set)',
    );
  }
  const key = (await importJWK(jwk, ERASURE_CERT_ALG)) as PrivateKey;
  // The public JWK is the private JWK minus its private member(s) — see stripPrivate.
  return { key, publicJwk: stripPrivate(jwk) };
}

/** Return a copy of a JWK with private/sensitive members removed (only the public Ed25519 fields). */
function stripPrivate(jwk: JWK): JWK {
  return { kty: 'OKP', crv: 'Ed25519', ...(jwk.x !== undefined ? { x: jwk.x } : {}) };
}

/**
 * Build a {@link CertificateSigner} from a key + its public JWK — the shared signer construction for
 * both the configured and the dev-ephemeral paths.
 */
function signerFrom(key: PrivateKey, publicJwk: JWK): CertificateSigner {
  // Freeze the published public JWK so a caller can't mutate the shared object.
  const frozenPublic: JWK = Object.freeze({ ...publicJwk });
  return {
    async sign(certificate: ErasureCertificate): Promise<string> {
      // Compact JWS (JWT claims) over the canonical certificate body. The protected header pins the
      // algorithm + a domain `typ`; the verifier re-pins both (no alg-confusion — std-cwe).
      return new SignJWT({ cert: erasureCertClaims(certificate) })
        .setProtectedHeader({ alg: ERASURE_CERT_ALG, typ: ERASURE_CERT_TYP })
        .sign(key);
    },
    publicKeyJwk(): Promise<JWK> {
      return Promise.resolve({ ...frozenPublic });
    },
  };
}

/**
 * Create an EdDSA (Ed25519) {@link CertificateSigner} from a configured private key.
 *
 * Signs each {@link ErasureCertificate} as a **compact JWS** (EdDSA) and exposes the matching public
 * JWK for verification/publishing. Crypto is delegated to `jose` — never hand-rolled (master §1,
 * topic-cryptography). The key is loaded once at construction so a bad key **fails fast at startup**
 * (12-Factor config; `@rules/topic-config-environments.md`), not at erasure time.
 *
 * A KMS/HSM-resident signer can later implement the same {@link CertificateSigner} port without
 * touching the engine (the engine depends on the abstraction).
 *
 * @param options - The Ed25519 private key (PKCS#8 PEM or JWK).
 * @returns A configured certificate signer (resolves once the key is imported + validated).
 * @throws Error if the key material is malformed or not an Ed25519 private key.
 */
export async function createEd25519CertificateSigner(
  options: Ed25519CertificateSignerOptions,
): Promise<CertificateSigner> {
  const { key, publicJwk } = await importEd25519PrivateKey(options.privateKey);
  return signerFrom(key, publicJwk);
}

/**
 * Create an EdDSA signer backed by a **freshly generated, in-memory** Ed25519 keypair — for
 * **dev/test/CI only**, when no signing key is configured in a non-production context.
 *
 * The key exists only for the process lifetime: certificates signed across restarts are **not**
 * verifiable against a stable published key, and the private key is never persisted. NEVER use in
 * production — production fails fast without a configured key (see config/startup validation). The
 * caller logs a clear non-prod warning when taking this path.
 *
 * @returns An ephemeral certificate signer.
 */
export async function createEphemeralCertificateSigner(): Promise<CertificateSigner> {
  // `extractable: true` so the public JWK can be exported for in-process verification in tests.
  const { privateKey, publicKey } = await generateKeyPair(ERASURE_CERT_ALG, { extractable: true });
  const publicJwk = stripPrivate(await exportJWK(publicKey));
  return signerFrom(privateKey, publicJwk);
}
