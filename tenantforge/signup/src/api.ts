// Typed client for the /signup/api/* endpoints. Same-origin, cookie-carried session (the signup
// session cookie is HttpOnly + set by the server); we never store anything in the browser.

const BASE = '/signup/api';

/** Public keys the SPA needs to render Stripe.js + the captcha widget. */
export interface SignupConfig {
  publishableKey: string;
  captchaSiteKey: string;
}

/** Funnel status returned by the poller (connectionUri present once, after activation). */
export interface SignupStatus {
  status: 'started' | 'email_verified' | 'payment_ready' | 'provisioning' | 'active' | 'failed';
  slug?: string;
  connectionUri?: string;
}

/** Chosen tenant config submitted at completion. */
export interface CompleteInput {
  slug: string;
  region?: string;
  residency?: 'us' | 'eu' | 'apac';
  planId?: string;
}

/** Throw the server's `{ error }` message (already safe/user-facing) on a non-2xx. */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  // 204 (e.g. verify-email) has no body: res.json() throws → body stays undefined (returned as void).
  let body: unknown = undefined;
  try {
    body = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) {
    const msg =
      body !== null && typeof body === 'object' && 'error' in body
        ? String(body.error)
        : `request failed (${res.status})`;
    throw new Error(msg);
  }
  return body as T;
}

export const api = {
  config: (): Promise<SignupConfig> => call('/config'),
  start: (email: string, captchaToken: string): Promise<{ ok: true }> =>
    call('/start', { method: 'POST', body: JSON.stringify({ email, captchaToken }) }),
  verifyEmail: (code: string): Promise<void> =>
    call('/verify-email', { method: 'POST', body: JSON.stringify({ code }) }),
  paymentIntent: (): Promise<{
    clientSecret: string;
    setupIntentId: string;
    publishableKey: string;
  }> => call('/payment-intent', { method: 'POST' }),
  complete: (input: CompleteInput): Promise<SignupStatus> =>
    call('/complete', { method: 'POST', body: JSON.stringify(input) }),
  status: (): Promise<SignupStatus> => call('/status'),
};
