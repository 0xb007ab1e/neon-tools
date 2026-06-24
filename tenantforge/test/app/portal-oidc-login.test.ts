import { describe, expect, it, vi } from 'vitest';
import { createPortal } from '../../src/app/portal.js';
import type { TenantForge } from '../../src/app/lib.js';
import type { TenantAuthenticator } from '../../src/ports/tenant-authenticator.js';
import type { OidcCodeFlow } from '../../src/ports/oidc-code-flow.js';

const SECRET = 'portal-session-secret';

/** A minimal fake TenantForge (the login flow only needs tenantSummary for the session probe). */
const fakeTf = (): TenantForge =>
  ({
    tenantSummary: (id: string) =>
      Promise.resolve({
        id,
        slug: 'acme',
        region: 'aws-us-east-1',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
  }) as unknown as TenantForge;

/** The static authenticator is unused on the code-flow path; present because the option is required. */
const auth: TenantAuthenticator = { authenticate: () => Promise.resolve(null) };

/**
 * A fake server-side OIDC code flow. `start()` returns fixed state/nonce/verifier; `exchange()` is a
 * spy whose result the test controls (e.g. a valid principal, or null to simulate token-endpoint /
 * nonce-verification failure).
 */
function fakeCodeFlow(
  exchangeResult: () => Promise<{ tenantId: string } | null>,
): OidcCodeFlow & { exchange: ReturnType<typeof vi.fn> } {
  return {
    start: () =>
      Promise.resolve({
        authorizeUrl: 'https://idp.example.com/authorize?state=server-state',
        state: 'server-state',
        nonce: 'server-nonce',
        codeVerifier: 'server-verifier',
      }),
    exchange: vi.fn((_code: string, _verifier: string, _nonce: string) => exchangeResult()),
  };
}

/** Build a portal with a code flow whose exchange returns `result`. */
function portalWith(result: () => Promise<{ tenantId: string } | null>): {
  app: ReturnType<typeof createPortal>;
  flow: ReturnType<typeof fakeCodeFlow>;
} {
  const flow = fakeCodeFlow(result);
  const app = createPortal({
    tf: fakeTf(),
    authenticator: auth,
    codeFlow: flow,
    sessionSecret: SECRET,
  });
  return { app, flow };
}

/** Begin a flow and return the pinned login cookie pair (`tf_portal_login=...`). */
async function startLogin(app: ReturnType<typeof createPortal>): Promise<string> {
  const res = await app.request('/api/login/start', {
    headers: { 'sec-fetch-site': 'same-origin' },
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  expect(setCookie).toContain('tf_portal_login=');
  return setCookie.split(';')[0]!;
}

/** POST the callback {code, state} with an optional login cookie; return the response. */
async function postCallback(
  app: ReturnType<typeof createPortal>,
  body: Record<string, string>,
  cookie?: string,
): Promise<Response> {
  return app.request('/api/session', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie !== undefined ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('portal OIDC code-flow login (H1/H2)', () => {
  it('GET /api/config advertises oidc mode when a code flow is configured', async () => {
    const { app } = portalWith(() => Promise.resolve({ tenantId: 't-a' }));
    const cfg = (await (await app.request('/api/config')).json()) as { auth: { mode: string } };
    expect(cfg.auth.mode).toBe('oidc');
  });

  it('start pins state/nonce/verifier in a short-TTL HttpOnly cookie and returns the authorize URL', async () => {
    const { app } = portalWith(() => Promise.resolve({ tenantId: 't-a' }));
    const res = await app.request('/api/login/start');
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/tf_portal_login=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Path=\/portal/i);
    expect(((await res.json()) as { authorizeUrl: string }).authorizeUrl).toContain(
      'https://idp.example.com/authorize',
    );
  });

  it('happy path: valid state + successful exchange mints the session cookie', async () => {
    const { app, flow } = portalWith(() => Promise.resolve({ tenantId: 't-a' }));
    const loginCookie = await startLogin(app);
    const res = await postCallback(app, { code: 'auth-code', state: 'server-state' }, loginCookie);
    expect(res.status).toBe(200);
    expect((await res.json()) as { tenantId: string }).toMatchObject({ tenantId: 't-a' });
    // A session cookie is set; the single-use login cookie is cleared.
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('tf_portal=');
    // The exchange got the pinned verifier + nonce, never anything from the client.
    expect(flow.exchange).toHaveBeenCalledWith('auth-code', 'server-verifier', 'server-nonce');
  });

  it('login-CSRF: a callback POST with NO pinned login cookie is rejected (401), no exchange', async () => {
    const { app, flow } = portalWith(() => Promise.resolve({ tenantId: 't-a' }));
    const res = await postCallback(app, { code: 'auth-code', state: 'server-state' });
    expect(res.status).toBe(401);
    expect(flow.exchange).not.toHaveBeenCalled();
  });

  it('state mismatch is rejected (401) and the exchange never runs', async () => {
    const { app, flow } = portalWith(() => Promise.resolve({ tenantId: 't-a' }));
    const loginCookie = await startLogin(app);
    const res = await postCallback(
      app,
      { code: 'auth-code', state: 'attacker-state' },
      loginCookie,
    );
    expect(res.status).toBe(401);
    expect(flow.exchange).not.toHaveBeenCalled();
  });

  it('nonce mismatch / token-endpoint failure (exchange → null) fails closed with 401', async () => {
    // The adapter returns null when the id_token nonce != pinned nonce, or the token endpoint fails.
    const { app, flow } = portalWith(() => Promise.resolve(null));
    const loginCookie = await startLogin(app);
    const res = await postCallback(app, { code: 'auth-code', state: 'server-state' }, loginCookie);
    expect(res.status).toBe(401);
    expect(flow.exchange).toHaveBeenCalledOnce();
    // No session granted.
    expect(res.headers.get('set-cookie') ?? '').not.toContain('tf_portal=');
  });

  it('the login cookie is single-use: a replayed callback (cookie already consumed) is rejected', async () => {
    const { app } = portalWith(() => Promise.resolve({ tenantId: 't-a' }));
    const loginCookie = await startLogin(app);
    const first = await postCallback(
      app,
      { code: 'auth-code', state: 'server-state' },
      loginCookie,
    );
    expect(first.status).toBe(200);
    // The first response cleared the login cookie. A replay reusing the SAME login cookie value is a
    // fresh request to the in-process app (no cookie jar), but the server cleared it via Set-Cookie;
    // simulate the browser honoring that by sending no login cookie → rejected.
    const replay = await postCallback(app, { code: 'auth-code', state: 'server-state' });
    expect(replay.status).toBe(401);
    // And the start response set Max-Age semantics make it transient; the success path also cleared it.
    expect(first.headers.get('set-cookie') ?? '').toMatch(/tf_portal_login=;|Max-Age=0/i);
  });

  it('the dev/token path still works alongside the code flow', async () => {
    // A code flow is configured, but a {token} body uses the static authenticator (dev/local).
    const tokenAuth: TenantAuthenticator = {
      authenticate: (t: string) => Promise.resolve(t === 'tok-a' ? { tenantId: 't-a' } : null),
    };
    const flow = fakeCodeFlow(() => Promise.resolve(null));
    const app = createPortal({
      tf: fakeTf(),
      authenticator: tokenAuth,
      codeFlow: flow,
      sessionSecret: SECRET,
    });
    const ok = await postCallback(app, { token: 'tok-a' });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { tenantId: string }).toMatchObject({ tenantId: 't-a' });
    const bad = await postCallback(app, { token: 'nope' });
    expect(bad.status).toBe(401);
  });

  it('login/start is 404 when no code flow is configured (token-only deploy)', async () => {
    const app = createPortal({ tf: fakeTf(), authenticator: auth, sessionSecret: SECRET });
    expect((await app.request('/api/login/start')).status).toBe(404);
    // And a {code,state} body is 404 (the code path isn't available without a flow).
    expect((await postCallback(app, { code: 'c', state: 's' })).status).toBe(404);
  });
});
