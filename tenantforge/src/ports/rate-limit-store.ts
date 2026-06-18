/** The result of recording a request against a fixed-window counter. */
export interface RateLimitHit {
  /** Requests counted in the current window for the key (including this one). */
  count: number;
  /** Epoch-ms start of the current fixed window (aligned to `windowMs`). */
  windowStartMs: number;
}

/**
 * Port: a per-key fixed-window request counter for HTTP rate limiting.
 *
 * The default adapter is in-memory (per-instance); a Postgres-backed adapter shares the count across
 * instances so the limit is global (threat-model R2). The limit/window *policy* lives in the HTTP
 * layer — the store only counts hits within the aligned window.
 */
export interface RateLimitStore {
  /**
   * Record one request for `key` in the fixed window of length `windowMs` containing `nowMs`, and
   * return the resulting count + the window's start. Windows are aligned to `floor(nowMs/windowMs)`
   * so every instance agrees on the boundary.
   *
   * @param key - The rate-limit key (e.g. the authenticated principal id).
   * @param windowMs - Window length in ms.
   * @param nowMs - Current time in epoch ms (injected for determinism/testing).
   * @returns The current count and window start.
   */
  increment(key: string, windowMs: number, nowMs: number): Promise<RateLimitHit>;
}
