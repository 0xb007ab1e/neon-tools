import { describe, expect, it, vi } from 'vitest';
import { webhookSecretKey } from '../../src/core/index.js';
import type { TenantEvent } from '../../src/core/index.js';
import { createInMemorySecretStore } from '../../src/adapters/secret-store.js';
import { createInMemoryWebhookSubscriptionStore } from '../../src/adapters/webhook-subscription-store.js';
import { createSubscriptionWebhookEventSink } from '../../src/adapters/subscription-webhook-event-sink.js';

const event: TenantEvent = { event: 'tenant.provisioned', at: 'x', outcome: 'ok' };

function setup() {
  const store = createInMemoryWebhookSubscriptionStore();
  const secretStore = createInMemorySecretStore();
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: String(init.body),
    });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const sink = createSubscriptionWebhookEventSink({ store, secretStore, fetchImpl });
  return { store, secretStore, calls, sink };
}

describe('subscription webhook event sink', () => {
  it('signs and delivers to a matching active subscription', async () => {
    const { store, secretStore, calls, sink } = setup();
    await store.create({
      id: 's1',
      url: 'https://hook.test/a',
      eventTypes: [],
      active: true,
      createdAt: 'x',
    });
    await secretStore.set(webhookSecretKey('s1'), 'signing-secret');

    sink.emit(event); // fire-and-forget
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.url).toBe('https://hook.test/a');
    expect(calls[0]?.headers['x-tenantforge-signature']).toMatch(/^sha256=[0-9a-f]+$/);
    expect(calls[0]?.body).toContain('tenant.provisioned');
  });

  it('skips a non-matching event, an inactive subscription, and one with no secret on file', async () => {
    const { store, secretStore, calls, sink } = setup();
    await store.create({
      id: 'filtered',
      url: 'https://h/1',
      eventTypes: ['other.event'],
      active: true,
      createdAt: 'x',
    });
    await secretStore.set(webhookSecretKey('filtered'), 's');
    await store.create({
      id: 'inactive',
      url: 'https://h/2',
      eventTypes: [],
      active: false,
      createdAt: 'x',
    });
    await secretStore.set(webhookSecretKey('inactive'), 's');
    await store.create({
      id: 'nosecret',
      url: 'https://h/3',
      eventTypes: [],
      active: true,
      createdAt: 'x',
    }); // no secret stored → must be skipped (never sign with nothing)

    sink.emit(event);
    await new Promise((r) => setTimeout(r, 25)); // let dispatch settle
    expect(calls).toHaveLength(0);
  });
});
