import { describe, it, expect } from 'vitest';
import {
  classifyResponse,
  parseRetryAfter,
  buildForwardHeaders,
} from '../services/delivery.service.js';
import type { IEvent } from '../models/Event.js';
import type { IEndpoint } from '../models/Endpoint.js';

describe('classifyResponse', () => {
  it('classifies 2xx responses as success', () => {
    expect(classifyResponse(200)).toBe('success');
    expect(classifyResponse(201)).toBe('success');
    expect(classifyResponse(202)).toBe('success');
    expect(classifyResponse(204)).toBe('success');
  });

  it('classifies 408, 429, 5xx, and network errors (0) as retryable', () => {
    expect(classifyResponse(408)).toBe('retryable');
    expect(classifyResponse(429)).toBe('retryable');
    expect(classifyResponse(500)).toBe('retryable');
    expect(classifyResponse(502)).toBe('retryable');
    expect(classifyResponse(503)).toBe('retryable');
    expect(classifyResponse(504)).toBe('retryable');
    expect(classifyResponse(0)).toBe('retryable');
  });

  it('classifies other 4xx responses as permanent failure', () => {
    expect(classifyResponse(400)).toBe('permanent');
    expect(classifyResponse(401)).toBe('permanent');
    expect(classifyResponse(403)).toBe('permanent');
    expect(classifyResponse(404)).toBe('permanent');
    expect(classifyResponse(405)).toBe('permanent');
    expect(classifyResponse(410)).toBe('permanent');
    expect(classifyResponse(422)).toBe('permanent');
  });
});

describe('parseRetryAfter', () => {
  it('parses integer seconds', () => {
    expect(parseRetryAfter('30')).toBe(30);
    expect(parseRetryAfter('120')).toBe(120);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('parses HTTP date string in the future', () => {
    const futureDate = new Date(Date.now() + 45000).toUTCString();
    const parsed = parseRetryAfter(futureDate);
    expect(parsed).toBeGreaterThanOrEqual(40);
    expect(parsed).toBeLessThanOrEqual(50);
  });

  it('returns null for missing, invalid, or null headers', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('invalid-header')).toBeNull();
  });
});

describe('buildForwardHeaders', () => {
  it('filters out hop-by-hop headers and injects tracing and signature headers', () => {
    const mockEvent = {
      _id: '507f1f77bcf86cd799439011',
      id: '507f1f77bcf86cd799439011',
      rawBody: '{"event":"user.created"}',
      contentType: 'application/json',
      headers: {
        'content-type': 'application/json',
        host: 'hookpilot.app',
        connection: 'keep-alive',
        'transfer-encoding': 'chunked',
        'x-custom-tenant': 'tenant_abc',
      },
    } as unknown as IEvent;

    const mockEndpoint = {
      slug: 'my_test_slug',
      signatureConfig: {
        provider: 'none',
        secretEncrypted: null,
      },
    } as unknown as IEndpoint;

    const timestamp = 1700000000;
    const headers = buildForwardHeaders(mockEvent, mockEndpoint, 2, timestamp);

    // Hop-by-hop headers must be stripped
    expect(headers.host).toBeUndefined();
    expect(headers.connection).toBeUndefined();
    expect(headers['transfer-encoding']).toBeUndefined();

    // User headers preserved
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-custom-tenant']).toBe('tenant_abc');

    // HookPilot headers injected
    expect(headers['x-hookpilot-event-id']).toBe('507f1f77bcf86cd799439011');
    expect(headers['x-hookpilot-attempt']).toBe('2');
    expect(headers['x-hookpilot-signature']).toMatch(/^t=1700000000,v1=[a-f0-9]{64}$/);
  });
});
