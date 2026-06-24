import { z } from 'zod';
import type { CaptchaResult, CaptchaVerifier } from '../../ports/captcha-verifier.js';

/** Cloudflare Turnstile siteverify response (the fields we use). */
const SiteverifySchema = z.object({
  success: z.boolean(),
  'error-codes': z.array(z.string()).optional(),
});

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Options for {@link createTurnstileVerifier}. */
export interface TurnstileVerifierOptions {
  /**
   * Turnstile **secret key** — a secret from the secret manager / env, never committed or logged
   * (`workflow-secrets`). (The matching *site* key is public and ships to the browser widget.)
   */
  secretKey: string;
  /** Siteverify URL. Defaults to Cloudflare's; override for a mock. */
  url?: string;
  /** Per-request timeout in ms. Defaults to 5000 (a captcha check must not stall the request). */
  timeoutMs?: number;
  /** Injectable fetch (for testing). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Create a {@link CaptchaVerifier} backed by **Cloudflare Turnstile**. Exchanges the client widget's
 * token with Turnstile's siteverify endpoint. **Fails closed**: any transport error, timeout, non-2xx,
 * or unparseable body yields `{ success: false }` (never an open gate) — so a Turnstile outage cannot
 * be used to bypass the bot/abuse check on the public signup. The secret key is never logged.
 *
 * @param options - Turnstile secret key + optional url / timeout / fetch.
 * @returns A Turnstile-backed captcha verifier.
 */
export function createTurnstileVerifier(options: TurnstileVerifierOptions): CaptchaVerifier {
  const url = options.url ?? SITEVERIFY_URL;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  return {
    provider: 'turnstile',
    async verify(token: string, remoteIp?: string): Promise<CaptchaResult> {
      if (token === '')
        return { success: false, provider: 'turnstile', errorCodes: ['missing-input'] };
      const body = new URLSearchParams({ secret: options.secretKey, response: token });
      if (remoteIp !== undefined) body.set('remoteip', remoteIp);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal: controller.signal,
        });
        if (!res.ok)
          return { success: false, provider: 'turnstile', errorCodes: [`http-${res.status}`] };
        const parsed = SiteverifySchema.safeParse(await res.json());
        if (!parsed.success)
          return { success: false, provider: 'turnstile', errorCodes: ['bad-response'] };
        return {
          success: parsed.data.success,
          provider: 'turnstile',
          ...(parsed.data['error-codes'] !== undefined
            ? { errorCodes: parsed.data['error-codes'] }
            : {}),
        };
      } catch {
        // Transport error / timeout / abort — fail closed (no open gate on a captcha outage).
        return { success: false, provider: 'turnstile', errorCodes: ['transport-error'] };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
