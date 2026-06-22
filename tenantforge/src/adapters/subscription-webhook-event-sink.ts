import type { TenantEvent } from '../core/index.js';
import { subscriptionMatchesEvent, webhookSecretKey } from '../core/index.js';
import type { EventSink } from '../ports/event-sink.js';
import type { SecretStore } from '../ports/secret-store.js';
import type { WebhookSubscriptionStore } from '../ports/webhook-subscription-store.js';
import { createWebhookEventSink } from './webhook-event-sink.js';

/** Options for {@link createSubscriptionWebhookEventSink}. */
export interface SubscriptionWebhookEventSinkOptions {
  /** Where active subscriptions are read from. */
  store: WebhookSubscriptionStore;
  /** Where each subscription's signing secret lives (keyed `webhook-sub:<id>`). */
  secretStore: SecretStore;
  /** Permit non-https subscription URLs (local/testing only). */
  allowInsecureUrl?: boolean;
  /** Max subscriptions considered per event. */
  maxSubscriptions?: number;
  /** Injectable fetch (testing). */
  fetchImpl?: typeof fetch;
  /** Dead-letter hook: called when delivery to a subscription fails (per subscription). */
  onError?: (event: TenantEvent, error: string) => void;
}

/**
 * An {@link EventSink} that fans every event out to all **matching active webhook subscriptions**,
 * each signed with its own secret (loaded from the SecretStore) via {@link createWebhookEventSink}.
 * `emit` is fire-and-forget (best-effort; never blocks or throws into the caller — master §5 obs).
 * Each subscription is delivered independently so one bad endpoint can't block the others.
 *
 * Note: this reads all subscriptions + their secrets per event. Fine for a control plane's modest
 * event rate; cache the subscription list if that ever changes.
 *
 * @param opts - The subscription + secret stores and delivery options.
 * @returns An event sink to add to the fan-out.
 */
export function createSubscriptionWebhookEventSink(
  opts: SubscriptionWebhookEventSinkOptions,
): EventSink {
  const limit = opts.maxSubscriptions ?? 200;

  const dispatch = async (event: TenantEvent): Promise<void> => {
    const subscriptions = await opts.store.list(limit);
    for (const sub of subscriptions) {
      if (!sub.active || !subscriptionMatchesEvent(sub.eventTypes, event.event)) continue;
      try {
        const secret = await opts.secretStore.get(webhookSecretKey(sub.id));
        if (secret === null) continue; // no secret on file → never sign with nothing; skip
        const sink = createWebhookEventSink({
          url: sub.url,
          secret,
          ...(opts.allowInsecureUrl === true ? { allowInsecureUrl: true } : {}),
          ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
        });
        await sink.deliver(event); // already filtered above; deliver does the signed POST + retries
      } catch (error) {
        opts.onError?.(event, error instanceof Error ? error.message : String(error));
      }
    }
  };

  return {
    emit(event: TenantEvent): void {
      void dispatch(event).catch((error) =>
        opts.onError?.(event, error instanceof Error ? error.message : String(error)),
      );
    },
  };
}
