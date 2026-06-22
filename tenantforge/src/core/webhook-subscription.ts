/**
 * Webhook subscription — the pure (I/O-free) half of managed outbound webhooks: the stored record
 * shape and the event-matching rule. A subscription dispatches an event only when its event-type
 * filter matches; the actual signing/HTTP/retry live in the imperative shell (adapters). Pairs with
 * `topic-webhooks` (per-subscription HMAC, SSRF defense).
 */

/** A stored webhook subscription. The signing secret is NOT here — it lives in the SecretStore. */
export interface WebhookSubscriptionRecord {
  /** Opaque subscription id (also the SecretStore key suffix). */
  id: string;
  /** Destination URL (https; SSRF-validated at create time). */
  url: string;
  /** Event-name allow-list; empty/absent = every event. */
  eventTypes: readonly string[];
  /** Whether the subscription receives events. */
  active: boolean;
  /** Creation instant (ISO-8601 UTC). */
  createdAt: string;
}

/** A subscription as returned to clients (never includes the secret). */
export interface WebhookSubscriptionSummary {
  id: string;
  url: string;
  eventTypes: readonly string[];
  active: boolean;
  createdAt: string;
}

/** The result of creating a subscription — the signing secret is shown ONCE here, then never again. */
export interface WebhookSubscriptionCreated {
  id: string;
  url: string;
  /** HMAC signing secret — shown once; store it in the receiver to verify our signatures. */
  secret: string;
  eventTypes: readonly string[];
  createdAt: string;
}

/** The SecretStore key under which a subscription's signing secret is stored. */
export function webhookSecretKey(id: string): string {
  return `webhook-sub:${id}`;
}

/**
 * Whether a subscription with the given event-type filter should receive `eventName`. An empty (or
 * absent) filter matches every event; otherwise the event name must be explicitly listed.
 *
 * @param eventTypes - The subscription's event-name allow-list (empty = all).
 * @param eventName - The emitted event's name.
 * @returns `true` if the event should be delivered to this subscription.
 */
export function subscriptionMatchesEvent(
  eventTypes: readonly string[],
  eventName: string,
): boolean {
  return eventTypes.length === 0 || eventTypes.includes(eventName);
}

/** Project a stored record to its client-safe summary (drops nothing sensitive — there's no secret). */
export function toWebhookSubscriptionSummary(
  record: WebhookSubscriptionRecord,
): WebhookSubscriptionSummary {
  return {
    id: record.id,
    url: record.url,
    eventTypes: record.eventTypes,
    active: record.active,
    createdAt: record.createdAt,
  };
}
