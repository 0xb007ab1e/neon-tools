import type { Notification, NotificationResult, Notifier } from '../../ports/notifier.js';

// --- A minimal SMTP transport surface (the one call this adapter uses) -------------------------
// Zero-dependency by design: a `nodemailer` transport satisfies this directly, so we don't pull it
// into the project. Wire it at the composition root, e.g.:
//   const transport = nodemailer.createTransport({ host, port, auth: { user, pass } });
//   const notifier = createSmtpNotifier({ transport, from: 'billing@you.example' });

/** The narrow SMTP transport this adapter depends on (a `nodemailer` transport satisfies it). */
export interface SmtpTransportLike {
  /** Send a mail; returns the provider message id. */
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<{ messageId?: string }>;
}

/** Options for {@link createSmtpNotifier}. */
export interface SmtpNotifierOptions {
  /** The SMTP transport (e.g. a `nodemailer` transport). */
  transport: SmtpTransportLike;
  /** The sender address (`From`). */
  from: string;
}

/**
 * Create a {@link Notifier} backed by **SMTP**, over a minimal injected transport (so `nodemailer`
 * is not a dependency of this project — wire your transport per the shim above; the same
 * injected-collaborator shape as the SES / cloud adapters). Sends the receipt as a plain-text email
 * from the configured `from`; the transport's `messageId` becomes the {@link NotificationResult} id.
 * A send error propagates — the caller sends best-effort and audits the failure
 * (`topic-notifications`). The recipient is in the SMTP message, not the result (kept out of
 * logs/audit — master §5). Configure SPF/DKIM/DMARC on the sending domain for deliverability.
 *
 * @param options - The SMTP transport + sender address.
 * @returns An SMTP-backed notifier.
 */
export function createSmtpNotifier(options: SmtpNotifierOptions): Notifier {
  return {
    provider: 'smtp',
    async notify(notification: Notification): Promise<NotificationResult> {
      const res = await options.transport.sendMail({
        from: options.from,
        to: notification.to,
        subject: notification.subject,
        text: notification.body,
      });
      return { id: res.messageId ?? notification.idempotencyKey, provider: 'smtp', status: 'sent' };
    },
  };
}
