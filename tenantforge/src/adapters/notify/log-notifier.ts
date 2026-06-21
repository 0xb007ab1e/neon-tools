import type { Notification, NotificationResult, Notifier } from '../../ports/notifier.js';

/**
 * Create a {@link Notifier} that **records** a notification rather than delivering it externally —
 * the safe, zero-dependency default. It returns `queued` and leaves the actual send to the audit
 * trail / a real adapter (SMTP / SES / SendGrid / {@link import('./http-notifier.js')}) wired later.
 * Useful out of the box (you get an auditable receipt trail) without committing to an ESP, and for
 * tests. The recipient is **not** returned in the result (kept out of logs/audit — master §5).
 *
 * @returns A recording notifier.
 */
export function createLogNotifier(): Notifier {
  return {
    provider: 'log',
    notify(notification: Notification): Promise<NotificationResult> {
      return Promise.resolve({
        id: notification.idempotencyKey,
        provider: 'log',
        status: 'queued',
      });
    },
  };
}
