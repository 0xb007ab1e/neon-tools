import type { WebhookSubscriptionRecord } from '../core/index.js';
import type { WebhookSubscriptionStore } from '../ports/webhook-subscription-store.js';

/** An in-memory {@link WebhookSubscriptionStore} (default / tests), plus a `clear` test helper. */
export interface InMemoryWebhookSubscriptionStore extends WebhookSubscriptionStore {
  /** Drop all stored subscriptions (test helper). */
  clear(): void;
}

/**
 * Create an in-memory {@link WebhookSubscriptionStore} — process-local, for dev / single-instance /
 * tests. Use the Postgres adapter for durable, multi-instance storage.
 *
 * @returns The in-memory store.
 */
export function createInMemoryWebhookSubscriptionStore(): InMemoryWebhookSubscriptionStore {
  const byId = new Map<string, WebhookSubscriptionRecord>();
  return {
    create(record: WebhookSubscriptionRecord): Promise<void> {
      byId.set(record.id, { ...record, eventTypes: [...record.eventTypes] });
      return Promise.resolve();
    },
    findById(id: string): Promise<WebhookSubscriptionRecord | null> {
      const r = byId.get(id);
      return Promise.resolve(r ? { ...r, eventTypes: [...r.eventTypes] } : null);
    },
    list(limit: number): Promise<WebhookSubscriptionRecord[]> {
      const rows = [...byId.values()]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, limit)
        .map((r) => ({ ...r, eventTypes: [...r.eventTypes] }));
      return Promise.resolve(rows);
    },
    delete(id: string): Promise<boolean> {
      return Promise.resolve(byId.delete(id));
    },
    clear(): void {
      byId.clear();
    },
  };
}
