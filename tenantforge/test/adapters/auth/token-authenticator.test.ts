import { describe, expect, it } from 'vitest';
import { createTokenAuthenticator } from '../../../src/adapters/auth/token-authenticator.js';
import type { HttpCredential } from '../../../src/ports/authenticator.js';

const creds: HttpCredential[] = [
  { id: 'alice', token: 'admin-token', role: 'admin' },
  { id: 'bob', token: 'readonly-token', role: 'readonly' },
];

describe('createTokenAuthenticator', () => {
  it('resolves a matching token to its principal (id + role)', async () => {
    const auth = createTokenAuthenticator(creds);
    expect(await auth.authenticate('admin-token')).toEqual({ id: 'alice', role: 'admin' });
    expect(await auth.authenticate('readonly-token')).toEqual({ id: 'bob', role: 'readonly' });
  });

  it('returns null for a wrong token', async () => {
    const auth = createTokenAuthenticator(creds);
    expect(await auth.authenticate('nope')).toBeNull();
  });

  it('returns null for an empty token (absent header)', async () => {
    const auth = createTokenAuthenticator(creds);
    expect(await auth.authenticate('')).toBeNull();
  });

  it('returns null when no credentials are configured', async () => {
    const auth = createTokenAuthenticator([]);
    expect(await auth.authenticate('anything')).toBeNull();
  });

  it('does not match on a length-differing token (constant-time compare guards length)', async () => {
    const auth = createTokenAuthenticator([{ id: 'a', token: 'short', role: 'admin' }]);
    expect(await auth.authenticate('a-much-longer-token')).toBeNull();
  });
});
