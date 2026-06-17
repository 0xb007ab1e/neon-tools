import { describe, expect, it } from 'vitest';
import { buildId, TENANTFORGE } from '../src/meta.js';

describe('meta', () => {
  it('exposes a stable tool id', () => {
    expect(TENANTFORGE.id).toBe('tenantforge');
  });

  it('builds an id@version string', () => {
    expect(buildId()).toBe(`tenantforge@${TENANTFORGE.version}`);
  });
});
