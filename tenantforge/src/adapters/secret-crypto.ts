import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** AES-256-GCM: 12-byte nonce, 16-byte auth tag, 32-byte key. */
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
/** Domain-separation salt for deriving the data key from the configured passphrase. */
const KDF_SALT = 'tenantforge.connection-secret.v1';
/**
 * Current sealed-format version, stored as the leading `.`-part of every new sealed value
 * (**crypto-agility** — topic-cryptography): it records which algorithm + KDF produced the value so
 * the primitives can be upgraded later WITHOUT losing access to already-stored secrets. A future
 * `v2` can seal with a different cipher/KDF while {@link open} still decrypts every existing value by
 * dispatching on this tag. Values written before versioning (no tag, 3 parts) are read as `v1`.
 */
const CURRENT_VERSION = 'v1';

/**
 * Derive a 32-byte AES key from a passphrase (the `TENANTFORGE_SECRET_KEY` config value).
 *
 * Uses scrypt with a fixed domain-separation salt — there is a single workspace key, so the salt's
 * job is domain separation, not per-record uniqueness. Use a long, high-entropy passphrase.
 *
 * @param passphrase - The configured secret key (any non-empty string).
 * @returns A 32-byte key buffer.
 */
export function deriveKey(passphrase: string): Buffer {
  return scryptSync(passphrase, KDF_SALT, KEY_BYTES);
}

/**
 * Seal a plaintext secret with AES-256-GCM, returning `version.nonce.tag.ciphertext` (base64 parts).
 *
 * A fresh random nonce is generated per call (never reuse a nonce under the same key). The leading
 * {@link CURRENT_VERSION} tag makes the format crypto-agile (see the constant). The result is safe to
 * store at rest; it is unreadable without the key (separation of duties from the DB credential —
 * master §5).
 *
 * @param key - A 32-byte key (see {@link deriveKey}).
 * @param plaintext - The secret to seal (e.g. a connection URI).
 * @returns The sealed string `{version}.b64(nonce).b64(tag).b64(ciphertext)`.
 */
export function seal(key: Buffer, plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [CURRENT_VERSION, ...[nonce, tag, ciphertext].map((b) => b.toString('base64'))].join('.');
}

/**
 * Open a value produced by {@link seal}. Throws if the key is wrong or the data was tampered with
 * (GCM authentication fails) — fail closed (master §2).
 *
 * @param key - The 32-byte key the value was sealed with.
 * @param sealed - The `version.nonce.tag.ciphertext` string (or the legacy, untagged
 *   `nonce.tag.ciphertext` — read as `v1` for backward compatibility with secrets stored before
 *   versioning).
 * @returns The recovered plaintext.
 * @throws Error if the format is malformed, the version is unsupported, or decryption/authentication
 *   fails (fail closed — master §2).
 */
export function open(key: Buffer, sealed: string): string {
  const parts = sealed.split('.');
  // Versioned format is `version.nonce.tag.ciphertext` (4 parts). A 3-part value predates versioning
  // (stored before the crypto-agility tag) — read it as v1. Anything else is malformed.
  let version: string;
  let body: string[];
  if (parts.length === 4) {
    [version] = parts as [string, string, string, string];
    body = parts.slice(1);
  } else if (parts.length === 3) {
    version = 'v1';
    body = parts;
  } else {
    throw new Error('malformed sealed secret');
  }
  if (version !== 'v1') {
    // Fail closed on an unknown version rather than guess the algorithm (crypto-agility: a future v2
    // adds its branch here). Never silently mis-decrypt.
    throw new Error(`unsupported sealed-secret version: ${version}`);
  }
  const [nonce, tag, ciphertext] = body.map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, nonce!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString('utf8');
}
