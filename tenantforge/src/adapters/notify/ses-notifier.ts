import type { Notification, NotificationResult, Notifier } from '../../ports/notifier.js';

// --- A minimal AWS SES v2 client surface (the one call this adapter uses) ----------------------
// Zero-dependency by design: the AWS SDK v3 `SESv2Client` satisfies this via a tiny shim, so we
// don't pull the SDK tree into the project. Wire it at the composition root, e.g.:
//   const ses = new SESv2Client({ region });
//   const client: SesClientLike = { sendEmail: (i) => ses.send(new SendEmailCommand(i)) };

/** The narrow SES v2 client this adapter depends on (the AWS SDK client satisfies it). */
export interface SesClientLike {
  /** `SendEmail` — send a simple (text) email; returns the provider message id. */
  sendEmail(input: {
    FromEmailAddress: string;
    Destination: { ToAddresses: string[] };
    Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } } };
  }): Promise<{ MessageId?: string }>;
}

/** Options for {@link createSesNotifier}. */
export interface SesNotifierOptions {
  /** The narrow SES client (wrap your `@aws-sdk/client-sesv2` `SESv2Client`). */
  client: SesClientLike;
  /** The verified sender address (`From`). */
  from: string;
}

/**
 * Create a {@link Notifier} backed by **AWS SES**, over a minimal injected client (so the AWS SDK is
 * not a dependency of this project — wrap your `SESv2Client` per the shim above; the same shape as
 * the AWS Secrets Manager / SQS adapters). Sends the receipt as a simple text email from the
 * configured `from` address; the SES `MessageId` becomes the {@link NotificationResult} id. A send
 * error propagates — the caller sends best-effort and audits the failure (`topic-notifications`).
 * The recipient is in the SES request, not the result (kept out of logs/audit — master §5).
 *
 * @param options - The SES client + verified sender address.
 * @returns An SES-backed notifier.
 */
export function createSesNotifier(options: SesNotifierOptions): Notifier {
  return {
    provider: 'ses',
    async notify(notification: Notification): Promise<NotificationResult> {
      const res = await options.client.sendEmail({
        FromEmailAddress: options.from,
        Destination: { ToAddresses: [notification.to] },
        Content: {
          Simple: {
            Subject: { Data: notification.subject },
            Body: { Text: { Data: notification.body } },
          },
        },
      });
      return { id: res.MessageId ?? notification.idempotencyKey, provider: 'ses', status: 'sent' };
    },
  };
}
