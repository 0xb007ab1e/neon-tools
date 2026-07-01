import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deriveKey, open, seal } from '../../src/adapters/secret-crypto.js';

/**
 * Property-based tests for the AES-256-GCM secret sealing round-trip (defense-in-depth over the
 * example-based suite). A break here means a stored connection secret could be silently corrupted
 * or a tampered ciphertext accepted — a data-integrity / confidentiality defect (master §5).
 */

// A single fixed workspace key for the whole suite (deterministic; secret sealing uses one key).
const key = deriveKey('a-long-high-entropy-property-test-passphrase');
const otherKey = deriveKey('an-entirely-different-property-test-passphrase');

describe('secret-crypto seal/open — properties', () => {
  it('round-trips arbitrary unicode plaintext: open(key, seal(key, s)) === s', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (plaintext) => {
        // `fc.string({ unit: 'binary' })` covers the full code-point range incl. surrogates,
        // control chars, and multi-byte sequences — the toughest UTF-8 round-trip inputs.
        expect(open(key, seal(key, plaintext))).toBe(plaintext);
      }),
      { numRuns: 200 },
    );
  });

  it('also round-trips typical connection-URI-shaped strings and empty input', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(''),
          fc.webUrl(),
          fc.string(),
          fc.constant('postgresql://user:pw@host/neondb?sslmode=require'),
        ),
        (s) => {
          expect(open(key, seal(key, s))).toBe(s);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('produces a fresh nonce each call ⇒ two seals of the same input differ', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(seal(key, s)).not.toBe(seal(key, s));
      }),
      { numRuns: 200 },
    );
  });

  it('sealed output is always the versioned 4-part form (v1.nonce.tag.ciphertext)', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const parts = seal(key, s).split('.');
        expect(parts.length).toBe(4);
        expect(parts[0]).toBe('v1');
      }),
      { numRuns: 100 },
    );
  });

  it('fails closed when opened with the wrong key (GCM auth failure)', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const sealed = seal(key, s);
        expect(() => open(otherKey, sealed)).toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('flipping any byte of the ciphertext makes open throw (tamper-evident)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.nat(), (s, byteIndex) => {
        const [version, nonce, tag, ct] = seal(key, s).split('.') as [
          string,
          string,
          string,
          string,
        ];
        const bytes = Buffer.from(ct, 'base64');
        // Guard: for a non-empty plaintext the ciphertext is non-empty; flip one arbitrary byte.
        const i = byteIndex % bytes.length;
        bytes[i] = bytes[i]! ^ 0xff;
        const tampered = [version, nonce, tag, bytes.toString('base64')].join('.');
        expect(() => open(key, tampered)).toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('flipping any byte of the auth tag makes open throw', () => {
    fc.assert(
      fc.property(fc.string(), fc.nat(), (s, byteIndex) => {
        const [version, nonce, tag, ct] = seal(key, s).split('.') as [
          string,
          string,
          string,
          string,
        ];
        const bytes = Buffer.from(tag, 'base64');
        const i = byteIndex % bytes.length;
        bytes[i] = bytes[i]! ^ 0xff;
        const tampered = [version, nonce, bytes.toString('base64'), ct].join('.');
        expect(() => open(key, tampered)).toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('rejects a malformed sealed value (wrong number of parts)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.base64String(), { minLength: 0, maxLength: 6 }).filter(
          // Only lengths other than the valid 3 (legacy v1) or 4 (versioned) are malformed.
          (parts) => parts.length !== 3 && parts.length !== 4,
        ),
        (parts) => {
          expect(() => open(key, parts.join('.'))).toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });
});
