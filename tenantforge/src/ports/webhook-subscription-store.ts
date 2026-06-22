import type { WebhookSubscriptionRecord } from '../core/index.js';

/**
 * Port: persistence for managed outbound **webhook subscriptions** (metadata only — the per-
 * subscription signing secret lives in the SecretStore, not here). Create + list + delete.
 */
export interface WebhookSubscriptionStore {
  /**
   * Persist a new subscription.
   *
   * @param record - The subscription (id, url, event filter, active, createdAt).
   */
  create(record: WebhookSubscriptionRecord): Promise<void>;

  /**
   * Look up a subscription by id.
   *
   * @param id - The subscription id.
   * @returns The record, or `null` when unknown.
   */
  findById(id: string): Promise<WebhookSubscriptionRecord | null>;

  /**
   * List subscriptions, newest-first, capped at `limit`.
   *
   * @param limit - Max rows.
   * @returns The records (most-recent first).
   */
  list(limit: number): Promise<WebhookSubscriptionRecord[]>;

  /**
   * Delete a subscription by id.
   *
   * @param id - The subscription id.
   * @returns `true` if a row was removed, `false` if none matched.
   */
  delete(id: string): Promise<boolean>;
}
