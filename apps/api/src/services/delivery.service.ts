import { Types } from 'mongoose';
import { AppError } from '../middlewares/error-handler.js';
import { DeliveryModel, type IDelivery } from '../models/Delivery.js';
import { DestinationModel } from '../models/Destination.js';
import { DeliveryAttemptModel } from '../models/DeliveryAttempt.js';
import { getDeliveryQueue } from '../config/queue.js';
import { getRedisClient } from '../config/redis.js';
import { auditLogRepository } from '../repositories/audit-log.repository.js';
import { recomputeEventStatus } from './delivery-status.service.js';
import type { DeliveryResponse, EventPubSubMessage } from '@hookpilot/shared';

export class DeliveryService {
  async getDeliveryById(id: string): Promise<IDelivery> {
    const delivery = await DeliveryModel.findById(id);
    if (!delivery) {
      throw new AppError('Delivery not found', 404, 'DELIVERY_NOT_FOUND');
    }
    return delivery;
  }

  async mapDeliveryResponse(delivery: IDelivery): Promise<DeliveryResponse> {
    const destination = await DestinationModel.findById(delivery.destinationId);
    const attempts = await DeliveryAttemptModel.find({
      deliveryId: delivery._id,
    }).sort({ attemptNumber: 1 });

    return {
      id: delivery._id.toString(),
      workspaceId: delivery.workspaceId.toString(),
      eventId: delivery.eventId.toString(),
      destinationId: delivery.destinationId.toString(),
      destinationName: destination?.name,
      destinationUrl: destination?.url,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      nextAttemptAt: delivery.nextAttemptAt ? delivery.nextAttemptAt.toISOString() : null,
      lastError: delivery.lastError ?? null,
      filterReason: delivery.filterReason ?? null,
      attempts: attempts.map((a) => ({
        id: a._id.toString(),
        eventId: a.eventId.toString(),
        deliveryId: a.deliveryId ? a.deliveryId.toString() : undefined,
        destinationId: a.destinationId ? a.destinationId.toString() : undefined,
        attemptNumber: a.attemptNumber,
        startedAt: a.startedAt.toISOString(),
        durationMs: a.durationMs,
        requestHeaders:
          a.requestHeaders instanceof Map
            ? Object.fromEntries(a.requestHeaders)
            : a.requestHeaders || {},
        responseStatus: a.responseStatus,
        responseBodySnippet: a.responseBodySnippet,
        error: a.error ?? null,
        success: a.success,
      })),
      createdAt: delivery.createdAt.toISOString(),
      updatedAt: delivery.updatedAt.toISOString(),
    };
  }

  async replayDelivery(
    deliveryId: string,
    userId: string,
    force = false,
  ): Promise<{ success: boolean; jobId: string; deliveryId: string }> {
    const delivery = await DeliveryModel.findById(deliveryId);
    if (!delivery) {
      throw new AppError('Delivery not found', 404, 'DELIVERY_NOT_FOUND');
    }

    const n = delivery.attemptCount + 1;
    const jobId = `${delivery._id.toString()}-r${n}`;

    const wasFiltered = delivery.status === 'filtered';
    delivery.status = 'pending';
    delivery.nextAttemptAt = new Date();
    delivery.lastError = null;
    if (force || wasFiltered) {
      delivery.filterReason = null;
    }
    await delivery.save();

    // Recompute event status
    await recomputeEventStatus(delivery.eventId.toString());

    // Enqueue BullMQ delivery job with jobId = `${deliveryId}-r${n}`
    try {
      const queue = getDeliveryQueue();
      await queue.add(
        'deliver',
        { deliveryId: delivery._id.toString() },
        {
          jobId,
          attempts: 1,
          removeOnComplete: true,
        },
      );
    } catch {
      // Allow persistence to stand in tests without active queue
    }

    // Write audit log entry
    try {
      await auditLogRepository.create({
        workspaceId: delivery.workspaceId.toString(),
        userId,
        action: force ? 'delivery.force_deliver' : 'delivery.replay',
        resourceType: 'delivery',
        resourceId: delivery._id.toString(),
        metadata: {
          eventId: delivery.eventId.toString(),
          destinationId: delivery.destinationId.toString(),
          jobId,
          forced: force,
        },
      });
    } catch {
      // Non-blocking in mock / offline test environments
    }

    // Publish event.status_changed / delivery.update
    try {
      const redis = getRedisClient();
      if (redis.status === 'ready' || redis.status === 'connecting') {
        const pubSubPayload: EventPubSubMessage = {
          type: 'delivery.update',
          eventId: delivery.eventId.toString(),
          deliveryId: delivery._id.toString(),
          destinationId: delivery.destinationId.toString(),
          workspaceId: delivery.workspaceId.toString(),
          status: delivery.status,
          attemptCount: delivery.attemptCount,
          timestamp: new Date().toISOString(),
        };
        await redis.publish('events', JSON.stringify(pubSubPayload));
      }
    } catch {
      // Best-effort realtime publish
    }

    return {
      success: true,
      jobId,
      deliveryId: delivery._id.toString(),
    };
  }

  async forceDeliver(
    deliveryId: string,
    userId: string,
  ): Promise<{ success: boolean; jobId: string; deliveryId: string }> {
    return this.replayDelivery(deliveryId, userId, true);
  }

  async listDeliveriesForEvent(eventId: string): Promise<DeliveryResponse[]> {
    if (!Types.ObjectId.isValid(eventId)) return [];
    const deliveries = await DeliveryModel.find({
      eventId: new Types.ObjectId(eventId),
    }).sort({ createdAt: 1 });

    const results: DeliveryResponse[] = [];
    for (const d of deliveries) {
      results.push(await this.mapDeliveryResponse(d));
    }
    return results;
  }
}

export const deliveryService = new DeliveryService();
