import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/app/config.js';

/** Minimal valid env for the control plane (registry + Neon API + secret key). */
function baseEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://u:p@host/db?sslmode=require',
    NEON_API_KEY: 'neon_key',
    NEON_ORG_ID: 'org_1',
    TENANTFORGE_SECRET_KEY: 'a-sufficiently-long-secret-key',
    ...over,
  };
}

/** A 32-char value (the floor); anything shorter must be rejected. */
const LONG = 'x'.repeat(32);
/** A 31-char value (one below the floor). */
const SHORT = 'x'.repeat(31);

/**
 * Env-extras that make each session-signing secret's OTHER co-requirements satisfied, so a length
 * test isolates the entropy-floor rule (gap #8): the signup secret additionally requires Stripe +
 * captcha + notifier (fail-closed at config time).
 */
const signupCoReqs = {
  TENANTFORGE_PAYMENT_GATEWAY: 'stripe',
  STRIPE_SECRET_KEY: 'sk_test',
  STRIPE_PUBLISHABLE_KEY: 'pk_test',
  TENANTFORGE_CAPTCHA_PROVIDER: 'turnstile',
  TENANTFORGE_CAPTCHA_SECRET: 'cap_secret',
  TENANTFORGE_CAPTCHA_SITE_KEY: 'cap_site',
  TENANTFORGE_NOTIFIER: 'log',
};

describe('loadConfig — session-secret entropy floor (>= 32 chars; gap #8)', () => {
  // Each secret signs a session / CSRF / login cookie — a short HMAC key enables forgery.
  const cases = [
    {
      var: 'TENANTFORGE_DASHBOARD_SECRET',
      extra: {},
      get: (c: ReturnType<typeof loadConfig>) => c.dashboardSecret,
    },
    {
      var: 'TENANTFORGE_PORTAL_SECRET',
      extra: {},
      get: (c: ReturnType<typeof loadConfig>) => c.portalSecret,
    },
    {
      var: 'TENANTFORGE_SIGNUP_SECRET',
      extra: signupCoReqs,
      get: (c: ReturnType<typeof loadConfig>) => c.signupSecret,
    },
  ] as const;

  for (const tc of cases) {
    it(`rejects a <32 ${tc.var} with a per-var message`, () => {
      expect(() => loadConfig(baseEnv({ ...tc.extra, [tc.var]: SHORT }))).toThrow(
        new RegExp(`${tc.var} must be at least 32 chars`),
      );
    });

    it(`accepts a >=32 ${tc.var}`, () => {
      const config = loadConfig(baseEnv({ ...tc.extra, [tc.var]: LONG }));
      expect(tc.get(config)).toBe(LONG);
    });

    it(`allows ${tc.var} unset (the feature is simply disabled)`, () => {
      const config = loadConfig(baseEnv());
      expect(tc.get(config)).toBeUndefined();
    });
  }
});

describe('loadConfig — optional /metrics token (gap #17)', () => {
  it('omits metricsToken when TENANTFORGE_METRICS_TOKEN is unset (metrics stays unauthenticated)', () => {
    expect(loadConfig(baseEnv()).metricsToken).toBeUndefined();
  });

  it('surfaces metricsToken when set', () => {
    const config = loadConfig(baseEnv({ TENANTFORGE_METRICS_TOKEN: 'metrics-bearer-token' }));
    expect(config.metricsToken).toBe('metrics-bearer-token');
  });
});
