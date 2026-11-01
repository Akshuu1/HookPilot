import { describe, it, expect } from 'vitest';
import { extractIdempotencyKey } from '../idempotency.js';

describe('extractIdempotencyKey (Explicit Keys Only)', () => {
  const endpointId = 'ep_123456789012';

  it('1. prefers Idempotency-Key header when present', () => {
    const headers = { 'Idempotency-Key': 'my-custom-key-123' };
    const key = extractIdempotencyKey(headers, '{"id":"evt_999"}', endpointId);
    expect(key).toBe('my-custom-key-123');
  });

  it('2. reads X-GitHub-Delivery header', () => {
    const headers = { 'x-github-delivery': '720c6638-0414-11e5-8a8b-4a47d2f9d854' };
    const key = extractIdempotencyKey(headers, 'body', endpointId);
    expect(key).toBe('720c6638-0414-11e5-8a8b-4a47d2f9d854');
  });

  it('3. extracts event id from JSON body WHEN stripe-signature header is present', () => {
    const rawBody = JSON.stringify({ id: 'evt_stripe_9999', object: 'event' });
    const keyWithSig = extractIdempotencyKey(
      { 'stripe-signature': 't=123,v1=signature' },
      rawBody,
      endpointId,
    );
    expect(keyWithSig).toBe('evt_stripe_9999');

    // Without stripe-signature header, returns null (not treated as an idempotency key)
    const keyWithoutSig = extractIdempotencyKey({}, rawBody, endpointId);
    expect(keyWithoutSig).toBeNull();
  });

  it('4. reads Webhook-Id header (Standard Webhooks)', () => {
    const headers = { 'webhook-id': 'msg_standard_webhook_123' };
    const key = extractIdempotencyKey(headers, 'payload', endpointId);
    expect(key).toBe('msg_standard_webhook_123');
  });

  it('5. returns null when no explicit key is present (never falls back to body hash)', () => {
    const rawBody = 'plain-text-payload';
    const key = extractIdempotencyKey({}, rawBody, endpointId);
    expect(key).toBeNull();
  });
});
