/** A stored HTTP response, replayed verbatim when an idempotent request is retried. */
export interface IdempotentResponse {
  /** HTTP status code of the original response. */
  status: number;
  /** Response body (serialized). */
  body: string;
  /** Original `Content-Type` so the replay is byte-faithful. */
  contentType: string;
}

/** The outcome of reserving an idempotency key for a request. */
export type IdempotencyBegin =
  | { outcome: 'new' } // first time for this key — caller executes, then calls `complete`
  | { outcome: 'replay'; response: IdempotentResponse } // already completed — replay the response
  | { outcome: 'in_flight' } // reserved but not yet completed — a concurrent retry is mid-flight
  | { outcome: 'mismatch' }; // key reused with a different request fingerprint (client error)

/**
 * Port: a store for HTTP idempotency keys, so a client may safely retry a mutating request and
 * receive the **original** result instead of re-executing it (topic-api-design idempotency keys,
 * topic-reliability). The default adapter is in-memory (per-instance); a Postgres-backed adapter
 * shares records across instances so a retry that lands on a different replica still de-duplicates.
 *
 * The retention/expiry *policy* lives with the store (a key older than the TTL is treated as new).
 */
export interface IdempotencyStore {
  /**
   * Atomically reserve `key` for a request with `fingerprint`, or report the existing record's
   * state. A `new` outcome inserts an in-flight reservation; the caller MUST then call
   * {@link IdempotencyStore.complete}. An expired record is replaced and reported as `new`.
   *
   * @param key - The idempotency key (already namespaced by principal).
   * @param fingerprint - A hash of the request (method + path + body) to detect key reuse.
   * @param nowMs - Current time in epoch ms (injected for determinism/testing).
   * @returns The reservation outcome.
   */
  begin(key: string, fingerprint: string, nowMs: number): Promise<IdempotencyBegin>;

  /**
   * Store the final response for a previously-reserved key, so subsequent retries replay it.
   *
   * @param key - The idempotency key reserved by {@link IdempotencyStore.begin}.
   * @param response - The response to replay on retry.
   * @param nowMs - Current time in epoch ms.
   */
  complete(key: string, response: IdempotentResponse, nowMs: number): Promise<void>;
}
