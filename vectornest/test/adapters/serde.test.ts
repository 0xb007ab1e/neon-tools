import { describe, expect, it } from 'vitest';
import { formatVector, parseVector } from '../../src/adapters/neon-pg/serde.js';

describe('formatVector', () => {
  it('formats a vector as a pgvector literal', () => {
    expect(formatVector([1, 2, 3])).toBe('[1,2,3]');
    expect(formatVector([])).toBe('[]');
    expect(formatVector([0.5, -1.25])).toBe('[0.5,-1.25]');
  });
});

describe('parseVector', () => {
  it('round-trips with formatVector', () => {
    expect(parseVector(formatVector([1, 2.5, -3]))).toEqual([1, 2.5, -3]);
  });

  it('parses an empty vector', () => {
    expect(parseVector('[]')).toEqual([]);
    expect(parseVector('[  ]')).toEqual([]);
  });

  it('rejects a malformed literal', () => {
    expect(() => parseVector('1,2,3')).toThrow(/invalid pgvector literal/);
    expect(() => parseVector('[1,2,3')).toThrow(/invalid pgvector literal/);
  });

  it('rejects a non-numeric component', () => {
    expect(() => parseVector('[1,foo,3]')).toThrow(/invalid vector component/);
  });
});
