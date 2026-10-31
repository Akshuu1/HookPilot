import { Types } from 'mongoose';
import type { EventStatus } from '@hookpilot/shared';
import { EventModel } from '../models/Event.js';
import { EndpointModel } from '../models/Endpoint.js';
import { DeliveryModel } from '../models/Delivery.js';
import { getRedisClient } from '../config/redis.js';

export async function recomputeEventStatus(
  eventId: string | Types.ObjectId,
  options?: { endpointMode?: string },
): Promise<EventStatus> {
  const event = await EventModel.findById(eventId);
  if (!event) return 'pending';

  let mode = options?.endpointMode;
  if (!mode) {
    const endpoint = await EndpointModel.findById(event.endpointId);
    mode = endpoint?.mode;
  }

  const deliveries = await DeliveryModel.find({ eventId: event._id });

  let newStatus: EventStatus;

  // 1. no deliveries or capture-only -> captured
  if (mode === 'capture-only' || deliveries.length === 0) {
    newStatus = 'captured';
  }
  // 2. all filtered -> filtered
  else if (deliveries.every((d) => d.status === 'filtered')) {
    newStatus = 'filtered';
  }
  // 3. any pending, failed or delivering -> pending
  else if (
    deliveries.some(
      (d) => d.status === 'pending' || d.status === 'failed' || d.status === 'delivering',
    )
  ) {
    newStatus = 'pending';
  } else {
    // Non-filtered (matched) deliveries
    const matched = deliveries.filter((d) => d.status !== 'filtered');
    const deliveredCount = matched.filter((d) => d.status === 'delivered').length;
    const deadCount = matched.filter((d) => d.status === 'dead' || d.status === 'cancelled').length;

    // 4. all matched delivered -> delivered
    if (matched.length > 0 && deliveredCount === matched.length) {
      newStatus = 'delivered';
    }
    // 5. some delivered and some dead -> partial
    else if (deliveredCount > 0 && deadCount > 0) {
      newStatus = 'partial';
    }
    // 6. all matched dead -> dead
    else if (matched.length > 0 && deadCount === matched.length) {
      newStatus = 'dead';
    } else {
      newStatus = 'pending';
    }
  }

  if (event.status !== newStatus) {
    event.status = newStatus;
    await event.save();

    // Publish event:update to Redis 'events'
    try {
      const redis = getRedisClient();
      if (redis.status === 'ready' || redis.status === 'connecting') {
        const payload = {
          type: 'event.update',
          eventId: event._id.toString(),
          endpointId: event.endpointId.toString(),
          workspaceId: event.workspaceId.toString(),
          status: newStatus,
          attemptCount: event.attemptCount,
          timestamp: new Date().toISOString(),
        };
        await redis.publish('events', JSON.stringify(payload));
      }
    } catch {
      // Non-blocking
    }
  }

  return newStatus;
}
