import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** AES-256-GCM: 12-byte nonce, 16-byte auth tag, 32-byte key. */
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
/** Domain-separation salt for deriving the data key from the configured passphrase. */
const KDF_SALT = 'tenantforge.connection-secret.v1';

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
 * Seal a plaintext secret with AES-256-GCM, returning `nonce.tag.ciphertext` (base64 parts).
 *
 * A fresh random nonce is generated per call (never reuse a nonce under the same key). The result is
 * safe to store at rest; it is unreadable without the key (separation of duties from the DB
 * credential — master §5).
 *
 * @param key - A 32-byte key (see {@link deriveKey}).
 * @param plaintext - The secret to seal (e.g. a connection URI).
 * @returns The sealed string `b64(nonce).b64(tag).b64(ciphertext)`.
 */
export function seal(key: Buffer, plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [nonce, tag, ciphertext].map((b) => b.toString('base64')).join('.');
}

/**
 * Open a value produced by {@link seal}. Throws if the key is wrong or the data was tampered with
 * (GCM authentication fails) — fail closed (master §2).
 *
 * @param key - The 32-byte key the value was sealed with.
 * @param sealed - The `nonce.tag.ciphertext` string.
 * @returns The recovered plaintext.
 * @throws Error if the format is malformed, or decryption/authentication fails.
 */
export function open(key: Buffer, sealed: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 3) {
    throw new Error('malformed sealed secret');
  }
  const [nonce, tag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, nonce!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString('utf8');
}
