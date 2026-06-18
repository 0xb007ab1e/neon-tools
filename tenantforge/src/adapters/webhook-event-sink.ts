import { createHmac } from 'node:crypto';
import type { TenantEvent } from '../core/observability.js';
import type { EventSink } from '../ports/event-sink.js';

/** The outcome of attempting to deliver one event to the webhook endpoint. */
export interface WebhookDeliveryOutcome {
  /** Whether the endpoint acknowledged with a 2xx. */
  delivered: boolean;
  /** Number of POST attempts made (0 when the event was filtered out). */
  attempts: number;
  /** Last HTTP status seen, when a response was received. */
  status?: number;
  /** True when the event was skipped by the `eventTypes` allow-list (not sent). */
  skipped?: boolean;
}

/** An {@link EventSink} that signs and POSTs events to a webhook, with bounded retries. */
export interface WebhookEventSink extends EventSink {
  /**
   * Deliver one event now (sign → POST, retrying with backoff+jitter up to `maxAttempts`); resolves
   * with the outcome and never rejects. `emit` fire-and-forgets this (best-effort, non-blocking).
   */
  deliver(event: TenantEvent): Promise<WebhookDeliveryOutcome>;
}

/** Options for {@link createWebhookEventSink}. */
export interface WebhookEventSinkOptions {
  /** Destination URL. Must be `https` unless `allowInsecureUrl` is set. */
  url: string;
  /** HMAC-SHA256 signing key (a secret — never logged). */
  secret: string;
  /** Only send these event names (allow-list). Omitted = send all. */
  eventTypes?: readonly string[];
  /** Max POST attempts per event. Defaults to 3. */
  maxAttempts?: number;
  /** Base backoff in ms (doubled per retry, then jittered). Defaults to 200. */
  backoffMs?: number;
  /** Per-attempt timeout in ms. Defaults to 10000. */
  timeoutMs?: number;
  /** Permit a non-`https` URL (e.g. a localhost receiver in tests). Defaults to false. */
  allowInsecureUrl?: boolean;
  /** Called when delivery is abandoned after the last attempt (a dead-letter hook). */
  onError?: (event: TenantEvent, error: string) => void;
  /** Injectable fetch (testing). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable ms clock for the signed timestamp (testing). Defaults to `() => Date.now()`. */
  now?: () => number;
  /** Injectable backoff sleep (testing). Defaults to a real `setTimeout` delay. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter factor in [0,1) (testing). Defaults to `Math.random`. */
  jitter?: () => number;
}

/**
 * Create a {@link WebhookEventSink} that delivers control-plane lifecycle events to an
 * operator-configured endpoint — so external systems (billing, CRM, alerting) learn about
 * provision / transition / erase as they happen (topic-webhooks, topic-notifications). Compose it
 * alongside the JSON / metrics sinks via {@link import('./event-sink.js').createFanOutEventSink}.
 *
 * Each delivery is **signed** (`X-TenantForge-Signature: sha256=<hmac>` over `"{timestamp}.{body}"`,
 * plus `X-TenantForge-Timestamp` for replay defence) and **does not follow redirects** (`redirect:
 * 'error'` — SSRF defence). The URL must be `https` (unless `allowInsecureUrl`); construction throws
 * on a bad scheme (fail fast). Failed attempts retry with exponential backoff + jitter up to
 * `maxAttempts`, then the event is dead-lettered via `onError`. `emit` fire-and-forgets `deliver`
 * (best-effort, never blocks or breaks the operation); the secret is never logged.
 *
 * @param options - URL + signing secret and optional filter / retry / timeout / injection knobs.
 * @returns A webhook-delivering event sink.
 */
export function createWebhookEventSink(options: WebhookEventSinkOptions): WebhookEventSink {
  const parsed = new URL(options.url);
  if (parsed.protocol !== 'https:' && options.allowInsecureUrl !== true) {
    throw new Error(
      `webhook url must be https (got ${parsed.protocol}); set allowInsecureUrl to override`,
    );
  }
  const maxAttempts = options.maxAttempts ?? 3;
  const backoffMs = options.backoffMs ?? 200;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? ((): number => Date.now());
  const jitter = options.jitter ?? ((): number => Math.random());
  const sleep =
    options.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));

  const post = async (body: string, timestamp: number): Promise<number> => {
    const signature = createHmac('sha256', options.secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tenantforge-timestamp': String(timestamp),
          'x-tenantforge-signature': `sha256=${signature}`,
        },
        body,
        redirect: 'error',
        signal: controller.signal,
      });
      return response.status;
    } finally {
      clearTimeout(timer);
    }
  };

  const deliver = async (event: TenantEvent): Promise<WebhookDeliveryOutcome> => {
    if (options.eventTypes !== undefined && !options.eventTypes.includes(event.event)) {
      return { delivered: false, attempts: 0, skipped: true };
    }
    const body = JSON.stringify(event);
    let lastStatus: number | undefined;
    let lastError = 'no attempts';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const status = await post(body, now());
        lastStatus = status;
        if (status >= 200 && status < 300) {
          return { delivered: true, attempts: attempt, status };
        }
        lastError = `HTTP ${status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt < maxAttempts) {
        await sleep(backoffMs * 2 ** (attempt - 1) * (1 + jitter()));
      }
    }
    options.onError?.(event, lastError);
    return {
      delivered: false,
      attempts: maxAttempts,
      ...(lastStatus !== undefined ? { status: lastStatus } : {}),
    };
  };

  return {
    deliver,
    emit(event: TenantEvent): void {
      // Fire-and-forget: best-effort, never block the control-plane operation. `deliver` never rejects.
      void deliver(event);
    },
  };
}
