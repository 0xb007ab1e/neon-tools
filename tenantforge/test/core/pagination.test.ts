import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, type TenantCursor } from '../../src/core/pagination.js';

const cursor: TenantCursor = { createdAt: new Date('2026-06-18T12:34:56.000Z'), id: 'tenant-7' };

describe('cursor encode/decode', () => {
  it('round-trips a cursor through an opaque token', () => {
    const token = encodeCursor(cursor);
    expect(token).not.toContain('|'); // opaque (base64url)
    const decoded = decodeCursor(token);
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe('tenant-7');
    expect(decoded!.createdAt.toISOString()).toBe('2026-06-18T12:34:56.000Z');
  });

  it('preserves an id that itself contains a pipe', () => {
    const decoded = decodeCursor(encodeCursor({ createdAt: cursor.createdAt, id: 'a|b|c' }));
    expect(decoded!.id).toBe('a|b|c');
  });

  it('returns null for a token with no separator', () => {
    expect(decodeCursor(Buffer.from('no-separator', 'utf8').toString('base64url'))).toBeNull();
  });

  it('returns null for an empty timestamp or empty id', () => {
    expect(decodeCursor(Buffer.from('|id', 'utf8').toString('base64url'))).toBeNull();
    expect(
      decodeCursor(Buffer.from('2026-06-18T00:00:00.000Z|', 'utf8').toString('base64url')),
    ).toBeNull();
  });

  it('returns null for an invalid / non-canonical timestamp', () => {
    expect(decodeCursor(Buffer.from('not-a-date|x', 'utf8').toString('base64url'))).toBeNull();
    // A parseable but non-canonical ISO string is rejected (round-trip mismatch).
    expect(decodeCursor(Buffer.from('2026-06-18|x', 'utf8').toString('base64url'))).toBeNull();
  });
});
