import { describe, expect, it } from 'vitest';
import type { WebhookSubscriptionRecord } from '../../src/core/index.js';
import {
  subscriptionMatchesEvent,
  toWebhookSubscriptionSummary,
  webhookSecretKey,
} from '../../src/core/index.js';

describe('webhookSecretKey', () => {
  it('namespaces the SecretStore key by subscription id', () => {
    expect(webhookSecretKey('sub-1')).toBe('webhook-sub:sub-1');
  });
});

describe('subscriptionMatchesEvent', () => {
  it('matches every event when the filter is empty', () => {
    expect(subscriptionMatchesEvent([], 'tenant.provisioned')).toBe(true);
    expect(subscriptionMatchesEvent([], 'anything.at.all')).toBe(true);
  });

  it('matches only listed events when the filter is non-empty', () => {
    const filter = ['tenant.provisioned', 'tenant.offboarded'];
    expect(subscriptionMatchesEvent(filter, 'tenant.provisioned')).toBe(true);
    expect(subscriptionMatchesEvent(filter, 'tenant.charged')).toBe(false);
  });
});

describe('toWebhookSubscriptionSummary', () => {
  it('projects the record fields (there is no secret to drop)', () => {
    const record: WebhookSubscriptionRecord = {
      id: 'sub-1',
      url: 'https://example.test/hook',
      eventTypes: ['tenant.provisioned'],
      active: true,
      createdAt: '2026-06-22T00:00:00.000Z',
    };
    expect(toWebhookSubscriptionSummary(record)).toEqual({
      id: 'sub-1',
      url: 'https://example.test/hook',
      eventTypes: ['tenant.provisioned'],
      active: true,
      createdAt: '2026-06-22T00:00:00.000Z',
    });
  });
});
