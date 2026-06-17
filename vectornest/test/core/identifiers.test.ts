import { describe, expect, it } from 'vitest';
import { isUuid } from '../../src/core/identifiers.js';

describe('isUuid', () => {
  it('accepts canonical UUIDs (any case)', () => {
    expect(isUuid('5b15ec54-40f1-4d83-8e66-021167917192')).toBe(true);
    expect(isUuid('5B15EC54-40F1-4D83-8E66-021167917192')).toBe(true);
  });

  it('rejects non-UUIDs and injection attempts', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid("5b15ec54-40f1-4d83-8e66-021167917192'; DROP TABLE vn_embeddings;--")).toBe(
      false,
    );
    expect(isUuid('5b15ec54-40f1-4d83-8e66-02116791719')).toBe(false); // too short
  });
});
