import { compactVerify, importJWK, type JWK } from 'jose';
import type { ErasureCertificate, ErasureVerification } from './erasure.js';

/**
 * The single approved signature algorithm for erasure certificates: **EdDSA (Ed25519)**
 * (`@rules/topic-cryptography.md`). Pinned on **both** sign and verify so a forged token can't
 * downgrade to `none`/`HS*` (alg-confusion — std-cwe; mirrors the OIDC authenticator's allow-list).
 */
export const ERASURE_CERT_ALG = 'EdDSA';

/**
 * The JWS protected-header **type** for a signed erasure certificate — a domain tag so a verifier
 * (or a confused-deputy) can't accept a token minted for another purpose under the same key.
 */
export const ERASURE_CERT_TYP = 'application/erasure-cert+jws';

/** The custom claim under which the certificate body travels in the JWS payload. */
const CERT_CLAIM = 'cert';

/**
 * Map an {@link ErasureCertificate} to a stable, canonical claim object for signing.
 *
 * The shape is fixed and field-ordered so the signed bytes are deterministic for a given certificate
 * (the optional `exportLocation` is included only when present, exactly as the certificate models it).
 * Pure — no I/O, no clock.
 *
 * @param certificate - The certificate to canonicalize.
 * @returns The canonical claim object embedded in the JWS payload.
 */
export function erasureCertClaims(certificate: ErasureCertificate): Record<string, unknown> {
  return {
    tenantId: certificate.tenantId,
    slug: certificate.slug,
    reason: certificate.reason,
    erasedAt: certificate.erasedAt,
    exported: certificate.exported,
    ...(certificate.exportLocation !== undefined
      ? { exportLocation: certificate.exportLocation }
      : {}),
    projectDeleted: certificate.projectDeleted,
    verification: {
      secretShredded: certificate.verification.secretShredded,
      statusDeleted: certificate.verification.statusDeleted,
    },
    verified: certificate.verified,
  };
}

/** A signed erasure certificate: the plain certificate plus its detached-payload compact JWS. */
export interface SignedErasureCertificate {
  /** The auditable certificate (no secrets — only ids, references, booleans). */
  certificate: ErasureCertificate;
  /**
   * The compact JWS (`header.payload.signature`) signed with EdDSA over {@link erasureCertClaims}.
   * Absent only in the rare fail-soft case where signing threw *after* the irreversible erasure
   * already completed (the data is gone; the certificate is recorded unsigned and an operator is
   * alerted — never roll back). Always present on the happy path.
   */
  jws?: string;
}

/** A boolean validator narrowing an `unknown` to `boolean`, used when re-hydrating verified claims. */
function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

/** A string validator narrowing an `unknown` to `string`. */
function isString(v: unknown): v is string {
  return typeof v === 'string';
}

/**
 * **Verify** a signed erasure certificate against a published Ed25519 public JWK and return the
 * certificate claims — the auditor / data-subject path (std-owasp #8 integrity verification).
 *
 * Fail-closed at every step (the JWS is **untrusted input** — std-cwe): the algorithm is pinned to
 * EdDSA (rejects `none`/`HS*`/any non-EdDSA — no alg-confusion), the header `typ` must match, the
 * key must be an Ed25519 public key, and the payload must structurally match a certificate. Any
 * failure throws; the function never returns an unverified certificate.
 *
 * Pure given its inputs (no network, no clock, no shared state) — a strong unit/mutation target.
 *
 * @param jws - The compact JWS produced by a {@link import('../ports/certificate-signer.js').CertificateSigner}.
 * @param publicKeyJwk - The operator's published Ed25519 **public** JWK.
 * @returns The verified certificate claims.
 * @throws Error if the signature, algorithm, header type, key, or payload shape is invalid.
 */
export async function verifyErasureCertificate(
  jws: string,
  publicKeyJwk: JWK,
): Promise<ErasureCertificate> {
  if (typeof jws !== 'string' || jws === '') {
    throw new Error('verifyErasureCertificate: empty or non-string JWS');
  }
  // Refuse anything that isn't an EdDSA/Ed25519 public key up front — never let the token's header
  // pick the key type (alg-confusion defense begins at the key — std-cwe / topic-cryptography).
  if (publicKeyJwk.kty !== 'OKP' || publicKeyJwk.crv !== 'Ed25519') {
    throw new Error('verifyErasureCertificate: public key must be an Ed25519 (OKP) JWK');
  }
  if (publicKeyJwk.d !== undefined) {
    // A private key was passed where a public one is expected — refuse rather than risk misuse.
    throw new Error('verifyErasureCertificate: expected a public key (private material present)');
  }

  const key = await importJWK(publicKeyJwk, ERASURE_CERT_ALG);
  // `compactVerify` validates the EdDSA signature; `algorithms` pins the accepted alg so a token
  // claiming `none`/`HS256`/etc. is rejected before any verification shortcut (no alg-confusion).
  // `compactVerify` validates the EdDSA signature AND pins the accepted algorithm via `algorithms`,
  // so a token claiming `none`/`HS256`/any non-EdDSA alg is rejected here (no alg-confusion) — the
  // alg never needs a separate re-check (it can't reach past this gate as anything but EdDSA).
  let payloadBytes: Uint8Array;
  let protectedHeader: { alg?: string; typ?: string };
  try {
    const result = await compactVerify(jws, key, { algorithms: [ERASURE_CERT_ALG] });
    payloadBytes = result.payload;
    protectedHeader = result.protectedHeader;
  } catch (error) {
    // jose throws Error subclasses; `String(error)` renders them uniformly (no untestable branch).
    throw new Error(`verifyErasureCertificate: signature verification failed: ${String(error)}`);
  }

  // Domain guard: reject a token minted for another purpose under the same key (confused deputy).
  if (protectedHeader.typ !== ERASURE_CERT_TYP) {
    throw new Error('verifyErasureCertificate: unexpected or missing certificate type header');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    throw new Error('verifyErasureCertificate: payload is not valid JSON');
  }
  return reconstructCertificate(parsed);
}

/**
 * Re-hydrate (and structurally validate) an {@link ErasureCertificate} from a verified JWS payload.
 * Allow-list each field with a strict type check (std-owasp-proactive #5) — a payload missing or
 * mistyping any field is rejected (fail closed); we never coerce.
 *
 * @param parsed - The JSON-parsed JWS payload.
 * @returns The reconstructed certificate.
 * @throws Error if the payload does not match the certificate shape.
 */
function reconstructCertificate(parsed: unknown): ErasureCertificate {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('verifyErasureCertificate: payload is not an object');
  }
  const body = (parsed as Record<string, unknown>)[CERT_CLAIM];
  if (typeof body !== 'object' || body === null) {
    throw new Error('verifyErasureCertificate: payload is missing the certificate claim');
  }
  const c = body as Record<string, unknown>;
  const verification = c.verification;
  if (typeof verification !== 'object' || verification === null) {
    throw new Error('verifyErasureCertificate: malformed verification block');
  }
  const v = verification as Record<string, unknown>;

  if (
    !isString(c.tenantId) ||
    !isString(c.slug) ||
    !isString(c.reason) ||
    !isString(c.erasedAt) ||
    !isBoolean(c.exported) ||
    !isBoolean(c.projectDeleted) ||
    !isBoolean(c.verified) ||
    !isBoolean(v.secretShredded) ||
    !isBoolean(v.statusDeleted) ||
    (c.exportLocation !== undefined && !isString(c.exportLocation))
  ) {
    throw new Error('verifyErasureCertificate: certificate claim has an invalid shape');
  }

  const ver: ErasureVerification = {
    secretShredded: v.secretShredded,
    statusDeleted: v.statusDeleted,
  };
  return {
    tenantId: c.tenantId,
    slug: c.slug,
    reason: c.reason,
    erasedAt: c.erasedAt,
    exported: c.exported,
    ...(c.exportLocation !== undefined ? { exportLocation: c.exportLocation } : {}),
    projectDeleted: c.projectDeleted,
    verification: ver,
    verified: c.verified,
  };
}
