import {
  decodeCursor,
  type EventFilterQuery,
  type PaginatedEventsResponse,
  type EventResponse,
  type EventWithAttemptsResponse,
  type DeliveryAttemptResponse,
  type BulkReplayInput,
  type BulkReplayResponse,
  type ReplayEventResponse,
  type EventPubSubMessage,
} from '@hookpilot/shared';
import {
  type EventRepository,
  eventRepository as defaultEventRepo,
} from '../repositories/event.repository.js';
import {
  type AuditLogRepository,
  auditLogRepository as defaultAuditLogRepo,
} from '../repositories/audit-log.repository.js';
import { getDeliveryQueue } from '../config/queue.js';
import { getRedisClient } from '../config/redis.js';
import { AppError } from '../middlewares/error-handler.js';
import type { IEvent } from '../models/Event.js';
import type { IDeliveryAttempt } from '../models/DeliveryAttempt.js';
import { DeliveryModel } from '../models/Delivery.js';
import { deliveryService } from './delivery.service.js';
import { recomputeEventStatus } from './delivery-status.service.js';

export function toEventResponse(event: IEvent): EventResponse {
  const headersObj =
    event.headers instanceof Map ? Object.fromEntries(event.headers) : event.headers || {};

  return {
    id: event._id ? event._id.toString() : event.id,
    workspaceId: event.workspaceId.toString(),
    endpointId: event.endpointId.toString(),
    receivedAt: event.receivedAt.toISOString(),
    method: event.method,
    headers: headersObj,
    rawBody: event.rawBody,
    bodySize: event.bodySize,
    contentType: event.contentType ?? null,
    sourceIp: event.sourceIp,
    signatureValid: event.signatureValid,
    idempotencyKey: event.idempotencyKey,
    status: event.status,
    attemptCount: event.attemptCount,
    replayCount: event.replayCount || 0,
    lastAttemptAt: event.lastAttemptAt ? event.lastAttemptAt.toISOString() : null,
    nextAttemptAt: event.nextAttemptAt ? event.nextAttemptAt.toISOString() : null,
  };
}

export function toAttemptResponse(attempt: IDeliveryAttempt): DeliveryAttemptResponse {
  const headersObj =
    attempt.requestHeaders instanceof Map
      ? Object.fromEntries(attempt.requestHeaders)
      : attempt.requestHeaders || {};

  return {
    id: attempt._id ? attempt._id.toString() : attempt.id,
    eventId: attempt.eventId.toString(),
    attemptNumber: attempt.attemptNumber,
    startedAt: attempt.startedAt.toISOString(),
    durationMs: attempt.durationMs,
    requestHeaders: headersObj,
    responseStatus: attempt.responseStatus,
    responseBodySnippet: attempt.responseBodySnippet,
    error: attempt.error ?? null,
    success: attempt.success,
    createdAt: attempt.createdAt ? attempt.createdAt.toISOString() : undefined,
  };
}

export class EventService {
  constructor(
    private readonly eventRepo: EventRepository = defaultEventRepo,
    private readonly auditLogRepo: AuditLogRepository = defaultAuditLogRepo,
  ) {}

  async getEndpointEvents(
    endpointId: string,
    query: EventFilterQuery,
  ): Promise<PaginatedEventsResponse> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;

    const result = await this.eventRepo.findEndpointEvents({
      endpointId,
      status: query.status,
      q: query.q,
      from,
      to,
      signatureValid: query.signatureValid,
      limit: query.limit,
      cursor,
    });

    return {
      events: result.events.map(toEventResponse),
      nextCursor: result.nextCursor,
      hasNextPage: result.hasNextPage,
    };
  }

  async getEventWithAttempts(eventId: string): Promise<EventWithAttemptsResponse> {
    const result = await this.eventRepo.findByIdWithAttempts(eventId);
    if (!result) {
      throw new AppError('Event not found', 404, 'NOT_FOUND');
    }

    const eventResp = toEventResponse(result.event);
    const attempts = result.attempts.map(toAttemptResponse);
    const deliveries = await deliveryService.listDeliveriesForEvent(eventId);

    return {
      ...eventResp,
      attempts,
      deliveries: deliveries.length > 0 ? deliveries : undefined,
    };
  }

  async replayEvent(
    eventId: string,
    userId: string,
    scope: 'failed' | 'all' = 'failed',
  ): Promise<ReplayEventResponse> {
    const event = await this.eventRepo.findById(eventId);
    if (!event) {
      throw new AppError('Event not found', 404, 'NOT_FOUND');
    }

    // Phase 14 fan-out deliveries
    const allDeliveries = await DeliveryModel.find({ eventId: event._id });
    if (allDeliveries.length > 0) {
      const targetDeliveries =
        scope === 'all'
          ? allDeliveries.filter((d) => d.status !== 'filtered')
          : allDeliveries.filter((d) => d.status === 'failed' || d.status === 'dead');

      const replayedDeliveryIds: string[] = [];
      const queue = getDeliveryQueue();

      for (const d of targetDeliveries) {
        const n = d.attemptCount + 1;
        const jobId = `${d._id.toString()}-r${n}`;

        d.status = 'pending';
        d.nextAttemptAt = new Date();
        d.lastError = null;
        await d.save();

        try {
          await queue.add(
            'deliver',
            { deliveryId: d._id.toString() },
            {
              jobId,
              attempts: 1,
              removeOnComplete: true,
            },
          );
        } catch {
          // Allow in offline / test environments
        }

        replayedDeliveryIds.push(d._id.toString());
      }

      await recomputeEventStatus(eventId);

      await this.auditLogRepo.create({
        workspaceId: event.workspaceId.toString(),
        userId,
        action: 'event.replay',
        resourceType: 'event',
        resourceId: event._id.toString(),
        metadata: {
          scope,
          replayedDeliveryCount: replayedDeliveryIds.length,
          replayedDeliveryIds,
        },
      });

      return {
        success: true,
        eventId: event._id.toString(),
        replayCount: (event.replayCount || 0) + 1,
        jobId:
          replayedDeliveryIds.length > 0
            ? `${replayedDeliveryIds[0]}-r1`
            : `${event._id.toString()}-r1`,
      };
    }

    const previousStatus = event.status;
    const updated = await this.eventRepo.replay(eventId);
    if (!updated) {
      throw new AppError('Failed to replay event', 500, 'REPLAY_FAILED');
    }

    const updatedId = updated._id ? updated._id.toString() : updated.id;
    const jobId = `${updatedId}-${updated.replayCount}`;

    // Enqueue fresh BullMQ delivery job
    try {
      const queue = getDeliveryQueue();
      await queue.add(
        'deliver',
        { eventId: updatedId, attemptNumber: 1 },
        {
          jobId,
          attempts: 1,
          removeOnComplete: true,
        },
      );
    } catch {
      // Allow persistence to stand in tests without active queue
    }

    // Publish event.status_changed to Redis 'events'
    try {
      const redis = getRedisClient();
      if (redis.status === 'ready' || redis.status === 'connecting') {
        const pubSubPayload: EventPubSubMessage = {
          type: 'event.status_changed',
          eventId: updatedId,
          endpointId: updated.endpointId.toString(),
          workspaceId: updated.workspaceId.toString(),
          status: updated.status,
          attemptCount: updated.attemptCount,
          timestamp: new Date().toISOString(),
        };
        await redis.publish('events', JSON.stringify(pubSubPayload));
      }
    } catch {
      // Non-blocking in test / offline environments
    }

    // Write audit log
    await this.auditLogRepo.create({
      workspaceId: updated.workspaceId.toString(),
      userId,
      action: 'event.replay',
      resourceType: 'event',
      resourceId: updatedId,
      metadata: {
        replayCount: updated.replayCount,
        previousStatus,
      },
    });

    return {
      success: true,
      eventId: updatedId,
      replayCount: updated.replayCount,
      jobId,
    };
  }

  async bulkReplay(input: BulkReplayInput, userId: string): Promise<BulkReplayResponse> {
    const from = input.from ? new Date(input.from) : undefined;
    const to = input.to ? new Date(input.to) : undefined;

    const matchingEvents = await this.eventRepo.findEventsForBulkReplay({
      workspaceId: input.workspaceId,
      endpointId: input.endpointId,
      status: input.status,
      from,
      to,
      limit: 500, // Maximum 500 events per call
    });

    const updatedEvents: IEvent[] = [];
    for (const event of matchingEvents) {
      const eventIdStr = event._id ? event._id.toString() : event.id;
      const updated = await this.eventRepo.replay(eventIdStr);
      if (updated) {
        updatedEvents.push(updated);
      }
    }

    // Enqueue in batches of 50
    const BATCH_SIZE = 50;
    try {
      const queue = getDeliveryQueue();
      for (let i = 0; i < updatedEvents.length; i += BATCH_SIZE) {
        const batch = updatedEvents.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map((evt) => {
            const evtId = evt._id ? evt._id.toString() : evt.id;
            return queue.add(
              'deliver',
              { eventId: evtId, attemptNumber: 1 },
              {
                jobId: `${evtId}-${evt.replayCount}`,
                attempts: 1,
                removeOnComplete: true,
              },
            );
          }),
        );
      }
    } catch {
      // Non-blocking in environments without active Redis
    }

    const replayedIds = updatedEvents.map((evt) => (evt._id ? evt._id.toString() : evt.id));

    // Write audit log for bulk replay
    await this.auditLogRepo.create({
      workspaceId: input.workspaceId,
      userId,
      action: 'event.bulk_replay',
      resourceType: 'event',
      resourceId: input.endpointId || input.workspaceId,
      metadata: {
        replayedCount: updatedEvents.length,
        eventIds: replayedIds,
      },
    });

    return {
      replayedCount: updatedEvents.length,
      eventIds: replayedIds,
    };
  }

  async deleteEvent(eventId: string, userId: string): Promise<void> {
    const event = await this.eventRepo.findById(eventId);
    if (!event) {
      throw new AppError('Event not found', 404, 'NOT_FOUND');
    }

    const workspaceId = event.workspaceId.toString();
    const previousStatus = event.status;

    await this.eventRepo.delete(eventId);

    // Write audit log
    await this.auditLogRepo.create({
      workspaceId,
      userId,
      action: 'event.delete',
      resourceType: 'event',
      resourceId: eventId,
      metadata: {
        deletedStatus: previousStatus,
      },
    });
  }
}

export const eventService = new EventService();
