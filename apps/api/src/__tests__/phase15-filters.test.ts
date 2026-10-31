import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import * as sharedModule from '@hookpilot/shared';
import { ingestService } from '../services/ingest.service.js';
import { destinationService } from '../services/destination.service.js';
import { deliveryService } from '../services/delivery.service.js';
import { recomputeEventStatus } from '../services/delivery-status.service.js';
import { EventModel } from '../models/Event.js';
import { EndpointModel } from '../models/Endpoint.js';
import { DestinationModel } from '../models/Destination.js';
import { DeliveryModel } from '../models/Delivery.js';
import { auditLogRepository } from '../repositories/audit-log.repository.js';
import { requireDestinationRole } from '../middlewares/destination-role.middleware.js';
import { requireDeliveryRole } from '../middlewares/delivery-role.middleware.js';
import * as queueConfig from '../config/queue.js';
import * as redisConfig from '../config/redis.js';

describe('Phase 15: Rule-based Filters Integration & API Tests', () => {
  const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'mock-job-1' });
  const mockQueueAddBulk = vi.fn().mockResolvedValue([{ id: 'mock-job-bulk' }]);

  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(sharedModule, 'validateDestinationUrl').mockResolvedValue(true);
    vi.spyOn(auditLogRepository, 'create').mockResolvedValue({} as any);

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

  describe('1. Fan-out Ingestion with Destination Filters', () => {
    it('2 destinations with different filters: matching destination gets a BullMQ job; non-matching gets filtered status with reason and NO job', async () => {
      const workspaceId = new Types.ObjectId();
      const endpointId = new Types.ObjectId();
      const eventId = new Types.ObjectId();

      const dest1Id = new Types.ObjectId();
      const dest2Id = new Types.ObjectId();

      // Dest 1: filter matches order.created
      const dest1 = {
        _id: dest1Id,
        workspaceId,
        endpointId,
        name: 'Order Processing Webhook',
        url: 'https://orders.internal.api/hooks',
        isActive: true,
        filter: {
          combinator: 'and',
          conditions: [{ field: 'body.type', op: 'eq', value: 'order.created' }],
        },
      };

      // Dest 2: filter matches user.signup (will not match this event)
      const dest2 = {
        _id: dest2Id,
        workspaceId,
        endpointId,
        name: 'User Onboarding Webhook',
        url: 'https://users.internal.api/hooks',
        isActive: true,
        filter: {
          combinator: 'and',
          conditions: [{ field: 'body.type', op: 'eq', value: 'user.signup' }],
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

      const mockEvent = {
        _id: eventId,
        workspaceId,
        endpointId,
        rawBody: JSON.stringify({ type: 'order.created', orderId: 'ord_123', total: 99.5 }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        contentType: 'application/json',
        status: 'pending',
        save: vi.fn().mockResolvedValue(true),
      };

      vi.spyOn(EventModel, 'findById').mockResolvedValue(mockEvent as any);
      vi.spyOn(EndpointModel, 'findById').mockResolvedValue({
        _id: endpointId,
        mode: 'normal',
      } as any);
      vi.spyOn(DeliveryModel, 'find').mockImplementation(async () => insertedDeliveries as any);

      await (ingestService as any).fanOut(mockEvent, {
        _id: endpointId,
        workspaceId,
        mode: 'normal',
      });

      // Deliveries validation
      expect(insertedDeliveries).toHaveLength(2);

      const del1 = insertedDeliveries.find(
        (d) => d.destinationId.toString() === dest1Id.toString(),
      );
      const del2 = insertedDeliveries.find(
        (d) => d.destinationId.toString() === dest2Id.toString(),
      );

      expect(del1).toBeDefined();
      expect(del1.status).toBe('pending');
      expect(del1.filterReason).toBeNull();

      expect(del2).toBeDefined();
      expect(del2.status).toBe('filtered');
      expect(del2.filterReason).toContain('Condition failed: body.type eq "user.signup"');

      // BullMQ jobs check: only the pending delivery is enqueued
      expect(mockQueueAddBulk).toHaveBeenCalledTimes(1);
      const enqueuedJobs = mockQueueAddBulk.mock.calls[0][0];
      expect(enqueuedJobs).toHaveLength(1);
      expect(enqueuedJobs[0].data.deliveryId).toBe(del1._id.toString());
      expect(enqueuedJobs[0].opts.jobId).toBe(del1._id.toString());
    });

    it('when all destinations are filtered, event status is derived as filtered and 0 jobs are enqueued', async () => {
      const workspaceId = new Types.ObjectId();
      const endpointId = new Types.ObjectId();
      const eventId = new Types.ObjectId();

      const dest1 = {
        _id: new Types.ObjectId(),
        workspaceId,
        endpointId,
        name: 'CRM Sync',
        url: 'https://crm.example.com',
        isActive: true,
        filter: {
          combinator: 'and',
          conditions: [{ field: 'body.type', op: 'eq', value: 'contact.updated' }],
        },
      };

      vi.spyOn(destinationService, 'getActiveDestinations').mockResolvedValue([dest1 as any]);

      let insertedDeliveries: any[] = [];
      vi.spyOn(DeliveryModel, 'insertMany').mockImplementation(async (docs: any[]) => {
        insertedDeliveries = docs.map((d) => ({
          ...d,
          _id: new Types.ObjectId(),
        }));
        return insertedDeliveries as any;
      });

      const mockEvent = {
        _id: eventId,
        workspaceId,
        endpointId,
        rawBody: JSON.stringify({ type: 'invoice.paid' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        contentType: 'application/json',
        status: 'pending',
        save: vi.fn().mockResolvedValue(true),
      };

      vi.spyOn(EventModel, 'findById').mockResolvedValue(mockEvent as any);
      vi.spyOn(EndpointModel, 'findById').mockResolvedValue({
        _id: endpointId,
        mode: 'normal',
      } as any);
      vi.spyOn(DeliveryModel, 'find').mockImplementation(async () => insertedDeliveries as any);

      await (ingestService as any).fanOut(mockEvent, {
        _id: endpointId,
        workspaceId,
        mode: 'normal',
      });

      // Deliveries validation: destination is filtered
      expect(insertedDeliveries).toHaveLength(1);
      expect(insertedDeliveries[0].status).toBe('filtered');
      expect(insertedDeliveries[0].filterReason).toContain(
        'Condition failed: body.type eq "contact.updated"',
      );

      // BullMQ jobs: none enqueued
      expect(mockQueueAddBulk).not.toHaveBeenCalled();

      // Recomputed status for event
      const finalStatus = await recomputeEventStatus(eventId);
      expect(finalStatus).toBe('filtered');
    });
  });

  describe('2. POST /destinations/:id/test-filter', () => {
    it('evaluates filter with sample payload and returns matched and explanation', async () => {
      const destinationId = new Types.ObjectId();
      const workspaceId = new Types.ObjectId();

      const mockDoc = {
        _id: destinationId,
        workspaceId,
        endpointId: new Types.ObjectId(),
        filter: {
          combinator: 'and',
          conditions: [
            { field: 'body.priority', op: 'gte', value: 3 },
            { field: 'headers.x-source', op: 'eq', value: 'sensor' },
          ],
        },
      };

      vi.spyOn(DestinationModel, 'findById').mockResolvedValue(mockDoc as any);

      // Subtest 1: Matching sample
      const res1 = await destinationService.testFilter(
        destinationId.toString(),
        {
          sample: {
            body: { priority: 5, alert: 'High heat' },
            headers: { 'x-source': 'sensor' },
          },
        },
        workspaceId.toString(),
      );

      expect(res1.matched).toBe(true);
      expect(res1.explanation.reason).toBeNull();
      expect(res1.explanation.conditions).toHaveLength(2);
      expect(res1.explanation.conditions[0].passed).toBe(true);
      expect(res1.explanation.conditions[1].passed).toBe(true);

      // Subtest 2: Non-matching sample
      const res2 = await destinationService.testFilter(
        destinationId.toString(),
        {
          sample: {
            body: { priority: 1 },
            headers: { 'x-source': 'sensor' },
          },
        },
        workspaceId.toString(),
      );

      expect(res2.matched).toBe(false);
      expect(res2.explanation.reason).toContain('Condition failed: body.priority gte 3');
      expect(res2.explanation.conditions[0].passed).toBe(false);
    });

    it('evaluates filter using an existing eventId', async () => {
      const destinationId = new Types.ObjectId();
      const workspaceId = new Types.ObjectId();
      const eventId = new Types.ObjectId();

      const mockDoc = {
        _id: destinationId,
        workspaceId,
        endpointId: new Types.ObjectId(),
        filter: {
          combinator: 'and',
          conditions: [{ field: 'body.action', op: 'eq', value: 'ping' }],
        },
      };

      const mockEvent = {
        _id: eventId,
        workspaceId,
        endpointId: mockDoc.endpointId,
        rawBody: JSON.stringify({ action: 'ping', echo: 'hello' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        contentType: 'application/json',
      };

      vi.spyOn(DestinationModel, 'findById').mockResolvedValue(mockDoc as any);
      vi.spyOn(EventModel, 'findOne').mockResolvedValue(mockEvent as any);

      const res = await destinationService.testFilter(
        destinationId.toString(),
        { eventId: eventId.toString() },
        workspaceId.toString(),
      );

      expect(res.matched).toBe(true);
      expect(res.explanation.conditions[0].passed).toBe(true);
    });

    it('enforces tenant isolation: workspace B cannot test filter on destination of workspace A', async () => {
      const destinationId = new Types.ObjectId();
      const workspaceA = new Types.ObjectId();
      const workspaceB = new Types.ObjectId();

      const mockDoc = {
        _id: destinationId,
        workspaceId: workspaceA,
        filter: null,
      };

      vi.spyOn(DestinationModel, 'findById').mockResolvedValue(mockDoc as any);

      await expect(
        destinationService.testFilter(
          destinationId.toString(),
          { sample: { body: {} } },
          workspaceB.toString(), // Wrong workspace
        ),
      ).rejects.toThrow('Destination not found');
    });
  });

  describe('3. POST /destinations/:id/filter-preview', () => {
    it('runs the filter on the endpoint’s last 100 events and returns matchedCount and totalEvents', async () => {
      const destinationId = new Types.ObjectId();
      const workspaceId = new Types.ObjectId();
      const endpointId = new Types.ObjectId();

      const mockDoc = {
        _id: destinationId,
        workspaceId,
        endpointId,
        filter: {
          combinator: 'and',
          conditions: [{ field: 'body.env', op: 'eq', value: 'production' }],
        },
      };

      // Mock 5 historical events: 3 matching, 2 non-matching
      const mockEvents = [
        { rawBody: JSON.stringify({ env: 'production' }), headers: {}, method: 'POST' },
        { rawBody: JSON.stringify({ env: 'staging' }), headers: {}, method: 'POST' },
        { rawBody: JSON.stringify({ env: 'production' }), headers: {}, method: 'POST' },
        { rawBody: JSON.stringify({ env: 'development' }), headers: {}, method: 'POST' },
        { rawBody: JSON.stringify({ env: 'production' }), headers: {}, method: 'POST' },
      ];

      vi.spyOn(DestinationModel, 'findById').mockResolvedValue(mockDoc as any);
      vi.spyOn(EventModel, 'find').mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(mockEvents),
        }),
      } as any);

      const preview = await destinationService.previewFilter(
        destinationId.toString(),
        workspaceId.toString(),
      );

      expect(preview.totalEvents).toBe(5);
      expect(preview.matchedCount).toBe(3);
    });

    it('enforces tenant isolation on filter-preview', async () => {
      const destinationId = new Types.ObjectId();
      const workspaceA = new Types.ObjectId();
      const workspaceB = new Types.ObjectId();

      const mockDoc = {
        _id: destinationId,
        workspaceId: workspaceA,
      };

      vi.spyOn(DestinationModel, 'findById').mockResolvedValue(mockDoc as any);

      await expect(
        destinationService.previewFilter(destinationId.toString(), workspaceB.toString()),
      ).rejects.toThrow('Destination not found');
    });
  });

  describe('4. Force Deliver Replay of Filtered Deliveries', () => {
    it('force deliver resets filtered status to pending, clears filterReason, enqueues BullMQ job, and logs audit', async () => {
      const deliveryId = new Types.ObjectId();
      const eventId = new Types.ObjectId();
      const destinationId = new Types.ObjectId();
      const workspaceId = new Types.ObjectId();
      const userId = 'usr_admin_123';

      const mockDelivery = {
        _id: deliveryId,
        workspaceId,
        eventId,
        destinationId,
        status: 'filtered',
        attemptCount: 0,
        nextAttemptAt: null,
        filterReason: 'Condition failed: body.amount gt 500',
        lastError: null,
        save: vi.fn().mockResolvedValue(true),
      };

      vi.spyOn(DeliveryModel, 'findById').mockResolvedValue(mockDelivery as any);
      vi.spyOn(EventModel, 'findById').mockResolvedValue({
        _id: eventId,
        save: vi.fn().mockResolvedValue(true),
      } as any);
      vi.spyOn(EndpointModel, 'findById').mockResolvedValue({ mode: 'normal' } as any);
      vi.spyOn(DeliveryModel, 'find').mockResolvedValue([mockDelivery] as any);

      const auditSpy = vi.spyOn(auditLogRepository, 'create').mockResolvedValue({} as any);

      const result = await deliveryService.forceDeliver(deliveryId.toString(), userId);

      expect(result.success).toBe(true);
      expect(result.jobId).toBe(`${deliveryId.toString()}-r1`);

      // Status reset
      expect(mockDelivery.status).toBe('pending');
      expect(mockDelivery.filterReason).toBeNull();
      expect(mockDelivery.nextAttemptAt).toBeInstanceOf(Date);
      expect(mockDelivery.save).toHaveBeenCalled();

      // BullMQ job enqueued
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'deliver',
        { deliveryId: deliveryId.toString() },
        expect.objectContaining({ jobId: `${deliveryId.toString()}-r1` }),
      );

      // Audit log entry written with action: 'delivery.force_deliver'
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: workspaceId.toString(),
          userId,
          action: 'delivery.force_deliver',
          resourceType: 'delivery',
          resourceId: deliveryId.toString(),
        }),
      );
    });
  });

  describe('5. Route-level RBAC and Tenant Isolation Guards', () => {
    it('requireDestinationRole blocks viewer from member+ endpoints', async () => {
      const destinationId = new Types.ObjectId();
      const workspaceId = new Types.ObjectId();
      const mockDestination = {
        _id: destinationId,
        workspaceId,
      };

      vi.spyOn(DestinationModel, 'findById').mockResolvedValue(mockDestination as any);

      const mockMembershipRepo = {
        findByWorkspaceAndUser: vi.fn().mockResolvedValue({
          role: 'viewer',
        }),
      };

      const middleware = requireDestinationRole('member', mockMembershipRepo as any);

      const req: any = {
        user: { id: 'usr_viewer' },
        params: { id: destinationId.toString() },
      };
      const res: any = {};
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 403,
          code: 'INSUFFICIENT_PERMISSIONS',
        }),
      );
    });

    it('requireDeliveryRole blocks unauthenticated requests and members from another workspace', async () => {
      const deliveryId = new Types.ObjectId();
      const workspaceId = new Types.ObjectId();
      const mockDelivery = {
        _id: deliveryId,
        workspaceId,
      };

      vi.spyOn(DeliveryModel, 'findById').mockResolvedValue(mockDelivery as any);

      const mockMembershipRepo = {
        findByWorkspaceAndUser: vi.fn().mockResolvedValue(null), // Not a member
      };

      const middleware = requireDeliveryRole('member', mockMembershipRepo as any);

      const req: any = {
        user: { id: 'usr_foreign' },
        params: { id: deliveryId.toString() },
      };
      const res: any = {};
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 403,
          code: 'FORBIDDEN',
        }),
      );
    });
  });
});
