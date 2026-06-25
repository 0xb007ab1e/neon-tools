/**
 * E2E journey — self-serve signup funnel (gap B2, journey 2).
 *
 * Drives the public, payment-gated funnel end to end through the facade: signup request → email
 * verification → payment-ready → (async) provisioning by the worker → active → one-time connection
 * reveal. Asserts each funnel-state transition and the one-time reveal gate (the connection URI is
 * shown exactly once after activation, never again). Hermetic: in-memory captcha/payment/email
 * fakes, the queue drained by the real lifecycle handler (simulating the worker).
 */
import { describe, expect, it } from 'vitest';
import { journeyHarness, latestCode } from './harness.js';
import { anActiveSignup } from './builders.js';

describe('E2E journey: self-serve signup funnel', () => {
  it('start → verify → pay → complete → worker provisions → active → one-time reveal', async () => {
    const h = await journeyHarness();

    // --- Step 1: start (captcha-gated) emails a one-time code; funnel = pending_verification. ---
    const { signupId } = await h.tf.startSignup({
      email: 'Founder@Example.com',
      captchaToken: 'solved',
    });
    expect(h.notifier.sent).toHaveLength(1);
    const beforeVerify = await h.tf.signupStatus(signupId);
    expect(beforeVerify.status).not.toBe('active');

    // --- Step 2: verify the emailed code → email_verified (the card-testing guard lifts). ---
    await h.tf.verifyEmail(signupId, latestCode(h.notifier));

    // --- Step 3: payment setup (only post-verification) returns a client secret for the browser SDK. ---
    const setup = await h.tf.createPaymentSetup(signupId);
    expect(setup.clientSecret).toBe('seti_1_secret');

    // --- Step 4: complete validates the slug + enqueues an async provision → provisioning. ---
    const completed = await h.tf.completeSignup(signupId, { slug: 'globex', planId: 'starter' });
    expect(completed.status).toBe('provisioning');
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toMatchObject({
      type: 'provision',
      slug: 'globex',
      metadata: { billingEmail: 'founder@example.com', planId: 'starter' },
    });

    // Until the worker runs, polling still reports provisioning (no premature reveal).
    const stillProvisioning = await h.tf.signupStatus(signupId);
    expect(stillProvisioning.status).toBe('provisioning');
    expect(stillProvisioning.connectionUri).toBeUndefined();

    // --- The worker: drain the queue → the tenant is genuinely provisioned + active. ---
    await h.drainQueue();
    const tenant = await h.registry.getBySlug('globex');
    expect(tenant?.status).toBe('active');

    // --- One-time reveal: the first post-activation poll surfaces the connection URI exactly once. ---
    const first = await h.tf.signupStatus(signupId);
    expect(first.status).toBe('active');
    expect(first.connectionUri).toMatch(/^postgresql:\/\//);
    const second = await h.tf.signupStatus(signupId);
    expect(second.status).toBe('active');
    expect(second.connectionUri).toBeUndefined(); // never revealed again (the gate closed)

    // The revealed secret was never written to the audit/event stream (master §5).
    expect(JSON.stringify(h.events)).not.toContain(first.connectionUri);
  });

  it('the builder reaches `provisioning` in one line; the worker then activates the tenant', async () => {
    const h = await journeyHarness();
    const { signupId, slug } = await anActiveSignup(h, { slug: 'initech' });
    expect((await h.tf.signupStatus(signupId)).status).toBe('provisioning');
    await h.drainQueue();
    expect((await h.registry.getBySlug(slug))?.status).toBe('active');
  });
});
