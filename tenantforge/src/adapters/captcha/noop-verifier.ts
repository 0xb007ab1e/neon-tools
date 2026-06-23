import type { CaptchaVerifier } from '../../ports/captcha-verifier.js';

/**
 * Create a **no-op** {@link CaptchaVerifier} that always passes. **Dev / tests only** — it provides no
 * bot protection. Selected when no captcha provider is configured; the signup sub-app must only mount
 * with this in non-production, and config validation should refuse a `noop` captcha in production.
 *
 * @returns A captcha verifier that returns `{ success: true }` for any input.
 */
export function createNoopCaptchaVerifier(): CaptchaVerifier {
  return {
    provider: 'noop',
    verify(): Promise<{ success: boolean; provider: string }> {
      return Promise.resolve({ success: true, provider: 'noop' });
    },
  };
}
