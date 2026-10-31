import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { ingestService } from '../services/ingest.service.js';
import { destinationService } from '../services/destination.service.js';
import { recomputeEventStatus } from '../services/delivery-status.service.js';
import { EventModel } from '../models/Event.js';
import { EndpointModel } from '../models/Endpoint.js';
import { DeliveryModel } from '../models/Delivery.js';
import * as queueConfig from '../config/queue.js';
import * as redisConfig from '../config/redis.js';

describe('Phase 16 Acceptance Verification: Fan-out & Filter Execution', () => {
  const mockQueueAddBulk = vi.fn().mockResolvedValue([{ id: 'mock-job-1' }]);

  beforeEach(() => {
    vi.clearAllMocks();

    const mockQueue = {
      add: vi.fn().mockResolvedValue({ id: 'mock-job' }),
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

  it('Acceptance Criteria: 2 destinations with different filters -> one delivered and one filtered -> event is delivered; breaking one destination shows partial event', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();
    const eventId = new Types.ObjectId();

    const dest1Id = new Types.ObjectId();
    const dest2Id = new Types.ObjectId();

    // Destination 1: Order Destination (filter: body.type eq "order.paid")
    const dest1 = {
      _id: dest1Id,
      workspaceId,
      endpointId,
      name: 'Order Webhook Service',
      url: 'https://orders.example.com/webhook',
      isActive: true,
      filter: {
        combinator: 'and',
        conditions: [{ field: 'body.type', op: 'eq', value: 'order.paid' }],
      },
    };

    // Destination 2: Invoice Destination (filter: body.type eq "invoice.created")
    const dest2 = {
      _id: dest2Id,
      workspaceId,
      endpointId,
      name: 'Invoice Billing Service',
      url: 'https://invoicing.example.com/webhook',
      isActive: true,
      filter: {
        combinator: 'and',
        conditions: [{ field: 'body.type', op: 'eq', value: 'invoice.created' }],
      },
    };

    vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([
      dest1 as any,
      dest2 as any,
    ]);

    let insertedDeliveries: any[] = [];
    vi.spyOn(DeliveryModel, 'insertMany').mockImplementation(async (docs: any[]) => {
      insertedDeliveries = docs.map((d) => ({
        ...d,
        _id: new Types.ObjectId(),
      }));
      return insertedDeliveries as any;
    });

    const mockEventDoc = {
      _id: eventId,
      workspaceId,
      endpointId,
      rawBody: JSON.stringify({ type: 'order.paid', orderId: 'ord_999', amount: 49.99 }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      contentType: 'application/json',
      status: 'pending',
      save: vi.fn().mockResolvedValue(true),
    };

    vi.spyOn(EventModel, 'findById').mockResolvedValue(mockEventDoc as any);
    vi.spyOn(EndpointModel, 'findById').mockResolvedValue({
      _id: endpointId,
      mode: 'normal',
    } as any);

    // 1. Ingest webhook & run fan-out with rule-based filters
    await (ingestService as any).fanOut(mockEventDoc, {
      _id: endpointId,
      workspaceId,
      mode: 'normal',
    });

    // 2. Verify Deliveries:
    // Destination 1 matches -> pending (ready for delivery worker)
    // Destination 2 fails filter -> filtered (filterReason stored, NO BullMQ job)
    expect(insertedDeliveries).toHaveLength(2);
    const del1 = insertedDeliveries.find((d) => d.destinationId.toString() === dest1Id.toString());
    const del2 = insertedDeliveries.find((d) => d.destinationId.toString() === dest2Id.toString());

    expect(del1).toBeDefined();
    expect(del1.status).toBe('pending');
    expect(del1.filterReason).toBeNull();

    expect(del2).toBeDefined();
    expect(del2.status).toBe('filtered');
    expect(del2.filterReason).toContain('Condition failed: body.type eq "invoice.created"');

    // Only 1 job was submitted to BullMQ (for Destination 1)
    expect(mockQueueAddBulk).toHaveBeenCalledTimes(1);
    expect(mockQueueAddBulk.mock.calls[0][0]).toHaveLength(1);

    // 3. Simulate Delivery 1 succeeding -> status: 'delivered'
    del1.status = 'delivered';
    vi.spyOn(DeliveryModel, 'find').mockResolvedValue(insertedDeliveries as any);

    const statusAfterDelivery = await recomputeEventStatus(eventId);
    // Dest 1 is delivered, Dest 2 is filtered -> All matched deliveries are delivered -> Event status is 'delivered'
    expect(statusAfterDelivery).toBe('delivered');
    expect(mockEventDoc.status).toBe('delivered');

    // 4. Now simulate breaking a destination:
    // Suppose a third destination was also matched or Dest 2 was force-replayed but broke (became 'dead')
    const dest3Id = new Types.ObjectId();
    const del3 = {
      _id: new Types.ObjectId(),
      eventId,
      destinationId: dest3Id,
      status: 'dead',
      lastError: { message: 'HTTP 500 Internal Server Error' },
      attemptCount: 5,
    };
    insertedDeliveries.push(del3);

    // Recompute status with 1 delivered and 1 dead (and 1 filtered)
    const statusAfterBreak = await recomputeEventStatus(eventId);
    // Some matched delivered and some matched dead -> Event status is 'partial'
    expect(statusAfterBreak).toBe('partial');
    expect(mockEventDoc.status).toBe('partial');
  });
});
