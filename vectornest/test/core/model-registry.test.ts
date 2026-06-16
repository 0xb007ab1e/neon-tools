import { describe, expect, it } from 'vitest';
import { knownDimension, parseModelName } from '../../src/core/model-registry.js';

describe('parseModelName', () => {
  it('splits a valid provider/model name', () => {
    expect(parseModelName('openai/text-embedding-3-small')).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
    });
  });

  it('keeps only the first slash as the separator', () => {
    expect(parseModelName('vendor/family/variant')).toEqual({
      provider: 'vendor',
      model: 'family/variant',
    });
  });

  it('rejects names without a usable separator', () => {
    expect(() => parseModelName('noslash')).toThrow(RangeError);
    expect(() => parseModelName('/leading')).toThrow(/provider\/model/);
    expect(() => parseModelName('trailing/')).toThrow(/provider\/model/);
  });
});

describe('knownDimension', () => {
  it('returns the dimension for a known model', () => {
    expect(knownDimension('openai/text-embedding-3-small')).toBe(1536);
    expect(knownDimension('openai/text-embedding-3-large')).toBe(3072);
  });

  it('returns undefined for an unknown model', () => {
    expect(knownDimension('acme/unknown-embed')).toBeUndefined();
  });
});
