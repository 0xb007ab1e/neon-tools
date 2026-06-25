/**
 * Arrange-phase builders/factories for E2E journeys (gap B2).
 *
 * Each builder reaches a common tenant/signup state on a {@link JourneyHarness} in one call, so a
 * journey's arrange phase reads like a story (`const t = await aProvisionedTenant(h)`). They compose
 * the real facade — no shortcut around the lifecycle — so the state they produce is genuine
 * (per `@rules/topic-testing.md`: builders/factories over fixtures, synthetic data only).
 */
import { expect } from 'vitest';
import type { ProvisionInput } from '../../src/app/lib.js';
import type { TenantRecord } from '../../src/core/domain.js';
import { latestCode, type JourneyHarness } from './harness.js';

/** A provisioned tenant plus its one-time connection secret (returned only on first provision). */
export interface ProvisionedTenant {
  /** The active tenant record. */
  tenant: TenantRecord;
  /** The connection URI minted on provision (a secret; revealed once). */
  connectionUri: string;
}

/**
 * Provision a fresh active tenant via the facade. The connection secret is returned (the operator's
 * one-time hand-off); the tenant is `active` with a Neon project attached.
 *
 * @param h - The journey harness.
 * @param input - Provision overrides (defaults to a synthetic `acme` tenant).
 * @returns The active tenant + its connection secret.
 */
export async function aProvisionedTenant(
  h: JourneyHarness,
  input: Partial<ProvisionInput> = {},
): Promise<ProvisionedTenant> {
  const { tenant, connectionUri } = await h.tf.provision({ slug: 'acme', ...input });
  expect(tenant.status).toBe('active');
  expect(connectionUri).not.toBeNull();
  return { tenant, connectionUri: connectionUri! };
}

/** A signup carried through to the point an async provision was enqueued (funnel = `provisioning`). */
export interface ActiveSignup {
  /** The opaque signup id (carried across funnel steps). */
  signupId: string;
  /** The chosen tenant slug. */
  slug: string;
}

/**
 * Drive the self-serve signup funnel to completion (start → verify email → pay → complete), leaving
 * the funnel at `provisioning` with a `provision` command enqueued. Does NOT drain the queue —
 * the journey decides when the "worker" runs (so it can assert the pre-activation state too).
 *
 * @param h - The journey harness.
 * @param opts - Optional `email` / `slug` (synthetic defaults otherwise).
 * @returns The signup id + chosen slug.
 */
export async function anActiveSignup(
  h: JourneyHarness,
  opts: { email?: string; slug?: string } = {},
): Promise<ActiveSignup> {
  const email = opts.email ?? 'founder@example.com';
  const slug = opts.slug ?? 'globex';
  const { signupId } = await h.tf.startSignup({ email, captchaToken: 'solved' });
  await h.tf.verifyEmail(signupId, latestCode(h.notifier));
  await h.tf.createPaymentSetup(signupId);
  const status = await h.tf.completeSignup(signupId, { slug, planId: 'starter' });
  expect(status.status).toBe('provisioning');
  return { signupId, slug };
}

/**
 * Provision then offboard a tenant — leaving it `offboarding` (archived, retained, reversible until
 * purge). The Neon project is retained, the connection secret kept (restore-able).
 *
 * @param h - The journey harness.
 * @param input - Provision overrides.
 * @returns The offboarded tenant record.
 */
export async function anOffboardedTenant(
  h: JourneyHarness,
  input: Partial<ProvisionInput> = {},
): Promise<TenantRecord> {
  const { tenant } = await aProvisionedTenant(h, input);
  const { tenant: offboarded } = await h.tf.offboard(tenant.id);
  expect(offboarded.status).toBe('offboarding');
  return offboarded;
}

/** A pair of fully-provisioned active tenants (for cross-tenant / BOLA abuse journeys). */
export interface TwoTenants {
  /** Tenant A. */
  a: ProvisionedTenant;
  /** Tenant B. */
  b: ProvisionedTenant;
}

/**
 * Provision two distinct active tenants — the standard arrangement for a cross-tenant abuse journey
 * (tenant A must never reach tenant B's resources).
 *
 * @param h - The journey harness.
 * @returns Both active tenants + their secrets.
 */
export async function twoTenants(h: JourneyHarness): Promise<TwoTenants> {
  const a = await aProvisionedTenant(h, { slug: 'tenant-a' });
  const b = await aProvisionedTenant(h, { slug: 'tenant-b' });
  return { a, b };
}
