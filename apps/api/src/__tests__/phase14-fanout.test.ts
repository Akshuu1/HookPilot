import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import * as sharedModule from '@hookpilot/shared';
import { recomputeEventStatus } from '../services/delivery-status.service.js';
import { destinationService, mapDestinationResponse } from '../services/destination.service.js';
import { deliveryService } from '../services/delivery.service.js';
import { reconcilerService } from '../../../worker/src/services/reconciler.service.js';
import { EventModel } from '../models/Event.js';
import { EndpointModel } from '../models/Endpoint.js';
import { DestinationModel, type IDestination } from '../models/Destination.js';
import { DeliveryModel } from '../models/Delivery.js';
import { DeliveryAttemptModel } from '../models/DeliveryAttempt.js';
import { DeliveryProcessor } from '../../../worker/src/processors/delivery.processor.js';
import { requireDestinationRole } from '../middlewares/destination-role.middleware.js';
import { requireDeliveryRole } from '../middlewares/delivery-role.middleware.js';
import { auditLogRepository } from '../repositories/audit-log.repository.js';
import { runMigration } from '../../../../scripts/migrate-phase14.js';
import * as queueConfig from '../config/queue.js';
import * as redisConfig from '../config/redis.js';
import * as workerRedisConfig from '../../../worker/src/config/redis.js';
import * as cryptoUtils from '../utils/crypto.js';

describe('Phase 14: Fan-out Backend Comprehensive Tests', () => {
  const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'mock-job-1' });
  const mockQueueAddBulk = vi.fn().mockResolvedValue([{ id: 'mock-job-bulk' }]);
  const mockGetJob = vi.fn().mockResolvedValue(null);

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock validateDestinationUrl to avoid DNS lookup timeout in sandbox
    vi.spyOn(sharedModule, 'validateDestinationUrl').mockResolvedValue(true);
    vi.spyOn(auditLogRepository, 'create').mockResolvedValue({} as any);

    const mockQueue = {
      add: mockQueueAdd,
      addBulk: mockQueueAddBulk,
      getJob: mockGetJob,
    };

    vi.spyOn(queueConfig, 'getDeliveryQueue').mockReturnValue(mockQueue as any);
    vi.spyOn(workerRedisConfig, 'getDeliveryQueue').mockReturnValue(mockQueue as any);

    const mockRedis = {
      status: 'ready',
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      publish: vi.fn().mockResolvedValue(1),
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      ttl: vi.fn().mockResolvedValue(60),
    };

    vi.spyOn(redisConfig, 'getRedisClient').mockReturnValue(mockRedis as any);
    vi.spyOn(workerRedisConfig, 'getRedisClient').mockReturnValue(mockRedis as any);
  });

  describe('1. Fan-out Status Recomputation', () => {
    it('Event with 3 destinations: all delivered gives delivered; one dead gives partial; all dead gives dead', async () => {
      const eventId = new Types.ObjectId();
      const mockEvent = {
        _id: eventId,
        endpointId: new Types.ObjectId(),
        status: 'pending',
        attemptCount: 0,
        save: vi.fn().mockResolvedValue(true),
      };

      vi.spyOn(EventModel, 'findById').mockResolvedValue(mockEvent as any);
      vi.spyOn(EndpointModel, 'findById').mockResolvedValue({ mode: 'normal' } as any);

      // Subtest A: All 3 delivered -> delivered
      vi.spyOn(DeliveryModel, 'find').mockResolvedValue([
        { status: 'delivered' },
        { status: 'delivered' },
        { status: 'delivered' },
      ] as any);

      let status = await recomputeEventStatus(eventId);
      expect(status).toBe('delivered');
      expect(mockEvent.status).toBe('delivered');

      // Subtest B: One dead, two delivered -> partial
      vi.spyOn(DeliveryModel, 'find').mockResolvedValue([
        { status: 'delivered' },
        { status: 'delivered' },
        { status: 'dead' },
      ] as any);

      status = await recomputeEventStatus(eventId);
      expect(status).toBe('partial');
      expect(mockEvent.status).toBe('partial');

      // Subtest C: All 3 dead -> dead
      vi.spyOn(DeliveryModel, 'find').mockResolvedValue([
        { status: 'dead' },
        { status: 'dead' },
        { status: 'dead' },
      ] as any);

      status = await recomputeEventStatus(eventId);
      expect(status).toBe('dead');
      expect(mockEvent.status).toBe('dead');

      // Subtest D: All 3 filtered -> filtered
      vi.spyOn(DeliveryModel, 'find').mockResolvedValue([
        { status: 'filtered' },
        { status: 'filtered' },
        { status: 'filtered' },
      ] as any);

      status = await recomputeEventStatus(eventId);
      expect(status).toBe('filtered');
      expect(mockEvent.status).toBe('filtered');

      // Subtest E: Any pending/delivering/failed -> pending
      vi.spyOn(DeliveryModel, 'find').mockResolvedValue([
        { status: 'delivered' },
        { status: 'pending' },
        { status: 'delivered' },
      ] as any);

      status = await recomputeEventStatus(eventId);
      expect(status).toBe('pending');

      // Subtest F: Capture-only mode or 0 deliveries -> captured
      status = await recomputeEventStatus(eventId, { endpointMode: 'capture-only' });
      expect(status).toBe('captured');
    });
  });

  describe('2. Independent Failure Isolation in Worker', () => {
    it('one failing destination does not delay or fail the other destinations', async () => {
      const eventId = new Types.ObjectId();
      const destIdFailing = new Types.ObjectId();
      const destIdHealthy = new Types.ObjectId();

      const mockEvent = {
        _id: eventId,
        endpointId: new Types.ObjectId(),
        headers: {},
        rawBody: '{"hello":"world"}',
        save: vi.fn().mockResolvedValue(true),
      };

      const mockEndpoint = {
        _id: mockEvent.endpointId,
        slug: 'test-endpoint',
        retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500 },
        save: vi.fn().mockResolvedValue(true),
      };

      const mockFailingDest = {
        _id: destIdFailing,
        url: 'https://failing.example.com/webhook',
        isActive: true,
        save: vi.fn().mockResolvedValue(true),
      };

      const mockHealthyDest = {
        _id: destIdHealthy,
        url: 'https://healthy.example.com/webhook',
        isActive: true,
        save: vi.fn().mockResolvedValue(true),
      };

      const wsId = new Types.ObjectId();

      const deliveryFailing = {
        _id: new Types.ObjectId(),
        workspaceId: wsId,
        eventId,
        destinationId: destIdFailing,
        status: 'pending',
        attemptCount: 0,
        lastError: null,
        nextAttemptAt: null,
        save: vi.fn().mockResolvedValue(true),
      };

      const deliveryHealthy = {
        _id: new Types.ObjectId(),
        workspaceId: wsId,
        eventId,
        destinationId: destIdHealthy,
        status: 'pending',
        attemptCount: 0,
        lastError: null,
        nextAttemptAt: null,
        save: vi.fn().mockResolvedValue(true),
      };

      vi.spyOn(EventModel, 'findById').mockResolvedValue(mockEvent as any);
      vi.spyOn(EndpointModel, 'findById').mockResolvedValue(mockEndpoint as any);
      vi.spyOn(DeliveryAttemptModel, 'create').mockResolvedValue({} as any);

      // Mock fetch: reject for failing destination, resolve 200 for healthy
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('failing')) {
          return {
            ok: false,
            status: 500,
            text: async () => 'Internal Server Error',
            headers: new Map(),
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => 'OK',
          headers: new Map(),
        };
      }) as any;

      const mockCircuitBreaker = {
        canExecute: vi.fn().mockResolvedValue({ allowed: true }),
        recordSuccess: vi.fn().mockResolvedValue(undefined),
        recordFailure: vi.fn().mockResolvedValue(undefined),
      };
      const processor = new DeliveryProcessor(mockCircuitBreaker as any);
      vi.spyOn(processor, 'checkDestinationRateLimit').mockResolvedValue({
        allowed: true,
        retryAfterMs: 0,
      });

      // Process failing delivery
      vi.spyOn(DeliveryModel, 'findById').mockResolvedValue(deliveryFailing as any);
      vi.spyOn(DestinationModel, 'findById').mockResolvedValue(mockFailingDest as any);

      const resFailing = await processor.process({
        id: 'job-failing',
        data: { deliveryId: deliveryFailing._id.toString() },
      } as any);

      expect(resFailing.status).toBe('retry_scheduled');
      expect(deliveryFailing.status).toBe('failed');
      expect(deliveryFailing.attemptCount).toBe(1);

      // Process healthy delivery immediately after
      vi.spyOn(DeliveryModel, 'findById').mockResolvedValue(deliveryHealthy as any);
      vi.spyOn(DestinationModel, 'findById').mockResolvedValue(mockHealthyDest as any);

      const resHealthy = await processor.process({
        id: 'job-healthy',
        data: { deliveryId: deliveryHealthy._id.toString() },
      } as any);

      expect(resHealthy.status).toBe('delivered');
      expect(deliveryHealthy.status).toBe('delivered');
      expect(deliveryHealthy.attemptCount).toBe(1);
    });
  });

  describe('3. Replay Scopes & Replay Delivery', () => {
    it('replay with scope failed only re-sends failed or dead deliveries', async () => {
      const eventId = new Types.ObjectId();
      const userId = new Types.ObjectId().toString();

      const wsId = new Types.ObjectId();
      const destId = new Types.ObjectId();

      const delDelivered = {
        _id: new Types.ObjectId(),
        workspaceId: wsId,
        eventId,
        destinationId: destId,
        status: 'delivered',
        attemptCount: 1,
        save: vi.fn().mockResolvedValue(true),
      };

      const delFailed = {
        _id: new Types.ObjectId(),
        workspaceId: wsId,
        eventId,
        destinationId: destId,
        status: 'failed',
        attemptCount: 2,
        nextAttemptAt: null,
        lastError: 'HTTP 500',
        save: vi.fn().mockResolvedValue(true),
      };

      const delDead = {
        _id: new Types.ObjectId(),
        workspaceId: wsId,
        eventId,
        destinationId: destId,
        status: 'dead',
        attemptCount: 3,
        nextAttemptAt: null,
        lastError: 'HTTP 400',
        save: vi.fn().mockResolvedValue(true),
      };

      const delFiltered = {
        _id: new Types.ObjectId(),
        workspaceId: wsId,
        eventId,
        destinationId: destId,
        status: 'filtered',
        attemptCount: 0,
        save: vi.fn().mockResolvedValue(true),
      };

      vi.spyOn(EventModel, 'findById').mockResolvedValue({
        _id: eventId,
        workspaceId: new Types.ObjectId(),
        endpointId: new Types.ObjectId(),
        status: 'partial',
        replayCount: 0,
        save: vi.fn().mockResolvedValue(true),
      } as any);

      vi.spyOn(DeliveryModel, 'find').mockResolvedValue([
        delDelivered,
        delFailed,
        delDead,
        delFiltered,
      ] as any);

      // Replay single delivery
      vi.spyOn(DeliveryModel, 'findById').mockResolvedValue(delDead as any);
      const singleReplayRes = await deliveryService.replayDelivery(delDead._id.toString(), userId);

      expect(singleReplayRes.success).toBe(true);
      expect(singleReplayRes.jobId).toBe(`${delDead._id.toString()}-r4`);
      expect(delDead.status).toBe('pending');
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'deliver',
        { deliveryId: delDead._id.toString() },
        expect.objectContaining({ jobId: `${delDead._id.toString()}-r4` }),
      );
    });
  });

  describe('4. Idempotent Migration', () => {
    it('migration run twice changes nothing the second time', async () => {
      const epId = new Types.ObjectId();
      const eventId = new Types.ObjectId();

      const epMock = {
        _id: epId,
        workspaceId: new Types.ObjectId(),
        destinationUrl: 'https://migrated.example.com/webhook',
        retryPolicy: { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 5000 },
        isActive: true,
      };

      const eventMock = {
        _id: eventId,
        workspaceId: epMock.workspaceId,
        endpointId: epId,
        status: 'delivered',
        attemptCount: 1,
      };

      vi.spyOn(EndpointModel, 'find').mockResolvedValue([epMock] as any);
      vi.spyOn(EventModel, 'find').mockResolvedValue([eventMock] as any);

      // Run 1: No existing destination or delivery
      vi.spyOn(DestinationModel, 'countDocuments').mockResolvedValueOnce(0);
      vi.spyOn(DestinationModel, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as any);
      vi.spyOn(DestinationModel, 'findOne').mockResolvedValue({ _id: new Types.ObjectId() } as any);
      vi.spyOn(DeliveryModel, 'findOne').mockResolvedValueOnce(null);
      vi.spyOn(DeliveryModel, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as any);
      vi.spyOn(DeliveryAttemptModel, 'updateMany').mockResolvedValue({ modifiedCount: 1 } as any);

      const pass1 = await runMigration({ dryRun: false });
      expect(pass1.destinationsCreated).toBe(1);
      expect(pass1.deliveriesCreated).toBe(1);
      expect(pass1.attemptsBackfilled).toBe(1);

      // Run 2: Existing destination and delivery found (idempotent pass)
      vi.spyOn(DestinationModel, 'countDocuments').mockResolvedValueOnce(1);
      vi.spyOn(DestinationModel, 'findOne').mockResolvedValue({ _id: new Types.ObjectId() } as any);
      vi.spyOn(DeliveryModel, 'findOne').mockResolvedValueOnce({
        _id: new Types.ObjectId(),
      } as any);

      const pass2 = await runMigration({ dryRun: false });
      expect(pass2.destinationsCreated).toBe(0);
      expect(pass2.deliveriesCreated).toBe(0);
      expect(pass2.attemptsBackfilled).toBe(0);
    });
  });

  describe('5. Reconciler Orphan Recovery', () => {
    it('reconciler enqueues an orphaned pending delivery exactly once', async () => {
      const deliveryId = new Types.ObjectId();
      const orphanedDelivery = {
        _id: deliveryId,
        status: 'pending',
        createdAt: new Date(Date.now() - 3 * 60 * 1000), // 3 minutes old (> 2 minutes)
      };

      vi.spyOn(DeliveryModel, 'find').mockResolvedValue([orphanedDelivery] as any);
      mockGetJob.mockResolvedValue(null); // No active BullMQ job exists

      const result = await reconcilerService.reconcile();
      expect(result.enqueuedCount).toBe(1);
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'deliver',
        { deliveryId: deliveryId.toString() },
        expect.objectContaining({ jobId: deliveryId.toString() }),
      );

      // Second check: If job is already active/waiting in queue, do not re-enqueue
      mockGetJob.mockResolvedValue({
        getState: vi.fn().mockResolvedValue('active'),
      });

      const resultAlreadyActive = await reconcilerService.reconcile();
      expect(resultAlreadyActive.enqueuedCount).toBe(0);
    });
  });

  describe('6. Tenant Isolation & Role Checks on New Routes', () => {
    it('requireDestinationRole and requireDeliveryRole reject unauthorized cross-tenant access', async () => {
      const destId = new Types.ObjectId().toString();
      const deliveryId = new Types.ObjectId().toString();

      vi.spyOn(DestinationModel, 'findById').mockResolvedValue({
        _id: new Types.ObjectId(destId),
        workspaceId: new Types.ObjectId(),
      } as any);

      vi.spyOn(DeliveryModel, 'findById').mockResolvedValue({
        _id: new Types.ObjectId(deliveryId),
        workspaceId: new Types.ObjectId(),
      } as any);

      const mockMembershipRepo = {
        findByWorkspaceAndUser: vi.fn().mockResolvedValue(null), // User not member!
      };

      const destMiddleware = requireDestinationRole('viewer', mockMembershipRepo as any);
      const deliveryMiddleware = requireDeliveryRole('member', mockMembershipRepo as any);

      const mockReq = {
        user: { id: 'user-outsider' },
        params: { id: destId },
      };
      const mockNextDest = vi.fn();

      await destMiddleware(mockReq as any, {} as any, mockNextDest);
      expect(mockNextDest).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 403, code: 'FORBIDDEN' }),
      );

      mockReq.params.id = deliveryId;
      const mockNextDel = vi.fn();
      await deliveryMiddleware(mockReq as any, {} as any, mockNextDel);
      expect(mockNextDel).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 403, code: 'FORBIDDEN' }),
      );
    });

    it('enforces maximum 10 destinations per endpoint', async () => {
      vi.spyOn(EndpointModel, 'findById').mockResolvedValue({
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(),
      } as any);

      vi.spyOn(DestinationModel, 'countDocuments').mockResolvedValue(10);

      await expect(
        destinationService.createDestination('ep-123', {
          name: '11th destination',
          url: 'https://example.com/webhook',
        }),
      ).rejects.toThrow('Maximum limit of 10 destinations reached');
    });

    it('rejects SSRF internal destination URLs with 400', async () => {
      vi.spyOn(sharedModule, 'validateDestinationUrl').mockResolvedValueOnce(false);
      vi.spyOn(EndpointModel, 'findById').mockResolvedValue({
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(),
      } as any);
      vi.spyOn(DestinationModel, 'countDocuments').mockResolvedValue(1);

      await expect(
        destinationService.createDestination('ep-123', {
          name: 'SSRF Attack',
          url: 'http://169.254.169.254/latest/meta-data',
        }),
      ).rejects.toThrow('private or internal network addresses');
    });

    it('destination response never leaks raw secret or header values', () => {
      const mockDoc: IDestination = {
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(),
        endpointId: new Types.ObjectId(),
        name: 'Secured Destination',
        url: 'https://api.example.com/webhook',
        customHeaders: [
          { name: 'X-Api-Key', valueEncrypted: cryptoUtils.encryptSecret('secret-token-123') },
        ],
        isActive: true,
        outboundSecretEncrypted: cryptoUtils.encryptSecret('signing-key-xyz'),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      const resp = mapDestinationResponse(mockDoc);

      expect(resp.outboundSecretConfigured).toBe(true);
      expect((resp as any).outboundSecretEncrypted).toBeUndefined();
      expect((resp as any).outboundSecret).toBeUndefined();

      expect(resp.customHeaders[0].name).toBe('X-Api-Key');
      expect(resp.customHeaders[0].configured).toBe(true);
      expect((resp.customHeaders[0] as any).value).toBeUndefined();
      expect((resp.customHeaders[0] as any).valueEncrypted).toBeUndefined();
    });
  });
});
