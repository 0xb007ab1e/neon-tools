import { describe, expect, it } from 'vitest';
import { deriveKey, open, seal } from '../../src/adapters/secret-crypto.js';

const key = deriveKey('a-long-high-entropy-test-passphrase');

describe('secret-crypto', () => {
  it('round-trips a secret (seal → open)', () => {
    const uri = 'postgresql://user:pw@host/neondb?sslmode=require';
    expect(open(key, seal(key, uri))).toBe(uri);
  });

  it('produces a different ciphertext each time (fresh nonce)', () => {
    expect(seal(key, 'x')).not.toBe(seal(key, 'x'));
  });

  it('fails closed on a wrong key', () => {
    const sealed = seal(key, 'secret');
    expect(() => open(deriveKey('a-different-passphrase'), sealed)).toThrow();
  });

  it('fails closed on tampering (GCM auth)', () => {
    const sealed = seal(key, 'secret');
    const [nonce, tag, ct] = sealed.split('.');
    // Flip a byte of the ciphertext.
    const bytes = Buffer.from(ct!, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered = [nonce, tag, bytes.toString('base64')].join('.');
    expect(() => open(key, tampered)).toThrow();
  });

  it('rejects a malformed sealed value', () => {
    expect(() => open(key, 'not-three-parts')).toThrow(/malformed/);
  });
});
