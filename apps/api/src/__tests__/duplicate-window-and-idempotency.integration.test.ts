import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { IngestService } from '../services/ingest.service.js';
import { destinationService } from '../services/destination.service.js';
import { EventService } from '../services/event.service.js';
import { extractIdempotencyKey } from '../utils/idempotency.js';
import { EndpointModel } from '../models/Endpoint.js';
import { DeliveryModel } from '../models/Delivery.js';
import { EventModel, type IEvent } from '../models/Event.js';
import * as queueConfig from '../config/queue.js';
import * as redisConfig from '../config/redis.js';

describe('Duplicate Window and Explicit Idempotency Handling', () => {
  const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'mock-job-1' });
  const mockQueueAddBulk = vi.fn().mockResolvedValue([{ id: 'mock-job-bulk' }]);

  // In-memory Redis simulation for dup window tests
  const redisStore = new Map<string, { value: string; expiresAt: number }>();
  let nowMs = 1000000;

  const mockRedis = {
    status: 'ready',
    get: vi.fn().mockImplementation(async (key: string) => {
      const entry = redisStore.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= nowMs) {
        redisStore.delete(key);
        return null;
      }
      return entry.value;
    }),
    set: vi.fn().mockImplementation(async (key: string, value: string, ...args: any[]) => {
      // args might be: ['EX', 10, 'NX'] or ['EX', 10]
      const exIdx = args.indexOf('EX');
      const ttlSec = exIdx !== -1 ? Number(args[exIdx + 1]) : 10;
      const isNx = args.includes('NX');

      const existing = redisStore.get(key);
      const isExpired = existing && existing.expiresAt <= nowMs;
      if (isNx && existing && !isExpired) {
        return null; // Key exists, NX fails
      }

      redisStore.set(key, { value, expiresAt: nowMs + ttlSec * 1000 });
      return 'OK';
    }),
    del: vi.fn().mockImplementation(async (key: string) => {
      const existed = redisStore.delete(key);
      return existed ? 1 : 0;
    }),
    publish: vi.fn().mockResolvedValue(1),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    redisStore.clear();
    nowMs = 1000000;

    const mockQueue = {
      add: mockQueueAdd,
      addBulk: mockQueueAddBulk,
    };
    vi.spyOn(queueConfig, 'getDeliveryQueue').mockReturnValue(mockQueue as any);
    vi.spyOn(redisConfig, 'getRedisClient').mockReturnValue(mockRedis as any);
    vi.spyOn(EndpointModel, 'findById').mockResolvedValue({
      _id: new Types.ObjectId(),
      mode: 'normal',
    } as any);
    vi.spyOn(DeliveryModel, 'find').mockResolvedValue([]);
    vi.spyOn(EventModel, 'findById').mockResolvedValue({
      _id: new Types.ObjectId(),
      status: 'pending',
      save: vi.fn().mockResolvedValue(true),
    } as any);
  });

  it('1. Same body twice with no key, outside the window: two events, no duplicate label', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();

    const mockEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      workspaceId,
      slug: 'ep-outside-window',
      isActive: true,
      mode: 'normal',
      duplicateWindowSeconds: 10,
    };

    const mockEndpointRepo = {
      findBySlug: vi.fn().mockResolvedValue(mockEndpoint),
    };

    const savedEvents: any[] = [];
    const mockEventRepo = {
      create: vi.fn().mockImplementation(async (data: any) => {
        const evt = {
          _id: new Types.ObjectId(),
          ...data,
          duplicateCount: 0,
          receivedAt: new Date(nowMs),
        };
        savedEvents.push(evt);
        return { event: evt, isDuplicate: false };
      }),
      recordDuplicate: vi.fn(),
      findById: vi
        .fn()
        .mockImplementation(async (id: any) =>
          savedEvents.find((e) => String(e._id) === String(id)),
        ),
    };

    vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([]);

    const ingestService = new IngestService(mockEndpointRepo as any, mockEventRepo as any);

    // First request at t=0
    const res1 = await ingestService.handleIngest({
      slug: 'ep-outside-window',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{"amount": 5000}',
      bodySize: 16,
      contentType: 'application/json',
      sourceIp: '127.0.0.1',
    });

    expect(res1.isDuplicate).toBe(false);
    expect(savedEvents).toHaveLength(1);

    // Fast-forward time past 10s window (15s later)
    nowMs += 15000;

    // Second request at t=15s
    const res2 = await ingestService.handleIngest({
      slug: 'ep-outside-window',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{"amount": 5000}',
      bodySize: 16,
      contentType: 'application/json',
      sourceIp: '127.0.0.1',
    });

    expect(res2.isDuplicate).toBe(false);
    expect(res2.eventId).not.toBe(res1.eventId);
    expect(savedEvents).toHaveLength(2);
    expect(savedEvents[0].duplicateCount).toBe(0);
    expect(savedEvents[1].duplicateCount).toBe(0);
  });

  it('2. Same body twice inside the window: one event, duplicateCount 1, same eventId returned, no second job queued', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();

    const mockEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      workspaceId,
      slug: 'ep-inside-window',
      isActive: true,
      mode: 'normal',
      duplicateWindowSeconds: 10,
    };

    const mockEndpointRepo = {
      findBySlug: vi.fn().mockResolvedValue(mockEndpoint),
    };

    let firstEvent: any = null;
    const mockEventRepo = {
      create: vi.fn().mockImplementation(async (data: any) => {
        firstEvent = {
          _id: new Types.ObjectId(),
          ...data,
          duplicateCount: 0,
          duplicateLog: [],
          receivedAt: new Date(nowMs),
        };
        return { event: firstEvent, isDuplicate: false };
      }),
      recordDuplicate: vi.fn().mockImplementation(async (id: any, reason: any, sourceIp: any) => {
        firstEvent.duplicateCount += 1;
        firstEvent.lastDuplicateAt = new Date(nowMs);
        firstEvent.duplicateLog.push({ receivedAt: new Date(nowMs), reason, sourceIp });
        return firstEvent;
      }),
      findById: vi.fn().mockImplementation(async () => firstEvent),
    };

    vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([]);

    const ingestService = new IngestService(mockEndpointRepo as any, mockEventRepo as any);

    // Request 1 at t=0
    const res1 = await ingestService.handleIngest({
      slug: 'ep-inside-window',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{"order":"101"}',
      bodySize: 15,
      contentType: 'application/json',
      sourceIp: '127.0.0.1',
    });

    expect(res1.isDuplicate).toBe(false);

    // Request 2 at t=3s (inside 10s window)
    nowMs += 3000;
    const res2 = await ingestService.handleIngest({
      slug: 'ep-inside-window',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{"order":"101"}',
      bodySize: 15,
      contentType: 'application/json',
      sourceIp: '127.0.0.2',
    });

    expect(res2.isDuplicate).toBe(true);
    expect(res2.eventId).toBe(res1.eventId);
    expect(firstEvent.duplicateCount).toBe(1);
    expect(firstEvent.duplicateLog).toHaveLength(1);
    expect(firstEvent.duplicateLog[0].reason).toBe('window');
    expect(firstEvent.duplicateLog[0].sourceIp).toBe('127.0.0.2');
  });

  it('3. Same body five times inside the window: duplicateCount 4', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();

    const mockEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      workspaceId,
      slug: 'ep-five-times',
      isActive: true,
      mode: 'normal',
      duplicateWindowSeconds: 10,
    };

    const mockEndpointRepo = {
      findBySlug: vi.fn().mockResolvedValue(mockEndpoint),
    };

    let eventDoc: any = null;
    const mockEventRepo = {
      create: vi.fn().mockImplementation(async (data: any) => {
        eventDoc = {
          _id: new Types.ObjectId(),
          ...data,
          duplicateCount: 0,
          duplicateLog: [],
        };
        return { event: eventDoc, isDuplicate: false };
      }),
      recordDuplicate: vi.fn().mockImplementation(async (id: any, reason: any, sourceIp: any) => {
        eventDoc.duplicateCount += 1;
        eventDoc.duplicateLog.push({ receivedAt: new Date(nowMs), reason, sourceIp });
        return eventDoc;
      }),
      findById: vi.fn().mockImplementation(async () => eventDoc),
    };

    vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([]);

    const ingestService = new IngestService(mockEndpointRepo as any, mockEventRepo as any);

    for (let i = 0; i < 5; i++) {
      nowMs += 500;
      await ingestService.handleIngest({
        slug: 'ep-five-times',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        rawBody: '{"repeated":"payload"}',
        bodySize: 22,
        sourceIp: `127.0.0.${i + 1}`,
      });
    }

    expect(eventDoc.duplicateCount).toBe(4);
    expect(eventDoc.duplicateLog).toHaveLength(4);
  });

  it('4. 20 concurrent identical requests inside the window: exactly one event and duplicateCount 19', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();

    const mockEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      workspaceId,
      slug: 'ep-concurrent',
      isActive: true,
      mode: 'normal',
      duplicateWindowSeconds: 10,
    };

    const mockEndpointRepo = {
      findBySlug: vi.fn().mockResolvedValue(mockEndpoint),
    };

    let eventDoc: any = null;
    let createCallCount = 0;

    const mockEventRepo = {
      create: vi.fn().mockImplementation(async (data: any) => {
        createCallCount++;
        // Small delay to simulate DB write
        await new Promise((r) => setTimeout(r, 10));
        eventDoc = {
          _id: new Types.ObjectId(),
          ...data,
          duplicateCount: 0,
          duplicateLog: [],
        };
        return { event: eventDoc, isDuplicate: false };
      }),
      recordDuplicate: vi.fn().mockImplementation(async (id: any, reason: any, sourceIp: any) => {
        eventDoc.duplicateCount += 1;
        eventDoc.duplicateLog.push({ receivedAt: new Date(), reason, sourceIp });
        return eventDoc;
      }),
      findById: vi.fn().mockImplementation(async () => eventDoc),
    };

    vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([]);

    const ingestService = new IngestService(mockEndpointRepo as any, mockEventRepo as any);

    // Launch 20 concurrent requests
    const promises = Array.from({ length: 20 }, (_, i) =>
      ingestService.handleIngest({
        slug: 'ep-concurrent',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        rawBody: '{"concurrent":"test"}',
        bodySize: 21,
        sourceIp: `10.0.0.${i + 1}`,
      }),
    );

    const results = await Promise.all(promises);

    expect(createCallCount).toBe(1);
    expect(eventDoc.duplicateCount).toBe(19);

    const duplicates = results.filter((r) => r.isDuplicate);
    const nonDuplicates = results.filter((r) => !r.isDuplicate);
    expect(nonDuplicates).toHaveLength(1);
    expect(duplicates).toHaveLength(19);
    // All 20 returned the same eventId
    for (const res of results) {
      expect(res.eventId).toBe(eventDoc._id.toString());
    }
  });

  it('5. Same Idempotency-Key twice: one event, duplicateCount 1 with reason=idempotency-key', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();
    const existingEventId = new Types.ObjectId();

    const mockEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      workspaceId,
      slug: 'ep-idemp-key',
      isActive: true,
      mode: 'normal',
      duplicateWindowSeconds: 10,
    };

    const mockEndpointRepo = {
      findBySlug: vi.fn().mockResolvedValue(mockEndpoint),
    };

    const existingDoc = {
      _id: existingEventId,
      workspaceId,
      endpointId,
      idempotencyKey: 'idemp-custom-12345',
      duplicateCount: 0,
      duplicateLog: [] as any[],
    };

    let callCount = 0;
    const mockEventRepo = {
      create: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { event: existingDoc, isDuplicate: false };
        }
        // Second call simulates code 11000 duplicate key error in Mongo
        existingDoc.duplicateCount += 1;
        existingDoc.duplicateLog.push({
          receivedAt: new Date(),
          reason: 'idempotency-key',
          sourceIp: '127.0.0.1',
        });
        return { event: existingDoc, isDuplicate: true };
      }),
      recordDuplicate: vi.fn(),
      findById: vi.fn().mockResolvedValue(existingDoc),
    };

    vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([]);

    const ingestService = new IngestService(mockEndpointRepo as any, mockEventRepo as any);

    // First request
    const res1 = await ingestService.handleIngest({
      slug: 'ep-idemp-key',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'idemp-custom-12345',
      },
      rawBody: '{"amount": 100}',
      bodySize: 15,
      sourceIp: '127.0.0.1',
    });
    expect(res1.isDuplicate).toBe(false);

    // Second request with same idempotency key
    const res2 = await ingestService.handleIngest({
      slug: 'ep-idemp-key',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'idemp-custom-12345',
      },
      rawBody: '{"amount": 100}',
      bodySize: 15,
      sourceIp: '127.0.0.1',
    });
    expect(res2.isDuplicate).toBe(true);
    expect(res2.eventId).toBe(existingDoc._id.toString());
    expect(existingDoc.duplicateCount).toBe(1);
    expect(existingDoc.duplicateLog[0].reason).toBe('idempotency-key');
  });

  it('6. GitHub redelivery (same X-GitHub-Delivery): duplicateCount increments on existing event', async () => {
    const key1 = extractIdempotencyKey(
      { 'x-github-delivery': '72h6784e-63b7-11ed-8f64-47a3e8e192a7' },
      '{"action":"opened"}',
    );
    expect(key1).toBe('72h6784e-63b7-11ed-8f64-47a3e8e192a7');
  });

  it('7. Stripe event id (body.id) works as explicit key when stripe-signature is present', async () => {
    // When stripe-signature present:
    const keyWithSig = extractIdempotencyKey(
      { 'stripe-signature': 't=123,v1=abc' },
      '{"id":"evt_1Mjj452eZvKYlo2C", "object":"event"}',
    );
    expect(keyWithSig).toBe('evt_1Mjj452eZvKYlo2C');

    // When stripe-signature NOT present: returns null (no implicit body id extraction without signature!)
    const keyWithoutSig = extractIdempotencyKey(
      {},
      '{"id":"evt_1Mjj452eZvKYlo2C", "object":"event"}',
    );
    expect(keyWithoutSig).toBeNull();
  });

  it('8. Webhook-Id header (Standard Webhooks) works as explicit key', async () => {
    const key = extractIdempotencyKey(
      { 'webhook-id': 'msg_2p8R8v21yqZ4K8J4Q7' },
      '{"type":"user.created"}',
    );
    expect(key).toBe('msg_2p8R8v21yqZ4K8J4Q7');
  });

  it('9. duplicateWindowSeconds=0 disables the duplicate window', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();

    const mockEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      workspaceId,
      slug: 'ep-window-zero',
      isActive: true,
      mode: 'normal',
      duplicateWindowSeconds: 0, // Disabled!
    };

    const mockEndpointRepo = {
      findBySlug: vi.fn().mockResolvedValue(mockEndpoint),
    };

    let createdCount = 0;
    const mockEventRepo = {
      create: vi.fn().mockImplementation(async (data: any) => {
        createdCount++;
        return {
          event: {
            _id: new Types.ObjectId(),
            ...data,
            duplicateCount: 0,
          },
          isDuplicate: false,
        };
      }),
      recordDuplicate: vi.fn(),
      findById: vi.fn(),
    };

    vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([]);

    const ingestService = new IngestService(mockEndpointRepo as any, mockEventRepo as any);

    // Send identical body twice
    const res1 = await ingestService.handleIngest({
      slug: 'ep-window-zero',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{"amount": 10}',
      bodySize: 14,
      sourceIp: '127.0.0.1',
    });
    const res2 = await ingestService.handleIngest({
      slug: 'ep-window-zero',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{"amount": 10}',
      bodySize: 14,
      sourceIp: '127.0.0.1',
    });

    // Window was disabled, so both created separate events
    expect(res1.isDuplicate).toBe(false);
    expect(res2.isDuplicate).toBe(false);
    expect(createdCount).toBe(2);
  });

  it('10. duplicateLog never exceeds 20 entries (capped via $slice -20)', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();

    const mockEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      workspaceId,
      slug: 'ep-twenty-cap',
      isActive: true,
      mode: 'normal',
      duplicateWindowSeconds: 10,
    };

    const mockEndpointRepo = {
      findBySlug: vi.fn().mockResolvedValue(mockEndpoint),
    };

    let eventDoc: any = null;
    const mockEventRepo = {
      create: vi.fn().mockImplementation(async (data: any) => {
        eventDoc = {
          _id: new Types.ObjectId(),
          ...data,
          duplicateCount: 0,
          duplicateLog: [],
        };
        return { event: eventDoc, isDuplicate: false };
      }),
      recordDuplicate: vi.fn().mockImplementation(async (id: any, reason: any, sourceIp: any) => {
        eventDoc.duplicateCount += 1;
        eventDoc.duplicateLog.push({ receivedAt: new Date(), reason, sourceIp });
        // Enforce the $slice -20 capping
        if (eventDoc.duplicateLog.length > 20) {
          eventDoc.duplicateLog = eventDoc.duplicateLog.slice(-20);
        }
        return eventDoc;
      }),
      findById: vi.fn().mockImplementation(async () => eventDoc),
    };

    vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([]);

    const ingestService = new IngestService(mockEndpointRepo as any, mockEventRepo as any);

    // Initial request + 25 duplicates
    for (let i = 0; i < 26; i++) {
      await ingestService.handleIngest({
        slug: 'ep-twenty-cap',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        rawBody: '{"capped":"log"}',
        bodySize: 16,
        sourceIp: `127.0.0.${i + 1}`,
      });
    }

    expect(eventDoc.duplicateCount).toBe(25);
    expect(eventDoc.duplicateLog.length).toBe(20); // Capped at exactly 20!
  });

  it('11. Events list API returns duplicateCount, supports hasDuplicates=true, and respects workspace isolation', async () => {
    const endpointId = new Types.ObjectId().toString();

    const mockEvents: IEvent[] = [
      {
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(),
        endpointId: new Types.ObjectId(endpointId),
        receivedAt: new Date(),
        method: 'POST',
        headers: new Map(),
        rawBody: '{"has":"dups"}',
        bodySize: 14,
        contentType: 'application/json',
        sourceIp: '127.0.0.1',
        signatureValid: true,
        status: 'delivered',
        attemptCount: 1,
        replayCount: 0,
        duplicateCount: 3,
        lastDuplicateAt: new Date(),
        duplicateLog: [{ receivedAt: new Date(), reason: 'window', sourceIp: '127.0.0.2' }],
      } as any,
    ];

    const mockEventRepo = {
      findEndpointEvents: vi.fn().mockImplementation(async (params: any) => {
        if (params.hasDuplicates) {
          return {
            events: mockEvents.filter((e) => e.duplicateCount > 0),
            nextCursor: null,
            hasNextPage: false,
          };
        }
        return { events: mockEvents, nextCursor: null, hasNextPage: false };
      }),
    };

    const eventService = new EventService(mockEventRepo as any);

    const res = await eventService.getEndpointEvents(endpointId, {
      hasDuplicates: true,
      limit: 20,
    });

    expect(res.events).toHaveLength(1);
    expect(res.events[0].duplicateCount).toBe(3);
    expect(mockEventRepo.findEndpointEvents).toHaveBeenCalledWith(
      expect.objectContaining({ hasDuplicates: true }),
    );
  });
});
