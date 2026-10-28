import { describe, it, expect } from 'vitest';
import { extractIdempotencyKey } from '../idempotency.js';

describe('extractIdempotencyKey', () => {
  const endpointId = 'ep_123456789012';

  it('prefers Idempotency-Key header when present', () => {
    const headers = { 'Idempotency-Key': 'my-custom-key-123' };
    const key = extractIdempotencyKey(headers, '{"id":"evt_999"}', endpointId);
    expect(key).toBe('my-custom-key-123');
  });

  it('reads X-GitHub-Delivery header', () => {
    const headers = { 'x-github-delivery': '720c6638-0414-11e5-8a8b-4a47d2f9d854' };
    const key = extractIdempotencyKey(headers, 'body', endpointId);
    expect(key).toBe('720c6638-0414-11e5-8a8b-4a47d2f9d854');
  });

  it('extracts event ID from JSON body when no header is present', () => {
    const rawBody = JSON.stringify({ id: 'evt_stripe_9999', object: 'event' });
    const key = extractIdempotencyKey({}, rawBody, endpointId);
    expect(key).toBe('evt_stripe_9999');
  });

  it('falls back to deterministic SHA-256 hash when no header or JSON ID is present', () => {
    const rawBody = 'plain-text-payload';
    const key1 = extractIdempotencyKey({}, rawBody, endpointId);
    const key2 = extractIdempotencyKey({}, rawBody, endpointId);

    expect(key1).toHaveLength(64);
    expect(key1).toBe(key2);

    // Different endpoint or body yields different hash
    const key3 = extractIdempotencyKey({}, 'different-body', endpointId);
    expect(key3).not.toBe(key1);
  });
});
