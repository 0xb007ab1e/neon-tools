import { describe, expect, it } from 'vitest';
import { createTokenTenantAuthenticator } from '../../src/adapters/auth/tenant-token-authenticator.js';

describe('createTokenTenantAuthenticator', () => {
  const auth = createTokenTenantAuthenticator([
    { tenantId: 't-a', token: 'tok-a' },
    { tenantId: 't-b', token: 'tok-b' },
  ]);

  it('resolves a known token to exactly its tenant', async () => {
    expect(await auth.authenticate('tok-a')).toEqual({ tenantId: 't-a' });
    expect(await auth.authenticate('tok-b')).toEqual({ tenantId: 't-b' });
  });

  it('returns null for an unknown or empty token (fail closed)', async () => {
    expect(await auth.authenticate('nope')).toBeNull();
    expect(await auth.authenticate('')).toBeNull();
  });

  it('does not match across tenants (tenant A token never resolves to tenant B)', async () => {
    const principal = await auth.authenticate('tok-a');
    expect(principal?.tenantId).toBe('t-a');
    expect(principal?.tenantId).not.toBe('t-b');
  });
});
