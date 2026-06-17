import { describe, expect, it } from 'vitest';
import { assertActivatable, isFullyEmbedded } from '../../src/core/reembed.js';

describe('isFullyEmbedded', () => {
  it('is true only when non-empty and fully covered', () => {
    expect(isFullyEmbedded({ total: 10, embedded: 10 })).toBe(true);
    expect(isFullyEmbedded({ total: 10, embedded: 11 })).toBe(true); // defensive >=
    expect(isFullyEmbedded({ total: 10, embedded: 9 })).toBe(false);
    expect(isFullyEmbedded({ total: 0, embedded: 0 })).toBe(false);
  });
});

describe('assertActivatable', () => {
  it('passes for a fully-embedded model', () => {
    expect(() => assertActivatable('m', { total: 5, embedded: 5 })).not.toThrow();
  });

  it('rejects an empty corpus', () => {
    expect(() => assertActivatable('m', { total: 0, embedded: 0 })).toThrow(/no chunks/);
  });

  it('rejects partial coverage with counts in the message', () => {
    expect(() => assertActivatable('big', { total: 10, embedded: 3 })).toThrow(/3\/10/);
  });
});
