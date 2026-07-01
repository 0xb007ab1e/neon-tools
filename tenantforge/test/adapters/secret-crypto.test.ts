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
    const [version, nonce, tag, ct] = sealed.split('.');
    // Flip a byte of the ciphertext.
    const bytes = Buffer.from(ct!, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered = [version, nonce, tag, bytes.toString('base64')].join('.');
    expect(() => open(key, tampered)).toThrow();
  });

  it('rejects a malformed sealed value', () => {
    expect(() => open(key, 'not-enough-parts')).toThrow(/malformed/);
    expect(() => open(key, 'a.b.c.d.e')).toThrow(/malformed/);
  });

  it('tags new sealed values with the current version (crypto-agility, gap #16)', () => {
    const sealed = seal(key, 'secret');
    expect(sealed.split('.')).toHaveLength(4);
    expect(sealed.startsWith('v1.')).toBe(true);
  });

  it('still opens a legacy untagged (3-part) value as v1 — backward compatible', () => {
    // Values written before versioning had no leading tag: `nonce.tag.ciphertext`.
    const legacy = seal(key, 'legacy-secret').split('.').slice(1).join('.');
    expect(legacy.split('.')).toHaveLength(3);
    expect(open(key, legacy)).toBe('legacy-secret');
  });

  it('fails closed on an unsupported version tag', () => {
    const body = seal(key, 'secret').split('.').slice(1).join('.');
    expect(() => open(key, `v2.${body}`)).toThrow(/unsupported sealed-secret version/);
  });
});
