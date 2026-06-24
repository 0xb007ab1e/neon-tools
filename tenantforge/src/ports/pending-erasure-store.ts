/** Lifecycle of a scheduled, cancellable erasure request (the undo-window state machine). */
export type PendingErasureStatus = 'pending' | 'processing' | 'cancelled' | 'done';

/** A scheduled tenant-erasure request that the tenant may cancel until its window elapses. */
export interface PendingErasureRecord {
  /** Opaque request id (one in-flight request per tenant; a new request replaces a terminal one). */
  id: string;
  /** The tenant to erase (server-derived; never client-supplied). */
  tenantId: string;
  /** ISO-8601 instant the request was made (audit / undo-deadline display). */
  requestedAt: string;
  /** ISO-8601 instant after which the executor may run (request time + undo window). */
  executeAt: string;
  /** Current status — transitions are atomic, conditional updates (no cancel/execute race). */
  status: PendingErasureStatus;
  /** Audit reason carried into the erasure certificate (no secrets). */
  reason: string;
}

/**
 * Port: durable state for the **mandatory erasure undo window** (threat-model B8w / red-team F2). An
 * erasure is scheduled, **not executed synchronously**: a `pending` record is created and the tenant
 * **keeps serving** until the window elapses, when a scheduled executor runs the verified-erasure
 * engine — but only if it **wins an atomic conditional flip** to `processing`. The customer can cancel
 * (`pending → cancelled`) until then. Cancel and execute are the *same* atomic operation
 * ({@link claimForProcessing} / {@link cancel}) so a cancel that races the executor cannot lose data,
 * and an at-least-once redelivery of a non-`pending` record is a no-op (the executor acks and exits).
 *
 * The default adapter is in-memory (single-instance, single-threaded → the conditional flip is
 * atomic without an intervening await); a Postgres-backed adapter performs the flip as
 * `UPDATE … SET status='processing' WHERE id=? AND status='pending'` and checks the rowcount.
 */
export interface PendingErasureStore {
  /**
   * Create a `pending` erasure for `tenantId`, replacing any prior **terminal** (`cancelled`/`done`)
   * record for it. Rejects (returns `null`) when an **active** (`pending`/`processing`) erasure
   * already exists — one in-flight request per tenant.
   *
   * @param record - The pending record to create.
   * @returns The created record, or `null` when an active request already exists.
   */
  create(record: PendingErasureRecord): Promise<PendingErasureRecord | null>;

  /**
   * The active (`pending` or `processing`) erasure for `tenantId`, if any.
   *
   * @param tenantId - The tenant (server-derived).
   * @returns The active record, or `null`.
   */
  getActive(tenantId: string): Promise<PendingErasureRecord | null>;

  /**
   * Atomically flip `pending → cancelled` for this tenant's active request. Returns the cancelled
   * record only if it **won** the flip (the request was still `pending`); `null` if it was already
   * `processing`/`cancelled`/`done` (the executor won, or nothing pending) — the caller must treat
   * `null` as "cannot cancel".
   *
   * @param tenantId - The tenant (server-derived).
   * @param nowMs - Current epoch ms (unused by the memory adapter; for parity with timed backends).
   * @returns The cancelled record, or `null`.
   */
  cancel(tenantId: string, nowMs: number): Promise<PendingErasureRecord | null>;

  /**
   * Atomically flip `pending → processing` for `id` (the executor's claim). Returns the record only
   * if it **won** (it was still `pending`); `null` otherwise (a cancel won, or a redelivery — the
   * executor must then ack and exit without erasing). The single point that gates destruction.
   *
   * @param id - The request id.
   * @returns The claimed record, or `null`.
   */
  claimForProcessing(id: string): Promise<PendingErasureRecord | null>;

  /**
   * Mark a `processing` record `done` (the verified-erasure engine ran). Idempotent.
   *
   * @param id - The request id.
   */
  markDone(id: string): Promise<void>;

  /**
   * All records whose `executeAt` is at/before `nowMs` and still `pending` — the executor's work
   * queue (for a scheduled sweep / queue drain).
   *
   * @param nowMs - Current epoch ms.
   * @param limit - Max records to return.
   * @returns Due pending records.
   */
  listDue(nowMs: number, limit: number): Promise<PendingErasureRecord[]>;
}
