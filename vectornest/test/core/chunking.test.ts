import { describe, expect, it } from 'vitest';
import { chunkText, DEFAULT_CHUNK_OPTIONS } from '../../src/core/chunking.js';

describe('chunkText option validation', () => {
  it('rejects non-positive or non-integer maxChars', () => {
    expect(() => chunkText('x', { maxChars: 0, overlapChars: 0 })).toThrow(RangeError);
    expect(() => chunkText('x', { maxChars: -5, overlapChars: 0 })).toThrow(RangeError);
    expect(() => chunkText('x', { maxChars: 1.5, overlapChars: 0 })).toThrow(/positive integer/);
  });

  it('rejects negative or non-integer overlap', () => {
    expect(() => chunkText('x', { maxChars: 10, overlapChars: -1 })).toThrow(RangeError);
    expect(() => chunkText('x', { maxChars: 10, overlapChars: 2.5 })).toThrow(
      /non-negative integer/,
    );
  });

  it('rejects overlap >= maxChars', () => {
    expect(() => chunkText('x', { maxChars: 10, overlapChars: 10 })).toThrow(/less than maxChars/);
  });
});

describe('chunkText behavior', () => {
  it('returns no chunks for blank text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n  \t ')).toEqual([]);
  });

  it('returns a single chunk when text fits', () => {
    const chunks = chunkText('hello world', { maxChars: 100, overlapChars: 10 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ ordinal: 0, text: 'hello world', metadata: {} });
  });

  it('normalizes CRLF before chunking', () => {
    const chunks = chunkText('a\r\nb', { maxChars: 100, overlapChars: 0 });
    expect(chunks[0]?.text).toBe('a\nb');
  });

  it('splits on a newline boundary in preference to a space', () => {
    const text = 'alpha beta\ngamma delta epsilon';
    const chunks = chunkText(text, { maxChars: 16, overlapChars: 0 });
    // First window [0,16) snaps back to the newline at index 10 (preferred over the space).
    expect(chunks.map((c) => c.text)).toEqual(['alpha beta', 'gamma delta', 'epsilon']);
  });

  it('splits on a space boundary when no newline is present', () => {
    const chunks = chunkText('alpha beta gamma', { maxChars: 12, overlapChars: 0 });
    expect(chunks[0]?.text).toBe('alpha beta');
    expect(chunks[1]?.text).toBe('gamma');
  });

  it('hard-cuts a long unbroken token (no boundary in window)', () => {
    const chunks = chunkText('abcdefghij', { maxChars: 4, overlapChars: 0 });
    expect(chunks.map((c) => c.text)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('carries overlap into the next chunk', () => {
    const chunks = chunkText('abcdefghij', { maxChars: 4, overlapChars: 2 });
    // windows: [0,4)=abcd, next start = 4-2 = 2 -> [2,6)=cdef, etc.
    expect(chunks[0]?.text).toBe('abcd');
    expect(chunks[1]?.text).toBe('cdef');
  });

  it('guarantees progress when a boundary lands at the chunk start', () => {
    // The only space is right after index 0; with large overlap, nextStart (= end - overlap)
    // lands <= start, so the fallback (start = end) must still advance.
    const chunks = chunkText('a bcdefgh', { maxChars: 4, overlapChars: 3 });
    expect(chunks.length).toBeGreaterThan(0);
    // No empty chunks, strictly increasing ordinals.
    expect(chunks.every((c) => c.text.length > 0)).toBe(true);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it('exposes usable defaults', () => {
    expect(DEFAULT_CHUNK_OPTIONS.maxChars).toBeGreaterThan(DEFAULT_CHUNK_OPTIONS.overlapChars);
    const big = 'word '.repeat(500).trim();
    const chunks = chunkText(big);
    expect(chunks.length).toBeGreaterThan(1);
  });
});
