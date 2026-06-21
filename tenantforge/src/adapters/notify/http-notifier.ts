import { createHmac } from 'node:crypto';
import { assertHttpsUrl } from '../../core/index.js';
import type { Notification, NotificationResult, Notifier } from '../../ports/notifier.js';

/** Options for {@link createHttpNotifier}. */
export interface HttpNotifierOptions {
  /** The relay endpoint that turns a notification into an email/SMS/push (e.g. your mail service). */
  url: string;
  /** HMAC signing secret — the relay verifies `X-TenantForge-Signature` over the body. */
  secret?: string;
  /** Per-request timeout in ms. Defaults to 10000. */
  timeoutMs?: number;
  /** Injectable fetch (for testing). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Permit a non-https relay URL (local dev only — the documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
}

/**
 * Create a {@link Notifier} that **POSTs** the notification (as JSON) to a relay endpoint over its
 * REST API — zero-dependency (injectable `fetch`, like the Stripe / Vault adapters), so any mail/
 * SMS/push service with an HTTP hook plugs in without touching the control plane. The URL must be
 * `https` (fail fast at construction unless `allowInsecure`); the body is **HMAC-signed**
 * (`X-TenantForge-Signature: sha256=…`) when a secret is set so the relay can verify authenticity;
 * the request is timeout-bound and **does not follow redirects** (SSRF defence). A non-2xx throws —
 * the caller sends best-effort and audits the failure (`topic-api-consumption`).
 *
 * @param options - Relay URL + optional signing secret / timeout / fetch.
 * @returns An HTTP-relay notifier.
 */
export function createHttpNotifier(options: HttpNotifierOptions): Notifier {
  // The relay receives recipient addresses + receipt content — refuse a plaintext endpoint.
  assertHttpsUrl(options.url, 'TENANTFORGE_NOTIFIER_URL', options.allowInsecure);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  return {
    provider: 'http',
    async notify(notification: Notification): Promise<NotificationResult> {
      const body = JSON.stringify(notification);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        // Idempotency key on a header too, so a relay can de-duplicate without parsing the body.
        'idempotency-key': notification.idempotencyKey,
      };
      if (options.secret !== undefined) {
        headers['x-tenantforge-signature'] =
          `sha256=${createHmac('sha256', options.secret).update(body).digest('hex')}`;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await doFetch(options.url, {
          method: 'POST',
          headers,
          body,
          redirect: 'error',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        throw new Error(`notifier relay failed (${res.status})`);
      }
      return { id: notification.idempotencyKey, provider: 'http', status: 'sent' };
    },
  };
}
