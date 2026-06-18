import { describe, expect, it, beforeAll } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import { createOidcAuthenticator } from '../../../src/adapters/auth/oidc-authenticator.js';

const ISSUER = 'https://issuer.example.com';
const AUDIENCE = 'tenantforge';

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let rs: KeyPair;
let es: KeyPair;

beforeAll(async () => {
  rs = await generateKeyPair('RS256');
  es = await generateKeyPair('ES256');
});

/** Sign a JWT with the RS256 test key, applying the given builder tweaks. */
function signRs(
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

describe('createOidcAuthenticator', () => {
  it('resolves a valid JWT to its principal (sub + role)', async () => {
    const auth = createOidcAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: rs.publicKey,
    });
    const token = await signRs({ role: 'admin' }, (b) => b.setSubject('alice'));
    expect(await auth.authenticate(token)).toEqual({ id: 'alice', role: 'admin' });
  });

  it('accepts the readonly role', async () => {
    const auth = createOidcAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: rs.publicKey,
    });
    const token = await signRs({ role: 'readonly' }, (b) => b.setSubject('bob'));
    expect(await auth.authenticate(token)).toEqual({ id: 'bob', role: 'readonly' });
  });

  it('returns null for an empty token (absent header)', async () => {
    const auth = createOidcAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: rs.publicKey,
    });
    expect(await auth.authenticate('')).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const auth = createOidcAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: rs.publicKey,
    });
    const token = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('alice')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('-1h')
      .sign(rs.privateKey);
    expect(await auth.authenticate(token)).toBeNull();
  });

  it('returns null for a wrong audience', async () => {
    const auth = createOidcAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: rs.publicKey,
    });
    const token = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('alice')
      .setIssuer(ISSUER)
      .setAudience('someone-else')
      .setExpirationTime('2h')
      .sign(rs.privateKey);
    expect(await auth.authenticate(token)).toBeNull();
  });

  it('returns null for a wrong issuer', async () => {
    const auth = createOidcAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: rs.publicKey,
    });
    const token = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('alice')
      .setIssuer('https://evil.example.com')
      .setAudience(AUDIENCE)
      .setExpirationTime('2h')
      .sign(rs.privateKey);
    expect(await auth.authenticate(token)).toBeNull();
  });

  it('returns null when the signing key does not match', async () => {
    const auth = createOidcAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: rs.publicKey,
    });
    const { privateKey: otherKey } = await generateKeyPair('RS256');
    const token = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('alice')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('2h')
      .sign(otherKey);
    expect(await auth.authenticate(token)).toBeNull();
  });

  it('rejects an algorithm outside the allow-list', async () => {
    // Only RS256 allowed, but the token is signed ES256 → rejected (alg-confusion defense).
    const auth = createOidcAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: es.publicKey,
      algorithms: ['RS256'],
    });
    const token = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject('alice')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('2h')
      .sign(es.privateKey);
    expect(await auth.authenticate(token)).toBeNull();
  });

  it('returns null when sub is missing', async () => {
    const auth = createOidcAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: rs.publicKey,
    });
    const token = await signRs({ role: 'admin' }); // no setSubject
    expect(await auth.authenticate(token)).toBeNull();
  });

  it('returns null when sub is empty', async () => {
    const auth = createOidcAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: rs.publicKey,
    });
    const token = await signRs({ role: 'admin' }, (b) => b.setSubject(''));
    expect(await auth.authenticate(token)).toBeNull();
  });

  it('returns null when sub is not a string', async () => {
    const auth = createOidcAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: rs.publicKey,
    });
    const token = await signRs({ sub: 123, role: 'admin' });
    expect(await auth.authenticate(token)).toBeNull();
  });

  it('returns null for an invalid role value', async () => {
    const auth = createOidcAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: rs.publicKey,
    });
    const token = await signRs({ role: 'superuser' }, (b) => b.setSubject('alice'));
    expect(await auth.authenticate(token)).toBeNull();
  });

  it('reads id + role from custom claims', async () => {
    const auth = createOidcAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: rs.publicKey,
      subjectClaim: 'uid',
      roleClaim: 'perm',
    });
    const token = await signRs({ uid: 'carol', perm: 'readonly' });
    expect(await auth.authenticate(token)).toEqual({ id: 'carol', role: 'readonly' });
  });

  it('verifies via a key-resolver function (JWTVerifyGetKey)', async () => {
    // `keys` may be a resolver function (as createRemoteJWKSet returns) — exercise that branch.
    const auth = createOidcAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: () => Promise.resolve(rs.publicKey),
    });
    const token = await signRs({ role: 'admin' }, (b) => b.setSubject('dave'));
    expect(await auth.authenticate(token)).toEqual({ id: 'dave', role: 'admin' });
  });

  it('builds a remote JWKS set from jwksUri when no keys are given', () => {
    const auth = createOidcAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri: 'https://issuer.example.com/.well-known/jwks.json',
    });
    expect(typeof auth.authenticate).toBe('function');
  });

  it('throws when neither keys nor jwksUri is provided', () => {
    expect(() => createOidcAuthenticator({ issuer: ISSUER, audience: AUDIENCE })).toThrow(
      /jwksUri or keys is required/,
    );
  });
});
