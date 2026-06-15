import { describe, expect, it } from 'vitest';
import { VECTORNEST, buildId } from '../src/meta.js';

describe('VECTORNEST metadata', () => {
  it('exposes a stable id and version', () => {
    expect(VECTORNEST.id).toBe('vectornest');
    expect(VECTORNEST.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('formats a build id as id@version', () => {
    expect(buildId()).toBe('vectornest@0.0.0');
  });
});
