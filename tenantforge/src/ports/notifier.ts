/** A notification to deliver to a recipient (e.g. a billing receipt email). */
export interface Notification {
  /** The recipient address (e.g. an email). PII — never logged in audit context (master §5). */
  to: string;
  /** The subject line. */
  subject: string;
  /** The plain-text body (no secrets/PII beyond what the recipient already knows — `topic-notifications`). */
  body: string;
  /**
   * Idempotency key — a notifier (or the relay behind it) MUST de-duplicate on it so a retried /
   * at-least-once send never double-notifies (see {@link import('../core/receipts.js').receiptIdempotencyKey}).
   */
  idempotencyKey: string;
  /** Optional non-sensitive key/value metadata (e.g. `{ tenant_id }`). No secrets/PII. */
  metadata?: Record<string, string>;
}

/** The outcome of a notification send (no recipient/secret — safe to log/audit). */
export interface NotificationResult {
  /** The provider's message id (or the idempotency key when the provider returns none). */
  id: string;
  /** The provider that handled the send (e.g. `log`, `http`). */
  provider: string;
  /** `sent` (delivered to the provider) or `queued` (accepted for async delivery). */
  status: 'sent' | 'queued';
}

/**
 * Port: a **notifier** that delivers a {@link Notification} (e.g. a billing receipt). The single
 * seam the receipt feature depends on, so a provider can swap a log/audit sink for SMTP / SES /
 * SendGrid / a relay without touching the control plane (ports & adapters). Treat the provider as an
 * untrusted, unreliable upstream (`topic-api-consumption`): the caller sends **best-effort** and
 * never lets a notification failure break the billing operation it confirms.
 */
export interface Notifier {
  /** A stable provider identifier for audit/reporting (e.g. `log`, `http`). */
  readonly provider: string;
  /**
   * Deliver a notification. Idempotent on `notification.idempotencyKey`.
   *
   * @param notification - Recipient, subject, body, idempotency key.
   * @returns The send result (no recipient/secret).
   */
  notify(notification: Notification): Promise<NotificationResult>;
}
