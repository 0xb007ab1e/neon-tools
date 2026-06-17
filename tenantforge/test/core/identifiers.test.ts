import { describe, expect, it } from 'vitest';
import { assertSlug, isUuid, isValidSlug, normalizeSlug } from '../../src/core/identifiers.js';

describe('isUuid', () => {
  it('accepts canonical UUIDs (any case)', () => {
    expect(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
    expect(isUuid('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe(true);
  });

  it('rejects non-UUIDs', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('3f2504e0-4f89-41d3-9a0c')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});

describe('normalizeSlug', () => {
  it('trims and lowercases without altering invalid characters', () => {
    expect(normalizeSlug('  Acme-Co  ')).toBe('acme-co');
    expect(normalizeSlug('Bad_Slug')).toBe('bad_slug'); // underscore preserved → stays invalid
  });
});

describe('isValidSlug', () => {
  it('accepts well-formed, in-range, non-reserved slugs', () => {
    expect(isValidSlug('acme')).toBe(true);
    expect(isValidSlug('acme-co-42')).toBe(true);
  });

  it('rejects out-of-range lengths', () => {
    expect(isValidSlug('ab')).toBe(false); // too short
    expect(isValidSlug('a'.repeat(64))).toBe(false); // too long
  });

  it('rejects malformed slugs', () => {
    expect(isValidSlug('-acme')).toBe(false); // leading hyphen
    expect(isValidSlug('acme--co')).toBe(false); // double hyphen
    expect(isValidSlug('acme_co')).toBe(false); // underscore
  });

  it('rejects reserved names', () => {
    expect(isValidSlug('admin')).toBe(false);
    expect(isValidSlug('tenantforge')).toBe(false);
  });
});

describe('assertSlug', () => {
  it('returns the normalized slug when valid', () => {
    expect(assertSlug('  Acme-Co  ')).toBe('acme-co');
  });

  it('throws on an invalid slug', () => {
    expect(() => assertSlug('a')).toThrow(/invalid tenant slug/);
    expect(() => assertSlug('admin')).toThrow(/reserved/);
  });
});
