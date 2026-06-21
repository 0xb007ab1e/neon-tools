import { describe, expect, it, beforeAll } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import { createOidcTenantAuthenticator } from '../../../src/adapters/auth/oidc-tenant-authenticator.js';

const ISSUER = 'https://idp.example.com';
const AUDIENCE = 'tenantforge-portal';

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let rs: KeyPair;
let other: KeyPair;

beforeAll(async () => {
  rs = await generateKeyPair('RS256');
  other = await generateKeyPair('RS256');
});

/** Sign a portal JWT with the RS256 test key, applying the given builder tweaks. */
function sign(
  payload: Record<string, unknown>,
  tweak: (b: SignJWT) => SignJWT = (b) => b,
): Promise<string> {
  const builder = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('2h');
  return tweak(builder).sign(rs.privateKey);
}

const auth = (): ReturnType<typeof createOidcTenantAuthenticator> =>
  createOidcTenantAuthenticator({ issuer: ISSUER, audience: AUDIENCE, keys: rs.publicKey });

describe('createOidcTenantAuthenticator', () => {
  it('resolves a valid JWT to the tenant in the `tenant` claim', async () => {
    const token = await sign({ tenant: 't-acme' });
    expect(await auth().authenticate(token)).toEqual({ tenantId: 't-acme' });
  });

  it('reads a custom tenant claim when configured', async () => {
    const a = createOidcTenantAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: rs.publicKey,
      tenantClaim: 'tid',
    });
    const token = await sign({ tid: 't-beta', tenant: 't-WRONG' });
    expect(await a.authenticate(token)).toEqual({ tenantId: 't-beta' });
  });

  it('returns null for an empty token, or a missing/empty tenant claim (fail closed)', async () => {
    expect(await auth().authenticate('')).toBeNull();
    expect(await auth().authenticate(await sign({}))).toBeNull();
    expect(await auth().authenticate(await sign({ tenant: '' }))).toBeNull();
  });

  it('rejects a token signed by a different key (bad signature)', async () => {
    const forged = await new SignJWT({ tenant: 't-acme' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('2h')
      .sign(other.privateKey);
    expect(await auth().authenticate(forged)).toBeNull();
  });

  it('rejects a wrong issuer / audience / expired token', async () => {
    const wrongIss = await sign({ tenant: 't' }, (b) => b.setIssuer('https://evil.example.com'));
    expect(await auth().authenticate(wrongIss)).toBeNull();
    const wrongAud = await sign({ tenant: 't' }, (b) => b.setAudience('someone-else'));
    expect(await auth().authenticate(wrongAud)).toBeNull();
    const expired = await sign({ tenant: 't' }, (b) => b.setExpirationTime('-1h'));
    expect(await auth().authenticate(expired)).toBeNull();
  });

  it('rejects an HS256 token (alg-confusion defence — only asymmetric algs accepted)', async () => {
    const hs = await new SignJWT({ tenant: 't' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('2h')
      .sign(new Uint8Array(32));
    expect(await auth().authenticate(hs)).toBeNull();
  });
});
