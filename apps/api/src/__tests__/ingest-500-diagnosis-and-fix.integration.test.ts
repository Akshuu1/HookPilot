import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { IngestService } from '../services/ingest.service.js';
import { destinationService } from '../services/destination.service.js';
import * as deliveryStatusService from '../services/delivery-status.service.js';
import { ReconcilerService } from '../../../../apps/worker/src/services/reconciler.service.js';
import { DeliveryModel } from '../models/Delivery.js';
import * as workerDeliveryModel from '../../../../apps/worker/src/models/Delivery.js';
import * as queueConfig from '../config/queue.js';
import * as redisConfig from '../config/redis.js';
import * as workerRedisConfig from '../../../../apps/worker/src/config/redis.js';

describe('Ingest 500 Diagnosis and Guarantees Verification', () => {
  const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'mock-job-1' });
  const mockQueueAddBulk = vi.fn().mockResolvedValue([{ id: 'mock-job-bulk' }]);

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
      const exIdx = args.indexOf('EX');
      const ttlSec = exIdx !== -1 ? Number(args[exIdx + 1]) : 10;
      const isNx = args.includes('NX');

      const existing = redisStore.get(key);
      const isExpired = existing && existing.expiresAt <= nowMs;
      if (isNx && existing && !isExpired) {
        return null;
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

    vi.spyOn(deliveryStatusService, 'recomputeEventStatus').mockResolvedValue('pending');

    const mockQueue = {
      add: mockQueueAdd,
      addBulk: mockQueueAddBulk,
      getJob: vi.fn().mockResolvedValue(null),
    };
    vi.spyOn(queueConfig, 'getDeliveryQueue').mockReturnValue(mockQueue as any);
    vi.spyOn(workerRedisConfig, 'getDeliveryQueue').mockReturnValue(mockQueue as any);
    vi.spyOn(redisConfig, 'getRedisClient').mockReturnValue(mockRedis as any);
  });

  it('1. Same body sent twice returns 202 both times with the same eventId and does not create duplicate deliveries', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();
    const eventId = new Types.ObjectId();

    const mockEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      workspaceId,
      slug: 'ep-reproduce-dup',
      isActive: true,
      mode: 'normal',
      duplicateWindowSeconds: 10,
    };

    const mockEndpointRepo = {
      findBySlug: vi.fn().mockResolvedValue(mockEndpoint),
    };

    const eventDoc: any = {
      _id: eventId,
      id: eventId.toString(),
      workspaceId,
      endpointId,
      rawBody: '{"type":"order.paid","amount":7000}',
      duplicateCount: 0,
      duplicateLog: [],
      status: 'pending',
    };

    let createCallCount = 0;
    const mockEventRepo = {
      create: vi.fn().mockImplementation(async () => {
        createCallCount++;
        if (createCallCount === 1) {
          return { event: eventDoc, isDuplicate: false };
        }
        // Second call simulates E11000 or duplicate resolution
        eventDoc.duplicateCount++;
        return { event: eventDoc, isDuplicate: true };
      }),
      recordDuplicate: vi.fn().mockImplementation(async () => {
        eventDoc.duplicateCount++;
        return eventDoc;
      }),
      findById: vi.fn().mockResolvedValue(eventDoc),
      findEndpointEvents: vi.fn().mockResolvedValue({ events: [eventDoc] }),
    };

    const dest1 = {
      _id: new Types.ObjectId(),
      endpointId,
      name: 'All Events Dest',
      url: 'https://httpbin.org/post',
      filter: null,
      isActive: true,
    };
    const dest2 = {
      _id: new Types.ObjectId(),
      endpointId,
      name: 'Paid Orders Dest',
      url: 'https://httpbin.org/post',
      filter: {
        operator: 'and',
        conditions: [
          {
            field: 'body.type',
            op: 'eq',
            value: 'order.paid',
          },
        ],
      },
      isActive: true,
    };

    vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([dest1, dest2] as any);

    // Mock DeliveryModel.insertMany
    const persistedDeliveries: any[] = [];
    vi.spyOn(DeliveryModel, 'insertMany').mockImplementation(async (docs: any) => {
      for (const d of docs) {
        persistedDeliveries.push({
          _id: new Types.ObjectId(),
          ...d,
        });
      }
      return persistedDeliveries as any;
    });

    const ingestService = new IngestService(mockEndpointRepo as any, mockEventRepo as any);

    // Request 1
    const res1 = await ingestService.handleIngest({
      slug: 'ep-reproduce-dup',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{"type":"order.paid","amount":7000}',
      bodySize: 32,
      sourceIp: '127.0.0.1',
    });

    expect(res1.eventId).toBe(eventId.toString());
    expect(res1.isDuplicate).toBe(false);
    expect(mockQueueAddBulk).toHaveBeenCalledTimes(1);

    // Request 2 with same body (within window or E11000 duplicate)
    const res2 = await ingestService.handleIngest({
      slug: 'ep-reproduce-dup',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{"type":"order.paid","amount":7000}',
      bodySize: 32,
      sourceIp: '127.0.0.1',
    });

    expect(res2.eventId).toBe(eventId.toString());
    expect(res2.isDuplicate).toBe(true);
    // Queue should NOT be called again for duplicates!
    expect(mockQueueAddBulk).toHaveBeenCalledTimes(1);
  });

  it('2. Matching and non-matching destinations in one event: correct statuses and jobs', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();
    const eventId = new Types.ObjectId();

    const mockEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      workspaceId,
      slug: 'ep-matching-dest',
      isActive: true,
      mode: 'normal',
      duplicateWindowSeconds: 10,
    };

    const mockEndpointRepo = {
      findBySlug: vi.fn().mockResolvedValue(mockEndpoint),
    };

    const eventDoc: any = {
      _id: eventId,
      id: eventId.toString(),
      workspaceId,
      endpointId,
      rawBody: '{"type":"other","amount":7000}',
      status: 'pending',
    };

    const mockEventRepo = {
      create: vi.fn().mockResolvedValue({ event: eventDoc, isDuplicate: false }),
      recordDuplicate: vi.fn(),
      findById: vi.fn().mockResolvedValue(eventDoc),
    };

    const dest1 = {
      _id: new Types.ObjectId(),
      endpointId,
      name: 'Unfiltered Dest',
      url: 'https://httpbin.org/post',
      filter: null,
      isActive: true,
    };
    const dest2 = {
      _id: new Types.ObjectId(),
      endpointId,
      name: 'Filtered Dest',
      url: 'https://httpbin.org/post',
      filter: {
        operator: 'and',
        conditions: [
          {
            field: 'body.type',
            op: 'eq',
            value: 'order.paid',
          },
        ],
      },
      isActive: true,
    };

    vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([dest1, dest2] as any);

    let capturedDeliveries: any[] = [];
    vi.spyOn(DeliveryModel, 'insertMany').mockImplementation(async (docs: any) => {
      capturedDeliveries = docs.map((d: any) => ({
        _id: new Types.ObjectId(),
        ...d,
      }));
      return capturedDeliveries as any;
    });

    const ingestService = new IngestService(mockEndpointRepo as any, mockEventRepo as any);

    const res = await ingestService.handleIngest({
      slug: 'ep-matching-dest',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{"type":"other","amount":7000}',
      bodySize: 30,
      sourceIp: '127.0.0.1',
    });

    expect(res.eventId).toBe(eventId.toString());
    expect(capturedDeliveries).toHaveLength(2);

    const d1 = capturedDeliveries.find((d) => String(d.destinationId) === String(dest1._id));
    const d2 = capturedDeliveries.find((d) => String(d.destinationId) === String(dest2._id));

    expect(d1.status).toBe('pending');
    expect(d2.status).toBe('filtered');
    expect(d2.filterReason).toContain('order.paid');

    // Only 1 job queued for dest1 (dest2 is filtered)
    expect(mockQueueAddBulk).toHaveBeenCalledWith([
      expect.objectContaining({
        data: { deliveryId: d1._id.toString() },
        opts: expect.objectContaining({ jobId: d1._id.toString() }),
      }),
    ]);
  });

  it('3. Enqueue failure (queue throws) still returns 202 and leaves pending deliveries in DB', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();
    const eventId = new Types.ObjectId();

    const mockEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      workspaceId,
      slug: 'ep-queue-fail',
      isActive: true,
      mode: 'normal',
      duplicateWindowSeconds: 0,
    };

    const mockEndpointRepo = {
      findBySlug: vi.fn().mockResolvedValue(mockEndpoint),
    };

    const eventDoc: any = {
      _id: eventId,
      id: eventId.toString(),
      workspaceId,
      endpointId,
      rawBody: '{"type":"order.paid","amount":7000}',
      status: 'pending',
    };

    const mockEventRepo = {
      create: vi.fn().mockResolvedValue({ event: eventDoc, isDuplicate: false }),
      recordDuplicate: vi.fn(),
      findById: vi.fn().mockResolvedValue(eventDoc),
    };

    const dest = {
      _id: new Types.ObjectId(),
      endpointId,
      name: 'Target Dest',
      url: 'https://httpbin.org/post',
      filter: null,
      isActive: true,
    };

    vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([dest] as any);

    const persisted: any[] = [];
    vi.spyOn(DeliveryModel, 'insertMany').mockImplementation(async (docs: any) => {
      for (const d of docs) {
        persisted.push({
          _id: new Types.ObjectId(),
          ...d,
        });
      }
      return persisted as any;
    });

    // Mock queue to throw Redis connection error
    mockQueueAddBulk.mockRejectedValue(new Error('Redis connection refused: ECONNREFUSED'));

    const ingestService = new IngestService(mockEndpointRepo as any, mockEventRepo as any);

    // Ingest MUST NOT return 500! It must return 202 with eventId!
    const res = await ingestService.handleIngest({
      slug: 'ep-queue-fail',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{"type":"order.paid","amount":7000}',
      bodySize: 32,
      sourceIp: '127.0.0.1',
    });

    expect(res.eventId).toBe(eventId.toString());
    expect(persisted).toHaveLength(1);
    expect(persisted[0].status).toBe('pending'); // Left pending for reconciler
  });

  it('4. Reconciler enqueues orphaned pending deliveries exactly once', async () => {
    const deliveryId1 = new Types.ObjectId();
    const deliveryId2 = new Types.ObjectId();

    const orphanedDeliveries = [
      { _id: deliveryId1, status: 'pending' },
      { _id: deliveryId2, status: 'pending' },
    ];

    vi.spyOn(workerDeliveryModel.DeliveryModel, 'find').mockResolvedValue(
      orphanedDeliveries as any,
    );
    vi.spyOn(DeliveryModel, 'find').mockResolvedValue(orphanedDeliveries as any);

    const mockQueue = {
      getJob: vi.fn().mockResolvedValue(null),
      add: vi.fn().mockResolvedValue({ id: 'job-reconciled' }),
    };
    vi.spyOn(workerRedisConfig, 'getDeliveryQueue').mockReturnValue(mockQueue as any);

    const reconciler = new ReconcilerService();
    const result = await reconciler.reconcile();

    expect(result.enqueuedCount).toBe(2);
    expect(mockQueue.add).toHaveBeenCalledTimes(2);
    expect(mockQueue.add).toHaveBeenCalledWith(
      'deliver',
      { deliveryId: deliveryId1.toString() },
      { jobId: deliveryId1.toString(), attempts: 1, removeOnComplete: true },
    );
  });

  it('5. Duplicate jobId is handled as success without throwing error', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();
    const eventId = new Types.ObjectId();

    const mockEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      workspaceId,
      slug: 'ep-dup-job-id',
      isActive: true,
      mode: 'normal',
      duplicateWindowSeconds: 0,
    };

    const mockEndpointRepo = {
      findBySlug: vi.fn().mockResolvedValue(mockEndpoint),
    };

    const eventDoc: any = {
      _id: eventId,
      id: eventId.toString(),
      workspaceId,
      endpointId,
      rawBody: '{"type":"order.paid"}',
      status: 'pending',
    };

    const mockEventRepo = {
      create: vi.fn().mockResolvedValue({ event: eventDoc, isDuplicate: false }),
      recordDuplicate: vi.fn(),
      findById: vi.fn().mockResolvedValue(eventDoc),
    };

    const dest = {
      _id: new Types.ObjectId(),
      endpointId,
      name: 'Dest',
      url: 'https://httpbin.org/post',
      filter: null,
      isActive: true,
    };

    vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([dest] as any);
    vi.spyOn(DeliveryModel, 'insertMany').mockResolvedValue([
      { _id: new Types.ObjectId(), status: 'pending' },
    ] as any);

    // BullMQ throws 'Job already exists'
    mockQueueAddBulk.mockRejectedValue(new Error('Job 654321 already exists'));

    const ingestService = new IngestService(mockEndpointRepo as any, mockEventRepo as any);

    // Must succeed without throwing
    const res = await ingestService.handleIngest({
      slug: 'ep-dup-job-id',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{"type":"order.paid"}',
      bodySize: 21,
      sourceIp: '127.0.0.1',
    });

    expect(res.eventId).toBe(eventId.toString());
  });

  it('6. Endpoint with no Destinations still returns 202 without error', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();
    const eventId = new Types.ObjectId();

    const mockEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      workspaceId,
      slug: 'ep-no-dests',
      isActive: true,
      mode: 'normal',
      duplicateWindowSeconds: 0,
      destinationUrl: undefined,
    };

    const mockEndpointRepo = {
      findBySlug: vi.fn().mockResolvedValue(mockEndpoint),
    };

    const eventDoc: any = {
      _id: eventId,
      id: eventId.toString(),
      workspaceId,
      endpointId,
      rawBody: '{"type":"order.paid"}',
      status: 'pending',
    };

    const mockEventRepo = {
      create: vi.fn().mockResolvedValue({ event: eventDoc, isDuplicate: false }),
      recordDuplicate: vi.fn(),
      findById: vi.fn().mockResolvedValue(eventDoc),
    };

    vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([]);

    const ingestService = new IngestService(mockEndpointRepo as any, mockEventRepo as any);

    const res = await ingestService.handleIngest({
      slug: 'ep-no-dests',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{"type":"order.paid"}',
      bodySize: 21,
      sourceIp: '127.0.0.1',
    });

    expect(res.eventId).toBe(eventId.toString());
    expect(mockQueueAddBulk).not.toHaveBeenCalled();
  });
});
