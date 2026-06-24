/** The outcome of verifying a captcha token with the provider (no PII — safe to log/audit). */
export interface CaptchaResult {
  /** Whether the provider considers the challenge solved by a human. */
  success: boolean;
  /** The provider (e.g. `turnstile`, `hcaptcha`, `noop`). */
  provider: string;
  /** Provider error codes when `success` is false (for debugging; never user-facing). */
  errorCodes?: string[];
}

/**
 * Port: a **captcha verifier** (e.g. Cloudflare Turnstile / hCaptcha). The seam used to gate the
 * public signup against bots and automated card-testing *before* any cost-incurring downstream call
 * (email send, PSP setup-intent). The client widget produces a token; the server exchanges it with
 * the provider's siteverify endpoint here.
 *
 * Treat the provider as an untrusted, unreliable upstream (`topic-api-consumption`): the adapter sets
 * a timeout and **fails closed** — a transport error or timeout MUST yield `success: false` (never
 * throw-through to an open gate). Verify server-side every time; never trust a client-asserted pass.
 */
export interface CaptchaVerifier {
  /** A stable provider identifier for audit/reporting (e.g. `turnstile`). */
  readonly provider: string;
  /**
   * Verify a client-supplied captcha token. Fails closed on transport/timeout (returns
   * `success: false`, does not throw).
   *
   * @param token - The token from the client-side widget (untrusted input).
   * @param remoteIp - Optional caller IP to pass to the provider for additional signal.
   * @returns The verification result.
   */
  verify(token: string, remoteIp?: string): Promise<CaptchaResult>;
}
