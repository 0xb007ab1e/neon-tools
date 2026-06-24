import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import { createOidcCodeFlow } from '../../../src/adapters/auth/oidc-code-flow.js';

const ISSUER = 'https://idp.example.com';
const AUDIENCE = 'tenantforge-portal';
const AUTHORIZE_URL = 'https://idp.example.com/authorize';
const TOKEN_URL = 'https://idp.example.com/token';
const REDIRECT_URI = 'https://portal.example.com/portal/';

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let rs: KeyPair;
let other: KeyPair;

beforeAll(async () => {
  rs = await generateKeyPair('RS256');
  other = await generateKeyPair('RS256');
});

/** Sign an id_token with the RS256 test key (issuer/audience preset; tweakable). */
function signIdToken(
  payload: Record<string, unknown>,
  tweak: (b: SignJWT) => SignJWT = (b) => b,
  key = rs.privateKey,
): Promise<string> {
  const builder = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('2h');
  return tweak(builder).sign(key);
}

/** A fetch stub returning a 200 token-endpoint response carrying the given id_token. */
function tokenOk(idToken: string): typeof fetch {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ id_token: idToken, token_type: 'Bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

/** Build a code flow with an injected fetch + public verify key (allowInsecure off — URLs are https). */
function flow(
  fetchImpl: typeof fetch,
  opts: Partial<Parameters<typeof createOidcCodeFlow>[0]> = {},
) {
  return createOidcCodeFlow({
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: TOKEN_URL,
    issuer: ISSUER,
    audience: AUDIENCE,
    clientId: AUDIENCE,
    redirectUri: REDIRECT_URI,
    keys: rs.publicKey,
    fetchImpl,
    randomString: (n) => `r${n}`, // deterministic for assertions
    ...opts,
  });
}

describe('createOidcCodeFlow.start', () => {
  it('builds an authorize URL with response_type=code, S256 challenge, state + nonce', async () => {
    const started = await flow(tokenOk('x')).start();
    const url = new URL(started.authorizeUrl);
    expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(AUDIENCE);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(started.state);
    expect(url.searchParams.get('nonce')).toBe(started.nonce);
    // The challenge is present and is NOT the raw verifier (it's the S256 hash).
    const challenge = url.searchParams.get('code_challenge');
    expect(challenge).toBeTruthy();
    expect(challenge).not.toBe(started.codeVerifier);
  });
});

describe('createOidcCodeFlow.exchange', () => {
  it('happy path: exchanges the code and returns the tenant when the nonce matches', async () => {
    const idToken = await signIdToken({ tenant: 't-acme', nonce: 'N1' });
    const f = tokenOk(idToken);
    const principal = await flow(f).exchange('the-code', 'the-verifier', 'N1');
    expect(principal).toEqual({ tenantId: 't-acme' });
    // The token endpoint was called with the authorization_code grant + PKCE verifier.
    const body = (f as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![1] as RequestInit;
    const params = new URLSearchParams(body.body as string);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('the-code');
    expect(params.get('code_verifier')).toBe('the-verifier');
  });

  it('rejects when the id_token nonce does not match the pinned nonce (replay defence)', async () => {
    const idToken = await signIdToken({ tenant: 't-acme', nonce: 'ATTACKER' });
    expect(await flow(tokenOk(idToken)).exchange('c', 'v', 'EXPECTED')).toBeNull();
  });

  it('rejects an id_token with no nonce claim', async () => {
    const idToken = await signIdToken({ tenant: 't-acme' });
    expect(await flow(tokenOk(idToken)).exchange('c', 'v', 'N1')).toBeNull();
  });

  it('rejects a token signed by the wrong key (bad signature)', async () => {
    const forged = await signIdToken({ tenant: 't', nonce: 'N1' }, (b) => b, other.privateKey);
    expect(await flow(tokenOk(forged)).exchange('c', 'v', 'N1')).toBeNull();
  });

  it('rejects when the tenant claim is missing/empty even with a valid nonce', async () => {
    const idToken = await signIdToken({ nonce: 'N1' });
    expect(await flow(tokenOk(idToken)).exchange('c', 'v', 'N1')).toBeNull();
  });

  it('fails closed on a 4xx from the token endpoint (and does not retry)', async () => {
    const f = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })),
    ) as unknown as typeof fetch;
    expect(await flow(f).exchange('c', 'v', 'N1')).toBeNull();
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  it('retries a transport error within the cap, then fails closed', async () => {
    const f = vi.fn(() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch;
    expect(await flow(f, { maxAttempts: 2 }).exchange('c', 'v', 'N1')).toBeNull();
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
  });

  it('fails closed on an unparseable / schema-invalid token response', async () => {
    const f = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ token_type: 'Bearer' }), { status: 200 })),
    ) as unknown as typeof fetch; // no id_token → schema rejects
    expect(await flow(f).exchange('c', 'v', 'N1')).toBeNull();
  });

  it('sends HTTP Basic auth for a confidential client (client secret)', async () => {
    const idToken = await signIdToken({ tenant: 't-acme', nonce: 'N1' });
    const f = tokenOk(idToken);
    await flow(f, { clientSecret: 'shhh' }).exchange('c', 'v', 'N1');
    const init = (f as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from(`${AUDIENCE}:shhh`).toString('base64')}`;
    expect(headers.authorization).toBe(expected);
  });

  it('returns null for empty inputs (fail closed, no network call)', async () => {
    const f = tokenOk('x');
    expect(await flow(f).exchange('', 'v', 'N1')).toBeNull();
    expect(await flow(f).exchange('c', '', 'N1')).toBeNull();
    expect(await flow(f).exchange('c', 'v', '')).toBeNull();
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });
});
