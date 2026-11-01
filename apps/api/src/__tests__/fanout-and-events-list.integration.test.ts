import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import * as sharedModule from '@hookpilot/shared';
import { EventFilterQuerySchema } from '@hookpilot/shared';
import { IngestService } from '../services/ingest.service.js';
import { destinationService } from '../services/destination.service.js';
import { EventService, toEventResponse } from '../services/event.service.js';
import { EventModel, type IEvent } from '../models/Event.js';
import { EndpointModel } from '../models/Endpoint.js';
import { DestinationModel } from '../models/Destination.js';
import { DeliveryModel } from '../models/Delivery.js';
import * as queueConfig from '../config/queue.js';
import * as redisConfig from '../config/redis.js';

describe('Fan-out and Events List Integration Tests', () => {
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

  it('1. Ingest saves Event and returns 202 when endpoint has 0 destinations (capture-only / no dests)', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();
    const eventId = new Types.ObjectId();

    const mockEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      workspaceId,
      slug: 'ep-no-dest',
      isActive: true,
      mode: 'capture-only',
      rateLimitPerMin: 1000,
      signatureConfig: null,
    };

    vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([]);

    const createdEvent: IEvent = {
      _id: eventId,
      workspaceId,
      endpointId,
      receivedAt: new Date(),
      method: 'POST',
      headers: new Map(),
      rawBody: '{"hello":"world"}',
      bodySize: 17,
      contentType: 'application/json',
      sourceIp: '127.0.0.1',
      signatureValid: true,
      idempotencyKey: 'idemp-0',
      status: 'pending',
      attemptCount: 0,
      replayCount: 0,
    } as any;

    const mockEndpointRepo = {
      findBySlug: vi.fn().mockResolvedValue(mockEndpoint),
    };
    const mockEventRepo = {
      create: vi.fn().mockResolvedValue({ event: createdEvent, isDuplicate: false }),
    };

    const ingestService = new IngestService(mockEndpointRepo as any, mockEventRepo as any);
    const result = await ingestService.handleIngest({
      slug: 'ep-no-dest',
      rawBody: '{"hello":"world"}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      sourceIp: '127.0.0.1',
      bodySize: 17,
      contentType: 'application/json',
    });

    expect(result.eventId).toBe(eventId.toString());
    expect(result.isDuplicate).toBe(false);
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockQueueAddBulk).not.toHaveBeenCalled();
  });

  it('2. Ingest creates 1 Delivery and queues 1 job when endpoint has 1 active matching destination', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();
    const eventId = new Types.ObjectId();
    const destId = new Types.ObjectId();

    const mockEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      workspaceId,
      slug: 'ep-one-dest',
      isActive: true,
      mode: 'normal',
      rateLimitPerMin: 1000,
      signatureConfig: null,
    };

    const mockDest = {
      _id: destId,
      workspaceId,
      endpointId,
      name: 'Webhook Relay',
      url: 'https://example.com/webhook',
      isActive: true,
      filter: null,
    };

    vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([mockDest as any]);

    let insertedDeliveries: any[] = [];
    vi.spyOn(DeliveryModel, 'insertMany').mockImplementation(async (docs: any) => {
      insertedDeliveries = docs.map((d: any) => ({
        ...d,
        _id: new Types.ObjectId(),
      }));
      return insertedDeliveries as any;
    });

    const createdEvent: IEvent = {
      _id: eventId,
      workspaceId,
      endpointId,
      receivedAt: new Date(),
      method: 'POST',
      headers: new Map(),
      rawBody: '{"hello":"world"}',
      bodySize: 17,
      contentType: 'application/json',
      sourceIp: '127.0.0.1',
      signatureValid: true,
      idempotencyKey: 'idemp-1',
      status: 'pending',
      attemptCount: 0,
      replayCount: 0,
    } as any;

    const mockEndpointRepo = {
      findBySlug: vi.fn().mockResolvedValue(mockEndpoint),
    };
    const mockEventRepo = {
      create: vi.fn().mockResolvedValue({ event: createdEvent, isDuplicate: false }),
    };

    const ingestService = new IngestService(mockEndpointRepo as any, mockEventRepo as any);
    const result = await ingestService.handleIngest({
      slug: 'ep-no-dest',
      rawBody: '{"hello":"world"}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      sourceIp: '127.0.0.1',
      bodySize: 17,
      contentType: 'application/json',
    });

    expect(result.eventId).toBe(eventId.toString());
    expect(insertedDeliveries).toHaveLength(1);
    expect(insertedDeliveries[0].status).toBe('pending');
    expect(mockQueueAddBulk).toHaveBeenCalledTimes(1);
  });

  it('3. Ingest creates 2 Deliveries (1 pending, 1 filtered) when 1 of 2 destinations matches filter', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();
    const eventId = new Types.ObjectId();
    const dest1Id = new Types.ObjectId();
    const dest2Id = new Types.ObjectId();

    const mockEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      workspaceId,
      slug: 'ep-two-dests',
      isActive: true,
      mode: 'normal',
      rateLimitPerMin: 1000,
      signatureConfig: null,
    };

    const dest1 = {
      _id: dest1Id,
      workspaceId,
      endpointId,
      name: 'Unfiltered Dest',
      url: 'https://example.com/all',
      isActive: true,
      filter: null,
    };

    const dest2 = {
      _id: dest2Id,
      workspaceId,
      endpointId,
      name: 'Filtered Dest',
      url: 'https://example.com/orders',
      isActive: true,
      filter: {
        combinator: 'and',
        conditions: [{ field: 'body.type', op: 'eq', value: 'order.completed' }],
      },
    };

    vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([
      dest1 as any,
      dest2 as any,
    ]);

    let insertedDeliveries: any[] = [];
    vi.spyOn(DeliveryModel, 'insertMany').mockImplementation(async (docs: any) => {
      insertedDeliveries = docs.map((d: any) => ({
        ...d,
        _id: new Types.ObjectId(),
      }));
      return insertedDeliveries as any;
    });

    const createdEvent: IEvent = {
      _id: eventId,
      workspaceId,
      endpointId,
      receivedAt: new Date(),
      method: 'POST',
      headers: new Map(),
      rawBody: '{"type":"invoice.created"}',
      bodySize: 25,
      contentType: 'application/json',
      sourceIp: '127.0.0.1',
      signatureValid: true,
      idempotencyKey: 'idemp-2',
      status: 'pending',
      attemptCount: 0,
      replayCount: 0,
    } as any;

    const mockEndpointRepo = {
      findBySlug: vi.fn().mockResolvedValue(mockEndpoint),
    };
    const mockEventRepo = {
      create: vi.fn().mockResolvedValue({ event: createdEvent, isDuplicate: false }),
    };

    const ingestService = new IngestService(mockEndpointRepo as any, mockEventRepo as any);
    const result = await ingestService.handleIngest({
      slug: 'ep-two-dests',
      rawBody: '{"type":"invoice.created"}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      sourceIp: '127.0.0.1',
      bodySize: 25,
      contentType: 'application/json',
    });

    expect(result.eventId).toBe(eventId.toString());
    expect(insertedDeliveries).toHaveLength(2);
    expect(insertedDeliveries[0].status).toBe('pending');
    expect(insertedDeliveries[1].status).toBe('filtered');
    expect(insertedDeliveries[1].filterReason).toContain('Condition failed: body.type eq');
    // Only the pending delivery was queued
    expect(mockQueueAddBulk).toHaveBeenCalledWith([
      expect.objectContaining({ data: { deliveryId: insertedDeliveries[0]._id.toString() } }),
    ]);
  });

  it('4. Ingest with legacy endpoint creates Default destination and returns 202', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();
    const eventId = new Types.ObjectId();
    const destId = new Types.ObjectId();

    const mockEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      workspaceId,
      slug: 'ep-legacy',
      isActive: true,
      mode: 'normal',
      destinationUrl: 'https://legacy.example.com/webhook',
      rateLimitPerMin: 1000,
      signatureConfig: null,
    };

    // First returns 0 destinations
    vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([]);

    const mockDefaultDest = {
      _id: destId,
      workspaceId,
      endpointId,
      name: 'Default',
      url: 'https://legacy.example.com/webhook',
      isActive: true,
      filter: null,
    };

    vi.spyOn(DestinationModel, 'findOneAndUpdate').mockResolvedValue(mockDefaultDest as any);

    let insertedDeliveries: any[] = [];
    vi.spyOn(DeliveryModel, 'insertMany').mockImplementation(async (docs: any) => {
      insertedDeliveries = docs.map((d: any) => ({
        ...d,
        _id: new Types.ObjectId(),
      }));
      return insertedDeliveries as any;
    });

    const createdEvent: IEvent = {
      _id: eventId,
      workspaceId,
      endpointId,
      receivedAt: new Date(),
      method: 'POST',
      headers: new Map(),
      rawBody: '{"hello":"legacy"}',
      bodySize: 18,
      contentType: 'application/json',
      sourceIp: '127.0.0.1',
      signatureValid: true,
      idempotencyKey: 'idemp-legacy',
      status: 'pending',
      attemptCount: 0,
      replayCount: 0,
    } as any;

    const mockEndpointRepo = {
      findBySlug: vi.fn().mockResolvedValue(mockEndpoint),
    };
    const mockEventRepo = {
      create: vi.fn().mockResolvedValue({ event: createdEvent, isDuplicate: false }),
    };

    const ingestService = new IngestService(mockEndpointRepo as any, mockEventRepo as any);
    const result = await ingestService.handleIngest({
      slug: 'ep-legacy',
      rawBody: '{"hello":"legacy"}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      sourceIp: '127.0.0.1',
      bodySize: 18,
      contentType: 'application/json',
    });

    expect(result.eventId).toBe(eventId.toString());
    expect(DestinationModel.findOneAndUpdate).toHaveBeenCalled();
  });

  it('5. EventFilterQuerySchema parses and normalizes web app query parameters (status=all, status="", cursor="", signatureValid="all")', () => {
    const parsed1 = EventFilterQuerySchema.parse({
      status: 'all',
      signatureValid: 'all',
      cursor: '',
      q: '',
    });
    expect(parsed1.status).toBeUndefined();
    expect(parsed1.signatureValid).toBeUndefined();
    expect(parsed1.cursor).toBeUndefined();
    expect(parsed1.q).toBeUndefined();

    const parsed2 = EventFilterQuerySchema.parse({
      status: '',
      signatureValid: '',
    });
    expect(parsed2.status).toBeUndefined();
    expect(parsed2.signatureValid).toBeUndefined();

    const parsed3 = EventFilterQuerySchema.parse({
      status: 'filtered',
      signatureValid: 'true',
    });
    expect(parsed3.status).toBe('filtered');
    expect(parsed3.signatureValid).toBe(true);
  });

  it('6. Events list returns events of every status by default', async () => {
    const endpointId = new Types.ObjectId().toString();

    const statuses = [
      'delivered',
      'pending',
      'failed',
      'dead',
      'partial',
      'filtered',
      'captured',
    ] as const;

    const mockEvents: IEvent[] = statuses.map((status) => ({
      _id: new Types.ObjectId(),
      workspaceId: new Types.ObjectId(),
      endpointId: new Types.ObjectId(endpointId),
      receivedAt: new Date(),
      method: 'POST',
      headers: new Map(),
      rawBody: '{"test":"status"}',
      bodySize: 17,
      contentType: 'application/json',
      sourceIp: '127.0.0.1',
      signatureValid: true,
      idempotencyKey: `key-${status}`,
      status,
      attemptCount: 1,
      replayCount: 0,
    })) as any;

    const mockEventRepo = {
      findEndpointEvents: vi.fn().mockResolvedValue({
        events: mockEvents,
        nextCursor: null,
        hasNextPage: false,
      }),
    };

    const eventService = new EventService(mockEventRepo as any);
    const result = await eventService.getEndpointEvents(endpointId, { limit: 20 });

    expect(result.events).toHaveLength(7);
    const returnedStatuses = result.events.map((e) => e.status);
    expect(returnedStatuses).toEqual(expect.arrayContaining(statuses));
  });

  it('7. toEventResponse safely serializes unmigrated documents missing receivedAt or status', () => {
    const rawLegacyDoc = {
      _id: new Types.ObjectId(),
      workspaceId: new Types.ObjectId(),
      endpointId: new Types.ObjectId(),
      createdAt: new Date('2026-10-31T12:00:00Z'),
      // receivedAt missing!
      // status missing!
      method: 'POST',
      headers: { 'user-agent': 'legacy-curl' },
      rawBody: '{"legacy": true}',
      bodySize: 16,
      sourceIp: '127.0.0.1',
    } as any;

    const resp = toEventResponse(rawLegacyDoc);
    expect(resp.id).toBe(rawLegacyDoc._id.toString());
    expect(resp.receivedAt).toBe('2026-10-31T12:00:00.000Z');
    expect(resp.status).toBe('delivered');
  });
});
