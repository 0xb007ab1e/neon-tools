/**
 * A self-serve **signup request** — the durable funnel record for one public web signup, from email
 * entry through to a provisioned tenant. It binds an (opaque, high-entropy) signup-session id to the
 * email, the PSP customer/setup-intent, the chosen tenant config, and finally the provisioned tenant,
 * and tracks one-time reveal of the connection secret. Holds **no secrets** — only references (master
 * §5); the connection URI itself lives in the encrypted SecretStore keyed by tenant id.
 */
export interface SignupRequestRecord {
  /** Opaque, high-entropy id == the signup-session subject (the cookie binds the browser to this row). */
  id: string;
  /** The signup email (PII — never logged). */
  email: string;
  /** Funnel state (see {@link SignupRequestStatus}). */
  status: SignupRequestStatus;
  /** PSP customer reference once created (e.g. Stripe `cus_…`); never card data. */
  customerRef?: string;
  /** PSP setup-intent id once opened. */
  setupIntentId?: string;
  /** Chosen tenant slug (validated) — also the key used to resolve the provisioned tenant on status poll. */
  slug?: string;
  /** Chosen region (data residency). */
  region?: string;
  /** Chosen plan id (from the catalog). */
  planId?: string;
  /** The provisioned tenant id, once the lifecycle worker activates it. */
  tenantId?: string;
  /** When the one-time connection URI was revealed to the customer (reveal-once guard). */
  connectionRevealedAt?: string;
  /** When the signup started (ISO-8601 UTC). */
  createdAt: string;
  /** Last update (ISO-8601 UTC). */
  updatedAt: string;
}

/**
 * Funnel states: `started` (email submitted, captcha passed) → `email_verified` → `payment_ready`
 * (PSP customer + setup-intent created) → `provisioning` (payment confirmed, provision enqueued) →
 * `active` (tenant live) | `failed` (provisioning failed; operator can investigate).
 */
export type SignupRequestStatus =
  | 'started'
  | 'email_verified'
  | 'payment_ready'
  | 'provisioning'
  | 'active'
  | 'failed';

/** All funnel states, in order (for the operator funnel panel + validation). */
export const SIGNUP_REQUEST_STATUSES: readonly SignupRequestStatus[] = [
  'started',
  'email_verified',
  'payment_ready',
  'provisioning',
  'active',
  'failed',
];

/**
 * Whether the one-time connection URI may be revealed for this request: the tenant must be `active`
 * and the secret not already revealed. Fail-safe — pure and deterministic; the caller still fetches
 * the secret from the SecretStore and marks `connectionRevealedAt` atomically.
 *
 * @param record - The signup request.
 * @returns True iff active and not yet revealed.
 */
export function canRevealConnection(record: SignupRequestRecord): boolean {
  return record.status === 'active' && record.connectionRevealedAt === undefined;
}
