import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { EndpointService } from '../endpoint.service.js';
import { IngestService } from '../ingest.service.js';
import type { EndpointRepository } from '../../repositories/endpoint.repository.js';
import type { EventRepository } from '../../repositories/event.repository.js';
import type { IEndpoint } from '../../models/Endpoint.js';
import type { IEvent } from '../../models/Event.js';
import * as redisConfig from '../../config/redis.js';
import * as queueConfig from '../../config/queue.js';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { AppError } from '../../middlewares/error-handler.js';

describe('Endpoint Settings & Enforcement Integration & Unit Tests', () => {
  // In-memory data stores
  let endpointsDb: Map<string, Record<string, unknown>>;
  let eventsDb: IEvent[];
  let redisCache: Map<string, string>;

  let mockEndpointRepo: EndpointRepository;
  let mockEventRepo: EventRepository;
  let mockQueueAdd: ReturnType<typeof vi.fn>;
  let mockRedisClient: Partial<Redis>;

  let endpointService: EndpointService;
  let ingestService: IngestService;

  beforeEach(() => {
    endpointsDb = new Map();
    eventsDb = [];
    redisCache = new Map();

    mockQueueAdd = vi.fn().mockResolvedValue({ id: 'job-1' });

    mockRedisClient = {
      get: vi.fn(async (key: string) => redisCache.get(key) || null),
      set: vi.fn(async (key: string, val: string) => {
        redisCache.set(key, val);
        return 'OK';
      }),
      del: vi.fn(async (...keys: string[]) => {
        let count = 0;
        for (const k of keys) {
          if (redisCache.delete(k)) count++;
        }
        return count;
      }),
    };

    vi.spyOn(redisConfig, 'getRedisClient').mockReturnValue(mockRedisClient as unknown as Redis);
    vi.spyOn(queueConfig, 'getDeliveryQueue').mockReturnValue({
      add: mockQueueAdd,
    } as unknown as Queue);

    mockEndpointRepo = {
      create: vi.fn(async (data) => {
        const id = `ep_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const doc: Record<string, unknown> = {
          _id: id,
          id,
          workspaceId: data.workspaceId,
          name: data.name,
          slug: data.slug,
          destinationUrl: data.destinationUrl,
          signatureConfig: {
            provider: data.signatureConfig?.provider || 'none',
            secretEncrypted: data.signatureConfig?.secretEncrypted || null,
            headerName: data.signatureConfig?.headerName || null,
            enforce: data.signatureConfig?.enforce ?? false,
          },
          retryPolicy: data.retryPolicy || {
            maxAttempts: 8,
            baseDelayMs: 1000,
            maxDelayMs: 3600000,
          },
          rateLimitPerMin: data.rateLimitPerMin ?? 60,
          isActive: data.isActive ?? true,
          mode: data.mode ?? 'forward',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        endpointsDb.set(id, doc);
        endpointsDb.set(`slug:${data.slug}`, doc);
        return doc as unknown as IEndpoint;
      }),
      findById: vi.fn(async (id: string) => {
        return (endpointsDb.get(id) as unknown as IEndpoint) || null;
      }),
      findBySlug: vi.fn(async (slug: string) => {
        return (endpointsDb.get(`slug:${slug}`) as unknown as IEndpoint) || null;
      }),
      findByWorkspace: vi.fn(async (workspaceId: string) => {
        const results: IEndpoint[] = [];
        for (const [k, v] of endpointsDb.entries()) {
          if (!k.startsWith('slug:') && v.workspaceId === workspaceId) {
            results.push(v as unknown as IEndpoint);
          }
        }
        return results;
      }),
      update: vi.fn(async (id: string, data: Record<string, unknown>) => {
        const existing = endpointsDb.get(id);
        if (!existing) return null;

        const updated: Record<string, unknown> = {
          ...existing,
          signatureConfig: { ...(existing.signatureConfig as Record<string, unknown>) },
          retryPolicy: { ...(existing.retryPolicy as Record<string, unknown>) },
        };
        for (const [key, val] of Object.entries(data)) {
          if (key.includes('.')) {
            const [parent, child] = key.split('.');
            if (!updated[parent!]) updated[parent!] = {};
            (updated[parent!] as Record<string, unknown>)[child!] = val;
          } else {
            updated[key] = val;
          }
        }
        updated.updatedAt = new Date();
        endpointsDb.set(id, updated);
        endpointsDb.set(`slug:${updated.slug}`, updated);
        return updated as unknown as IEndpoint;
      }),
      delete: vi.fn(async (id: string) => {
        const existing = endpointsDb.get(id);
        if (existing) {
          endpointsDb.delete(id);
          endpointsDb.delete(`slug:${existing.slug}`);
          return true;
        }
        return false;
      }),
    };

    mockEventRepo = {
      create: vi.fn(async (eventData) => {
        const eventId = `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const eventDoc = {
          _id: eventId,
          id: eventId,
          ...eventData,
          createdAt: new Date(),
        } as unknown as IEvent;
        eventsDb.push(eventDoc);
        return { event: eventDoc, isDuplicate: false };
      }),
      findById: vi.fn(async (id: string) => eventsDb.find((e) => e.id === id) || null),
      findByEndpointPaginated: vi.fn(),
      getWorkspaceMetrics: vi.fn(),
    } as unknown as EventRepository;

    endpointService = new EndpointService(mockEndpointRepo);
    ingestService = new IngestService(mockEndpointRepo, mockEventRepo);
  });

  // TEST 1: Enforcement on + bad signature: 401, zero events in the database, zero jobs in the queue
  it('TEST 1: Enforcement on + bad signature returns 401, zero events, and zero queue jobs', async () => {
    const secret = 'whsec_test_secret_abc123';
    const ep = await endpointService.createEndpoint('ws-1', {
      name: 'Enforce On Bad Sig',
      destinationUrl: 'https://example.com/dest',
      signatureConfig: {
        provider: 'github',
        secret,
        enforce: true,
      },
    });

    const rawBody = JSON.stringify({ action: 'opened', issue: 42 });
    const badSignature = 'sha256=0000000000000000000000000000000000000000000000000000000000000000';

    await expect(
      ingestService.handleIngest({
        slug: ep.slug,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': badSignature,
        },
        rawBody,
        bodySize: rawBody.length,
        sourceIp: '1.2.3.4',
      }),
    ).rejects.toThrow(AppError);

    // Verify 401 status code
    try {
      await ingestService.handleIngest({
        slug: ep.slug,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': badSignature,
        },
        rawBody,
        bodySize: rawBody.length,
        sourceIp: '1.2.3.4',
      });
    } catch (err) {
      const appErr = err as AppError;
      expect(appErr.statusCode).toBe(401);
      expect(appErr.code).toBe('INVALID_SIGNATURE');
      expect(appErr.message).toBe('Webhook signature verification failed');
    }

    // Zero events in the database
    expect(eventsDb).toHaveLength(0);
    // Zero jobs in the delivery queue
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  // TEST 2: Enforcement on + missing signature header: 401
  it('TEST 2: Enforcement on + missing signature header returns 401 with generic message', async () => {
    const ep = await endpointService.createEndpoint('ws-1', {
      name: 'Enforce Missing Header',
      destinationUrl: 'https://example.com/dest',
      signatureConfig: {
        provider: 'github',
        secret: 'whsec_gh_header_test',
        enforce: true,
      },
    });

    const rawBody = JSON.stringify({ ping: true });

    try {
      await ingestService.handleIngest({
        slug: ep.slug,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // No x-hub-signature-256 provided!
        },
        rawBody,
        bodySize: rawBody.length,
        sourceIp: '1.2.3.4',
      });
      expect.unreachable('Should have thrown 401');
    } catch (err) {
      const appErr = err as AppError;
      expect(appErr.statusCode).toBe(401);
      expect(appErr.code).toBe('INVALID_SIGNATURE');
      expect(appErr.message).toBe('Webhook signature verification failed');
    }

    expect(eventsDb).toHaveLength(0);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  // TEST 3: Enforcement on + good signature: 202 and signatureValid=true
  it('TEST 3: Enforcement on + good signature returns 202 and sets signatureValid=true', async () => {
    const secret = 'whsec_valid_secret_xyz789';
    const ep = await endpointService.createEndpoint('ws-1', {
      name: 'Enforce Good Sig',
      destinationUrl: 'https://example.com/dest',
      signatureConfig: {
        provider: 'github',
        secret,
        enforce: true,
      },
    });

    const rawBody = JSON.stringify({ ref: 'refs/heads/main', commit: 'abc' });
    const expectedHex = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    const validSignature = `sha256=${expectedHex}`;

    const res = await ingestService.handleIngest({
      slug: ep.slug,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': validSignature,
      },
      rawBody,
      bodySize: rawBody.length,
      sourceIp: '1.2.3.4',
    });

    expect(res.eventId).toBeDefined();
    expect(eventsDb).toHaveLength(1);
    expect(eventsDb[0]!.signatureValid).toBe(true);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  // TEST 4: Enforcement off + bad signature: 202 with signatureValid=false
  it('TEST 4: Enforcement off + bad signature returns 202 with signatureValid=false', async () => {
    const secret = 'whsec_enforce_off_secret';
    const ep = await endpointService.createEndpoint('ws-1', {
      name: 'Enforce Off Bad Sig',
      destinationUrl: 'https://example.com/dest',
      signatureConfig: {
        provider: 'github',
        secret,
        enforce: false,
      },
    });

    const rawBody = JSON.stringify({ orderId: 'ord_999' });
    const badSignature = 'sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    const res = await ingestService.handleIngest({
      slug: ep.slug,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': badSignature,
      },
      rawBody,
      bodySize: rawBody.length,
      sourceIp: '1.2.3.4',
    });

    expect(res.eventId).toBeDefined();
    expect(eventsDb).toHaveLength(1);
    expect(eventsDb[0]!.signatureValid).toBe(false);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  // TEST 5: Toggle enforcement on an endpoint that was already used (so its config is cached): the new setting applies on the very next request
  it('TEST 5: Toggle enforcement on cached endpoint applies immediately on the very next request', async () => {
    const secret = 'whsec_toggle_cache_test';
    const ep = await endpointService.createEndpoint('ws-1', {
      name: 'Toggle Cache Endpoint',
      destinationUrl: 'https://example.com/dest',
      signatureConfig: {
        provider: 'github',
        secret,
        enforce: false, // Initially off
      },
    });

    const rawBody = JSON.stringify({ event: 'ping' });
    const badSignature = 'sha256=1111111111111111111111111111111111111111111111111111111111111111';

    // 1st request with enforce=false: succeeds and caches endpoint config in Redis
    const firstRes = await ingestService.handleIngest({
      slug: ep.slug,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': badSignature,
      },
      rawBody,
      bodySize: rawBody.length,
      sourceIp: '1.2.3.4',
    });
    expect(firstRes.eventId).toBeDefined();
    // Cache was populated
    expect(redisCache.has(`ep:slug:${ep.slug}`)).toBe(true);

    // Now TOGGLE enforcement ON via updateEndpoint
    await endpointService.updateEndpoint(ep.id, {
      signatureConfig: {
        provider: 'github',
        enforce: true,
      },
    });

    // Cache key must have been invalidated
    expect(redisCache.has(`ep:slug:${ep.slug}`)).toBe(false);

    // 2nd request: the VERY NEXT request with bad signature must fail with 401!
    await expect(
      ingestService.handleIngest({
        slug: ep.slug,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': badSignature,
        },
        rawBody,
        bodySize: rawBody.length,
        sourceIp: '1.2.3.4',
      }),
    ).rejects.toThrow(AppError);

    // Total events must still be 1 (from first request only)
    expect(eventsDb).toHaveLength(1);
  });

  // TEST 6: Update only rateLimit: the secret still verifies a signed payload
  it('TEST 6: Update only rateLimit does not drop or corrupt secret; signed payload verifies', async () => {
    const secret = 'whsec_ratelimit_preservation_key';
    const ep = await endpointService.createEndpoint('ws-1', {
      name: 'Rate Limit Update Only',
      destinationUrl: 'https://example.com/dest',
      rateLimitPerMin: 60,
      signatureConfig: {
        provider: 'github',
        secret,
        enforce: true,
      },
    });

    // Update ONLY rateLimitPerMin
    const updated = await endpointService.updateEndpoint(ep.id, {
      rateLimitPerMin: 300,
    });
    expect(updated.rateLimitPerMin).toBe(300);

    // Send valid webhook using original secret
    const rawBody = JSON.stringify({ item: 'widget', price: 10 });
    const validSignature = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;

    const res = await ingestService.handleIngest({
      slug: ep.slug,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': validSignature,
      },
      rawBody,
      bodySize: rawBody.length,
      sourceIp: '1.2.3.4',
    });

    expect(res.eventId).toBeDefined();
    expect(eventsDb[0]!.signatureValid).toBe(true);
  });

  // TEST 7: Switch provider GitHub -> Generic -> GitHub without sending a new secret: the original secret still works
  it('TEST 7: Switch provider GitHub -> Generic -> GitHub without sending new secret preserves original secret', async () => {
    const originalSecret = 'whsec_github_preserve_123';
    const ep = await endpointService.createEndpoint('ws-1', {
      name: 'Provider Switch Test',
      destinationUrl: 'https://example.com/dest',
      signatureConfig: {
        provider: 'github',
        secret: originalSecret,
        enforce: true,
      },
    });

    // 1. Switch to 'generic' without sending a secret
    const switchedToGeneric = await endpointService.updateEndpoint(ep.id, {
      signatureConfig: {
        provider: 'generic',
        headerName: 'X-Custom-Sig',
      },
    });
    expect(switchedToGeneric.signatureConfig.provider).toBe('generic');
    expect(switchedToGeneric.signatureConfig.secretConfigured).toBe(true);

    // 2. Switch back to 'github' without sending a secret
    const switchedBackToGithub = await endpointService.updateEndpoint(ep.id, {
      signatureConfig: {
        provider: 'github',
        enforce: true,
      },
    });
    expect(switchedBackToGithub.signatureConfig.provider).toBe('github');
    expect(switchedBackToGithub.signatureConfig.secretConfigured).toBe(true);

    // 3. Verify original GitHub secret still works
    const rawBody = JSON.stringify({ ping: 'pong' });
    const validSignature = `sha256=${createHmac('sha256', originalSecret).update(rawBody, 'utf8').digest('hex')}`;

    const res = await ingestService.handleIngest({
      slug: ep.slug,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': validSignature,
      },
      rawBody,
      bodySize: rawBody.length,
      sourceIp: '1.2.3.4',
    });

    expect(res.eventId).toBeDefined();
    expect(eventsDb[0]!.signatureValid).toBe(true);
  });

  // TEST 8: Update with a new secret: old secret fails, new secret passes
  it('TEST 8: Update with new secret invalidates old secret and verifies with new secret', async () => {
    const oldSecret = 'whsec_old_secret_11111';
    const newSecret = 'whsec_new_secret_22222';

    const ep = await endpointService.createEndpoint('ws-1', {
      name: 'Secret Replacement Test',
      destinationUrl: 'https://example.com/dest',
      signatureConfig: {
        provider: 'github',
        secret: oldSecret,
        enforce: true,
      },
    });

    // Update with new secret
    await endpointService.updateEndpoint(ep.id, {
      signatureConfig: {
        provider: 'github',
        secret: newSecret,
        enforce: true,
      },
    });

    const rawBody = JSON.stringify({ version: 2 });
    const oldSig = `sha256=${createHmac('sha256', oldSecret).update(rawBody, 'utf8').digest('hex')}`;
    const newSig = `sha256=${createHmac('sha256', newSecret).update(rawBody, 'utf8').digest('hex')}`;

    // Old secret fails (401)
    await expect(
      ingestService.handleIngest({
        slug: ep.slug,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': oldSig,
        },
        rawBody,
        bodySize: rawBody.length,
        sourceIp: '1.2.3.4',
      }),
    ).rejects.toThrow(AppError);

    // New secret passes (202)
    const res = await ingestService.handleIngest({
      slug: ep.slug,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': newSig,
      },
      rawBody,
      bodySize: rawBody.length,
      sourceIp: '1.2.3.4',
    });

    expect(res.eventId).toBeDefined();
    expect(eventsDb[0]!.signatureValid).toBe(true);
  });

  // TEST 9: Update with an empty string or a masked value: secret unchanged
  it('TEST 9: Update with empty string or masked value leaves secret unchanged', async () => {
    const originalSecret = 'whsec_secret_to_keep_unchanged';

    const ep = await endpointService.createEndpoint('ws-1', {
      name: 'Masked and Empty Update Test',
      destinationUrl: 'https://example.com/dest',
      signatureConfig: {
        provider: 'github',
        secret: originalSecret,
        enforce: true,
      },
    });

    // 1. Update with empty string ""
    await endpointService.updateEndpoint(ep.id, {
      signatureConfig: {
        provider: 'github',
        secret: '',
      },
    });

    // 2. Update with masked placeholder e.g. "****1234"
    await endpointService.updateEndpoint(ep.id, {
      signatureConfig: {
        provider: 'github',
        secret: '****1234',
      },
    });

    // 3. Update with bullets placeholder "••••••••"
    await endpointService.updateEndpoint(ep.id, {
      signatureConfig: {
        provider: 'github',
        secret: '••••••••',
      },
    });

    // The original secret must still be active and working
    const rawBody = JSON.stringify({ verified: true });
    const validSignature = `sha256=${createHmac('sha256', originalSecret).update(rawBody, 'utf8').digest('hex')}`;

    const res = await ingestService.handleIngest({
      slug: ep.slug,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': validSignature,
      },
      rawBody,
      bodySize: rawBody.length,
      sourceIp: '1.2.3.4',
    });

    expect(res.eventId).toBeDefined();
    expect(eventsDb[0]!.signatureValid).toBe(true);
  });

  // TEST 10: GET endpoint never contains secret or secretEncrypted
  it('TEST 10: GET endpoint never exposes raw secret or secretEncrypted', async () => {
    const rawSecret = 'whsec_super_secret_payload_key_9999';

    const created = await endpointService.createEndpoint('ws-1', {
      name: 'Exposure Test Endpoint',
      destinationUrl: 'https://example.com/dest',
      signatureConfig: {
        provider: 'stripe',
        secret: rawSecret,
        enforce: true,
      },
    });

    // Read by ID
    const getRes = await endpointService.getEndpoint(created.id);
    expect((getRes as Record<string, unknown>).secret).toBeUndefined();
    expect((getRes as Record<string, unknown>).secretEncrypted).toBeUndefined();
    expect((getRes.signatureConfig as Record<string, unknown>).secret).toBeUndefined();
    expect((getRes.signatureConfig as Record<string, unknown>).secretEncrypted).toBeUndefined();

    // Check exposed safe fields
    expect(getRes.signatureConfig.secretConfigured).toBe(true);
    expect(getRes.signatureConfig.secretLast4).toBe('9999');
    expect(getRes.signatureConfig.secretMasked).toBe('****9999');

    // List endpoints in workspace
    const list = await endpointService.listWorkspaceEndpoints('ws-1');
    expect(list).toHaveLength(1);
    const item = list[0]!;
    expect((item as Record<string, unknown>).secret).toBeUndefined();
    expect((item as Record<string, unknown>).secretEncrypted).toBeUndefined();
    expect((item.signatureConfig as Record<string, unknown>).secret).toBeUndefined();
    expect((item.signatureConfig as Record<string, unknown>).secretEncrypted).toBeUndefined();
    expect(item.signatureConfig.secretConfigured).toBe(true);
    expect(item.signatureConfig.secretLast4).toBe('9999');
  });

  // BONUS TEST: Changing provider to one needing secret when none exists returns 400
  it('BONUS: Changing provider to one requiring secret when none exists returns 400 error', async () => {
    const ep = await endpointService.createEndpoint('ws-1', {
      name: 'None Provider Endpoint',
      destinationUrl: 'https://example.com/dest',
      signatureConfig: {
        provider: 'none',
      },
    });

    await expect(
      endpointService.updateEndpoint(ep.id, {
        signatureConfig: {
          provider: 'github',
          // No secret provided!
        },
      }),
    ).rejects.toThrow("Provider 'github' requires a signing secret");
  });
});
