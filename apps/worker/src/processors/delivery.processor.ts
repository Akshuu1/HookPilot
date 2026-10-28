import type { Job } from 'bullmq';
import { Types } from 'mongoose';
import { computeBackoff, validateDestinationUrl, type EventPubSubMessage } from '@hookpilot/shared';
import { EventModel, type IEvent } from '../models/Event.js';
import { EndpointModel } from '../models/Endpoint.js';
import { DeliveryAttemptModel } from '../models/DeliveryAttempt.js';
import {
  performDelivery,
  performTunnelDelivery,
  classifyResponse,
} from '../services/delivery.service.js';
import { circuitBreaker, type CircuitBreaker } from '../services/circuit-breaker.js';
import { getRedisClient, getDeliveryQueue } from '../config/redis.js';
import { logger } from '../config/logger.js';

export interface DeliveryJobData {
  eventId: string;
  attemptNumber?: number;
}

export class DeliveryProcessor {
  constructor(private readonly cb: CircuitBreaker = circuitBreaker) {}

  async publishStatus(
    type: 'event.status_changed' | 'event.dead',
    event: IEvent,
    error?: string | null,
  ): Promise<void> {
    try {
      const redis = getRedisClient();
      const payload: EventPubSubMessage = {
        type,
        eventId: event._id.toString(),
        endpointId: event.endpointId.toString(),
        workspaceId: event.workspaceId.toString(),
        status: event.status,
        attemptCount: event.attemptCount,
        timestamp: new Date().toISOString(),
        ...(error ? { error } : {}),
      };
      await redis.publish('events', JSON.stringify(payload));
    } catch (err) {
      logger.error({ err, eventId: event._id }, 'Failed to publish event status to Redis');
    }
  }

  async process(job: Job<DeliveryJobData>): Promise<{ status: string; eventId: string }> {
    const { eventId } = job.data;
    const attemptNumber = job.data.attemptNumber || 1;

    logger.info({ jobId: job.id, eventId, attemptNumber }, 'Starting delivery processing');

    // 1. Load event
    if (!Types.ObjectId.isValid(eventId)) {
      logger.error({ eventId }, 'Invalid eventId format in delivery job');
      return { status: 'invalid_event_id', eventId };
    }

    const event = await EventModel.findById(eventId);
    if (!event) {
      logger.error({ eventId }, 'Event not found in database');
      return { status: 'event_not_found', eventId };
    }

    // 2. Load endpoint
    const endpoint = await EndpointModel.findById(event.endpointId);
    if (!endpoint) {
      logger.error({ endpointId: event.endpointId, eventId }, 'Endpoint not found for event');
      event.status = 'failed';
      await event.save();
      await this.publishStatus('event.status_changed', event, 'Endpoint not found');
      return { status: 'endpoint_not_found', eventId };
    }

    if (!endpoint.isActive) {
      logger.warn({ endpointId: endpoint._id, eventId }, 'Endpoint is inactive, skipping delivery');
      event.status = 'failed';
      await event.save();
      await this.publishStatus('event.status_changed', event, 'Endpoint inactive');
      return { status: 'endpoint_inactive', eventId };
    }

    // 3. Circuit breaker check
    const cbCheck = await this.cb.canExecute(endpoint.id);
    if (!cbCheck.allowed) {
      const waitMs = cbCheck.waitMs || 5000;
      logger.warn(
        { endpointId: endpoint.id, eventId, waitMs, reason: cbCheck.reason },
        'Circuit breaker active: re-scheduling job with delay',
      );

      const queue = getDeliveryQueue();
      await queue.add(
        'deliver',
        { eventId, attemptNumber },
        {
          delay: waitMs,
          jobId: `${eventId}-cb-delay-${Date.now()}`,
        },
      );

      return { status: 'circuit_breaker_paused', eventId };
    }

    // 4. Re-validate destination URL (SSRF guard at delivery time)
    const isUrlSafe = await validateDestinationUrl(endpoint.destinationUrl);
    if (!isUrlSafe) {
      logger.error(
        { destinationUrl: endpoint.destinationUrl, eventId },
        'Destination URL failed SSRF validation at delivery time: marking dead',
      );

      const durationMs = 0;
      await DeliveryAttemptModel.create({
        eventId: event._id,
        attemptNumber,
        startedAt: new Date(),
        durationMs,
        requestHeaders: {},
        responseStatus: 0,
        responseBodySnippet: '',
        error: 'SSRF guard: Destination URL resolves to forbidden address',
        success: false,
      });

      event.status = 'dead';
      event.attemptCount = attemptNumber;
      event.lastAttemptAt = new Date();
      event.nextAttemptAt = null;
      await event.save();

      await this.publishStatus('event.dead', event, 'SSRF rejection');
      return { status: 'ssrf_rejected', eventId };
    }

    // 5. Update status to 'delivering'
    event.status = 'delivering';
    await event.save();
    await this.publishStatus('event.status_changed', event);

    // 6. Check if CLI tunnel session is active first, otherwise deliver to remote destination
    let deliveryResult = await performTunnelDelivery(event, endpoint, attemptNumber, 15000);
    if (!deliveryResult) {
      deliveryResult = await performDelivery(event, endpoint, attemptNumber);
    }
    const classification = classifyResponse(deliveryResult.status);

    // 7. Record attempt
    await DeliveryAttemptModel.create({
      eventId: event._id,
      attemptNumber,
      startedAt: new Date(Date.now() - deliveryResult.durationMs),
      durationMs: deliveryResult.durationMs,
      requestHeaders: deliveryResult.requestHeaders,
      responseStatus: deliveryResult.status,
      responseBodySnippet: deliveryResult.responseBodySnippet,
      error: deliveryResult.error,
      success: classification === 'success',
    });

    event.attemptCount = attemptNumber;
    event.lastAttemptAt = new Date();

    // 8. Handle classification outcomes
    if (classification === 'success') {
      logger.info(
        {
          eventId,
          attemptNumber,
          durationMs: deliveryResult.durationMs,
          status: deliveryResult.status,
        },
        'Webhook delivery successful',
      );

      await this.cb.recordSuccess(endpoint.id);
      event.status = 'delivered';
      event.nextAttemptAt = null;
      await event.save();

      await this.publishStatus('event.status_changed', event);
      return { status: 'delivered', eventId };
    }

    if (classification === 'permanent') {
      logger.warn(
        { eventId, attemptNumber, status: deliveryResult.status, error: deliveryResult.error },
        'Permanent 4xx delivery failure: marking dead letter without retry',
      );

      await this.cb.recordFailure(endpoint.id);
      event.status = 'dead';
      event.nextAttemptAt = null;
      await event.save();

      await this.publishStatus('event.dead', event, deliveryResult.error);
      return { status: 'dead', eventId };
    }

    // Classification is 'retryable' (408, 429, 5xx, or network failure)
    await this.cb.recordFailure(endpoint.id);
    const maxAttempts = endpoint.retryPolicy.maxAttempts || 8;

    if (attemptNumber >= maxAttempts) {
      logger.warn(
        { eventId, attemptNumber, maxAttempts, error: deliveryResult.error },
        'Max delivery attempts exhausted: marking dead letter',
      );

      event.status = 'dead';
      event.nextAttemptAt = null;
      await event.save();

      await this.publishStatus('event.dead', event, deliveryResult.error);
      return { status: 'dead', eventId };
    }

    // Schedule retry with exponential backoff & full jitter
    const baseDelayMs = endpoint.retryPolicy.baseDelayMs || 1000;
    const maxDelayMs = endpoint.retryPolicy.maxDelayMs || 3600000;
    let delayMs = computeBackoff(attemptNumber, baseDelayMs, maxDelayMs);

    // Respect Retry-After header on 429
    if (deliveryResult.status === 429 && deliveryResult.retryAfterSec) {
      delayMs = Math.max(delayMs, deliveryResult.retryAfterSec * 1000);
    }

    const nextAttemptNumber = attemptNumber + 1;
    event.status = 'failed';
    event.nextAttemptAt = new Date(Date.now() + delayMs);
    await event.save();

    await this.publishStatus('event.status_changed', event, deliveryResult.error);

    // Enqueue delayed retry job in BullMQ
    const queue = getDeliveryQueue();
    await queue.add(
      'deliver',
      { eventId, attemptNumber: nextAttemptNumber },
      {
        delay: delayMs,
        jobId: `${eventId}-retry-${nextAttemptNumber}`,
      },
    );

    logger.info(
      { eventId, attemptNumber, nextAttemptNumber, delayMs },
      `Scheduled retry attempt ${nextAttemptNumber} in ${delayMs}ms`,
    );

    return { status: 'retry_scheduled', eventId };
  }
}

export const deliveryProcessorInstance = new DeliveryProcessor();
export const deliveryProcessor = (job: Job<DeliveryJobData>) =>
  deliveryProcessorInstance.process(job);
