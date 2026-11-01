import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import * as sharedModule from '@hookpilot/shared';
import { IngestService } from '../services/ingest.service.js';
import { destinationService } from '../services/destination.service.js';
import { EventService } from '../services/event.service.js';
import { recomputeEventStatus } from '../services/delivery-status.service.js';
import { EventModel, type IEvent } from '../models/Event.js';
import { EndpointModel } from '../models/Endpoint.js';
import { DeliveryModel } from '../models/Delivery.js';
import * as queueConfig from '../config/queue.js';
import * as redisConfig from '../config/redis.js';

describe('Filtered Event & Destination Filter Handling Flow', () => {
  const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'mock-job-1' });
  const mockQueueAddBulk = vi.fn().mockResolvedValue([{ id: 'mock-job-bulk' }]);

  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(sharedModule, 'validateDestinationUrl').mockResolvedValue(true);

    const mockQueue = {
      add: mockQueueAdd,
      addBulk: mockQueueAddBulk,
    };
    vi.spyOn(queueConfig, 'getDeliveryQueue').mockReturnValue(mockQueue as any);

    const mockRedis = {
      status: 'ready',
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      publish: vi.fn().mockResolvedValue(1),
    };
    vi.spyOn(redisConfig, 'getRedisClient').mockReturnValue(mockRedis as any);
  });

  it('1. Ingest request always returns 202 and saves event as filtered when destination filter fails on missing field', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();
    const eventId = new Types.ObjectId();
    const destId = new Types.ObjectId();

    const mockEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      workspaceId,
      slug: 'ep-test-filter',
      isActive: true,
      mode: 'normal',
      rateLimitPerMin: 1000,
      signatureConfig: null,
    };

    // Filter looks for body.type eq "order.paid"
    const mockDestination = {
      _id: destId,
      workspaceId,
      endpointId,
      name: 'Order Paid Webhook',
      url: 'https://orders.internal.api/hooks',
      isActive: true,
      filter: {
        combinator: 'and',
        conditions: [{ field: 'body.type', op: 'eq', value: 'order.paid' }],
      },
    };

    let savedEvent: any = null;
    const mockEventRepo = {
      create: vi.fn().mockImplementation(async (data: any) => {
        savedEvent = {
          _id: eventId,
          id: eventId.toString(),
          ...data,
          status: 'pending',
          attemptCount: 0,
          receivedAt: new Date(),
        };
        return { event: savedEvent, isDuplicate: false };
      }),
      findById: vi.fn().mockImplementation(async () => savedEvent),
      findEndpointEvents: vi.fn(),
      findByIdWithAttempts: vi.fn(),
      findByEndpoint: vi.fn(),
      replay: vi.fn(),
      findEventsForBulkReplay: vi.fn(),
      delete: vi.fn(),
    };

    const mockEndpointRepo = {
      findBySlug: vi.fn().mockResolvedValue(mockEndpoint),
      findById: vi.fn().mockResolvedValue(mockEndpoint),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      listByWorkspace: vi.fn(),
    };

    vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([
      mockDestination as any,
    ]);

    let insertedDeliveries: any[] = [];
    vi.spyOn(DeliveryModel, 'insertMany').mockImplementation(async (docs: any[]) => {
      insertedDeliveries = docs.map((d) => ({
        ...d,
        _id: new Types.ObjectId(),
      }));
      return insertedDeliveries as any;
    });

    vi.spyOn(EndpointModel, 'findById').mockResolvedValue(mockEndpoint as any);
    vi.spyOn(DeliveryModel, 'find').mockImplementation(async () => insertedDeliveries as any);
    vi.spyOn(EventModel, 'findById').mockImplementation(async () => {
      if (!savedEvent) return null;
      return {
        ...savedEvent,
        save: vi.fn().mockImplementation(async function (this: any) {
          savedEvent.status = this.status;
          return this;
        }),
      } as any;
    });

    const ingestService = new IngestService(mockEndpointRepo as any, mockEventRepo as any);

    // Incoming body is {"amount":7000} with NO "type" field
    const result = await ingestService.handleIngest({
      slug: 'ep-test-filter',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: JSON.stringify({ amount: 7000 }),
      bodySize: 15,
      contentType: 'application/json',
      sourceIp: '127.0.0.1',
    });

    expect(result.eventId).toBe(eventId.toString());
    expect(result.isDuplicate).toBe(false);

    // 2. Delivery row exists for the destination with status 'filtered' and reason containing missing field
    expect(insertedDeliveries).toHaveLength(1);
    const del = insertedDeliveries[0];
    expect(del.status).toBe('filtered');
    expect(del.attemptCount).toBe(0);
    expect(del.nextAttemptAt).toBeNull();
    expect(del.filterReason).toContain('body.type eq "order.paid": field missing');

    // 2. NO BullMQ job is enqueued
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockQueueAddBulk).not.toHaveBeenCalled();

    // 3. Event status is 'filtered' because all destinations are filtered
    expect(savedEvent.status).toBe('filtered');
  });

  it('3. Event status is "delivered" when one destination matches and delivers, and another is filtered', async () => {
    const eventId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();

    const mockEndpoint = {
      _id: endpointId,
      mode: 'normal',
    };

    const dest1 = { _id: new Types.ObjectId(), name: 'Dest 1' };
    const dest2 = { _id: new Types.ObjectId(), name: 'Dest 2' };

    // Dest 1 matched and delivered, Dest 2 was filtered
    const deliveries = [
      {
        _id: new Types.ObjectId(),
        eventId,
        destinationId: dest1._id,
        status: 'delivered',
        filterReason: null,
      },
      {
        _id: new Types.ObjectId(),
        eventId,
        destinationId: dest2._id,
        status: 'filtered',
        filterReason: 'Condition failed: body.type eq "order.paid": field missing',
      },
    ];

    const mockEvent = {
      _id: eventId,
      endpointId,
      status: 'pending',
      save: vi.fn().mockResolvedValue(true),
    };

    vi.spyOn(EventModel, 'findById').mockResolvedValue(mockEvent as any);
    vi.spyOn(EndpointModel, 'findById').mockResolvedValue(mockEndpoint as any);
    vi.spyOn(DeliveryModel, 'find').mockResolvedValue(deliveries as any);

    const finalStatus = await recomputeEventStatus(eventId);

    expect(finalStatus).toBe('delivered');
    expect(mockEvent.status).toBe('delivered');
  });

  it('4. If destination filter evaluation throws, treat destination as "filtered" with reason "filter error" without crashing', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();
    const eventId = new Types.ObjectId();

    const mockEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      workspaceId,
      slug: 'ep-throwing-filter',
      isActive: true,
      mode: 'normal',
      rateLimitPerMin: 1000,
    };

    // Broken filter structure that could cause unexpected runtime issue
    const mockDestination = {
      _id: new Types.ObjectId(),
      workspaceId,
      endpointId,
      name: 'Exploding Filter Destination',
      url: 'https://exploding.destination/webhook',
      isActive: true,
      filter: {
        get conditions() {
          throw new Error('Unexpected filter internal failure');
        },
      },
    };

    let savedEvent: any = null;
    const mockEventRepo = {
      create: vi.fn().mockImplementation(async (data: any) => {
        savedEvent = {
          _id: eventId,
          id: eventId.toString(),
          ...data,
          status: 'pending',
        };
        return { event: savedEvent, isDuplicate: false };
      }),
      findById: vi.fn(),
    };

    const mockEndpointRepo = {
      findBySlug: vi.fn().mockResolvedValue(mockEndpoint),
    };

    vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([
      mockDestination as any,
    ]);

    let insertedDeliveries: any[] = [];
    vi.spyOn(DeliveryModel, 'insertMany').mockImplementation(async (docs: any[]) => {
      insertedDeliveries = docs.map((d) => ({
        ...d,
        _id: new Types.ObjectId(),
      }));
      return insertedDeliveries as any;
    });

    vi.spyOn(EndpointModel, 'findById').mockResolvedValue(mockEndpoint as any);
    vi.spyOn(DeliveryModel, 'find').mockImplementation(async () => insertedDeliveries as any);
    vi.spyOn(EventModel, 'findById').mockImplementation(async () => {
      if (!savedEvent) return null;
      return {
        ...savedEvent,
        save: vi.fn().mockImplementation(async function (this: any) {
          savedEvent.status = this.status;
          return this;
        }),
      } as any;
    });

    const ingestService = new IngestService(mockEndpointRepo as any, mockEventRepo as any);

    // Ingest should NOT throw 500; it must gracefully complete
    await expect(
      ingestService.handleIngest({
        slug: 'ep-throwing-filter',
        method: 'POST',
        headers: {},
        rawBody: '{"amount": 5000}',
        bodySize: 16,
        contentType: 'application/json',
        sourceIp: '127.0.0.1',
      }),
    ).resolves.toEqual({
      eventId: eventId.toString(),
      isDuplicate: false,
    });

    // Destination delivery row gets status: 'filtered' with reason: 'filter error'
    expect(insertedDeliveries).toHaveLength(1);
    expect(insertedDeliveries[0].status).toBe('filtered');
    expect(insertedDeliveries[0].filterReason).toBe('filter error');
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockQueueAddBulk).not.toHaveBeenCalled();
  });

  it('5. Event list API includes filtered events by default and filters by status=filtered when queried', async () => {
    const endpointId = new Types.ObjectId().toString();

    const mockEvents: IEvent[] = [
      {
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(),
        endpointId: new Types.ObjectId(endpointId),
        receivedAt: new Date(),
        method: 'POST',
        headers: new Map([['content-type', 'application/json']]),
        rawBody: '{"amount": 7000}',
        bodySize: 15,
        contentType: 'application/json',
        sourceIp: '127.0.0.1',
        signatureValid: true,
        idempotencyKey: 'key-1',
        status: 'filtered',
        attemptCount: 0,
        replayCount: 0,
        searchIndex: '',
      } as any,
    ];

    const mockEventRepo = {
      findEndpointEvents: vi.fn().mockImplementation(async (params: any) => {
        // If status filter is passed and does not match, return empty
        if (params.status && params.status !== 'filtered') {
          return { events: [], nextCursor: null, hasNextPage: false };
        }
        return { events: mockEvents, nextCursor: null, hasNextPage: false };
      }),
    };

    const eventService = new EventService(mockEventRepo as any);

    // Default query (no status parameter) -> returns filtered event
    const defaultList = await eventService.getEndpointEvents(endpointId, { limit: 20 });
    expect(defaultList.events).toHaveLength(1);
    expect(defaultList.events[0].status).toBe('filtered');
    expect(mockEventRepo.findEndpointEvents).toHaveBeenCalledWith(
      expect.objectContaining({ status: undefined }),
    );

    // Filtered status query (status='filtered') -> returns filtered event
    const filteredList = await eventService.getEndpointEvents(endpointId, {
      status: 'filtered',
      limit: 20,
    });
    expect(filteredList.events).toHaveLength(1);
    expect(filteredList.events[0].status).toBe('filtered');
    expect(mockEventRepo.findEndpointEvents).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'filtered' }),
    );

    // Other status query (status='delivered') -> returns empty
    const deliveredList = await eventService.getEndpointEvents(endpointId, {
      status: 'delivered',
      limit: 20,
    });
    expect(deliveredList.events).toHaveLength(0);
  });
});
