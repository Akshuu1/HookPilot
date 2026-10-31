import type { Job } from 'bullmq';
import { Types } from 'mongoose';
import { computeBackoff, validateDestinationUrl, type EventPubSubMessage } from '@hookpilot/shared';
import { EventModel, type IEvent } from '../models/Event.js';
import { EndpointModel } from '../models/Endpoint.js';
import { DeliveryModel, type IDelivery } from '../models/Delivery.js';
import { DestinationModel } from '../models/Destination.js';
import { DeliveryAttemptModel } from '../models/DeliveryAttempt.js';
import { recomputeEventStatus } from '../services/delivery-status.service.js';
import {
  performDelivery,
  performDestinationDelivery,
  performTunnelDelivery,
  classifyResponse,
} from '../services/delivery.service.js';
import { circuitBreaker, type CircuitBreaker } from '../services/circuit-breaker.js';
import { getRedisClient, getDeliveryQueue } from '../config/redis.js';
import { logger } from '../config/logger.js';

export interface DeliveryJobData {
  deliveryId?: string;
  eventId?: string;
  attemptNumber?: number;
}

export class DeliveryProcessor {
  constructor(private readonly cb: CircuitBreaker = circuitBreaker) {}

  async checkDestinationRateLimit(
    destinationId: string,
    limitPerMin: number,
  ): Promise<{ allowed: boolean; retryAfterMs: number }> {
    try {
      const redis = getRedisClient();
      const key = `ratelimit:dest:${destinationId}`;
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, 60);
      }
      if (count > limitPerMin) {
        const ttl = await redis.ttl(key);
        return { allowed: false, retryAfterMs: Math.max(ttl * 1000, 1000) };
      }
      return { allowed: true, retryAfterMs: 0 };
    } catch {
      return { allowed: true, retryAfterMs: 0 };
    }
  }

  async publishStatus(
    type: 'event.status_changed' | 'event.dead' | 'event.update',
    event: IEvent,
    error?: string | null,
  ): Promise<void> {
    try {
      const redis = getRedisClient();
      const payload: EventPubSubMessage = {
        type: type === 'event.update' ? 'event.update' : type,
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

  async publishDeliveryStatus(
    type: 'delivery.update' | 'delivery.status_changed',
    delivery: IDelivery,
    error?: string | null,
  ): Promise<void> {
    try {
      const redis = getRedisClient();
      const payload: EventPubSubMessage = {
        type,
        eventId: delivery.eventId?.toString() || '',
        deliveryId: delivery._id?.toString() || '',
        destinationId: delivery.destinationId?.toString() || '',
        workspaceId: delivery.workspaceId?.toString() || '',
        status: delivery.status,
        attemptCount: delivery.attemptCount,
        timestamp: new Date().toISOString(),
        ...(error ? { error } : {}),
      };
      await redis.publish('events', JSON.stringify(payload));
    } catch (err) {
      logger.error({ err, deliveryId: delivery._id }, 'Failed to publish delivery status to Redis');
    }
  }

  async process(job: Job<DeliveryJobData>): Promise<{ status: string; id: string }> {
    const { deliveryId, eventId } = job.data;

    // Handle fan-out delivery job
    if (deliveryId) {
      return this.processDelivery(deliveryId, job);
    }

    // Fallback: Legacy event delivery job
    if (eventId) {
      return this.processLegacyEvent(eventId, job);
    }

    logger.error({ jobData: job.data }, 'Neither deliveryId nor eventId provided in job');
    return { status: 'invalid_job_data', id: '' };
  }

  private async processDelivery(
    deliveryId: string,
    job: Job<DeliveryJobData>,
  ): Promise<{ status: string; id: string }> {
    logger.info({ jobId: job.id, deliveryId }, 'Starting delivery processing');

    if (!Types.ObjectId.isValid(deliveryId)) {
      logger.error({ deliveryId }, 'Invalid deliveryId format');
      return { status: 'invalid_delivery_id', id: deliveryId };
    }

    const delivery = await DeliveryModel.findById(deliveryId);
    if (!delivery) {
      logger.error({ deliveryId }, 'Delivery not found');
      return { status: 'delivery_not_found', id: deliveryId };
    }

    const destination = await DestinationModel.findById(delivery.destinationId);
    if (!destination) {
      logger.error({ destinationId: delivery.destinationId }, 'Destination not found');
      delivery.status = 'failed';
      delivery.lastError = 'Destination not found';
      await delivery.save();
      await recomputeEventStatus(delivery.eventId.toString());
      return { status: 'destination_not_found', id: deliveryId };
    }

    if (!destination.isActive) {
      logger.warn({ destinationId: destination._id }, 'Destination inactive');
      delivery.status = 'failed';
      delivery.lastError = 'Destination inactive';
      await delivery.save();
      await recomputeEventStatus(delivery.eventId.toString());
      return { status: 'destination_inactive', id: deliveryId };
    }

    const event = await EventModel.findById(delivery.eventId);
    if (!event) {
      logger.error({ eventId: delivery.eventId }, 'Event not found');
      delivery.status = 'failed';
      delivery.lastError = 'Event not found';
      await delivery.save();
      return { status: 'event_not_found', id: deliveryId };
    }

    const endpoint = await EndpointModel.findById(event.endpointId);
    if (!endpoint) {
      logger.error({ endpointId: event.endpointId }, 'Endpoint not found');
      delivery.status = 'failed';
      delivery.lastError = 'Endpoint not found';
      await delivery.save();
      await recomputeEventStatus(delivery.eventId.toString());
      return { status: 'endpoint_not_found', id: deliveryId };
    }

    // 1. SSRF Guard on destination.url
    const isUrlSafe = await validateDestinationUrl(destination.url);
    if (!isUrlSafe) {
      logger.error(
        { destinationUrl: destination.url, deliveryId },
        'Destination URL failed SSRF validation at delivery time: marking dead',
      );

      const attemptNumber = delivery.attemptCount + 1;
      await DeliveryAttemptModel.create({
        eventId: event._id,
        deliveryId: delivery._id,
        destinationId: destination._id,
        attemptNumber,
        startedAt: new Date(),
        durationMs: 0,
        requestHeaders: {},
        responseStatus: 0,
        responseBodySnippet: '',
        error: 'SSRF guard: Destination URL resolves to forbidden address',
        success: false,
      });

      delivery.status = 'dead';
      delivery.attemptCount = attemptNumber;
      delivery.lastError = 'SSRF guard: Destination URL resolves to forbidden address';
      delivery.nextAttemptAt = null;
      await delivery.save();

      await recomputeEventStatus(delivery.eventId.toString());
      await this.publishDeliveryStatus('delivery.update', delivery, delivery.lastError);
      return { status: 'ssrf_rejected', id: deliveryId };
    }

    // 2. Destination Rate Limit check (keyed by destinationId)
    if (destination.rateLimitPerMin) {
      const rlCheck = await this.checkDestinationRateLimit(
        destination._id.toString(),
        destination.rateLimitPerMin,
      );
      if (!rlCheck.allowed) {
        logger.warn(
          { destinationId: destination._id, delayMs: rlCheck.retryAfterMs },
          'Destination rate limit exceeded: rescheduling without counting attempt',
        );

        const queue = getDeliveryQueue();
        await queue.add(
          'deliver',
          { deliveryId },
          {
            delay: rlCheck.retryAfterMs,
            jobId: `${deliveryId}-rl-${Date.now()}`,
          },
        );
        return { status: 'rate_limited', id: deliveryId };
      }
    }

    // 3. Circuit Breaker check (keyed by destinationId)
    const cbCheck = await this.cb.canExecute(destination._id.toString());
    if (!cbCheck.allowed) {
      const waitMs = cbCheck.waitMs || 5000;
      logger.warn(
        { destinationId: destination._id, deliveryId, waitMs, reason: cbCheck.reason },
        'Circuit breaker active: re-scheduling job with delay',
      );

      const queue = getDeliveryQueue();
      await queue.add(
        'deliver',
        { deliveryId },
        {
          delay: waitMs,
          jobId: `${deliveryId}-cb-${Date.now()}`,
        },
      );
      return { status: 'circuit_breaker_paused', id: deliveryId };
    }

    // 4. Update status to 'delivering'
    delivery.status = 'delivering';
    await delivery.save();
    await recomputeEventStatus(delivery.eventId.toString());
    await this.publishDeliveryStatus('delivery.update', delivery);

    // 5. Perform delivery with destination-specific headers & secret
    const attemptNumber = delivery.attemptCount + 1;
    const deliveryResult = await performDestinationDelivery(
      event,
      destination,
      endpoint,
      attemptNumber,
    );
    const classification = classifyResponse(deliveryResult.status);

    // 6. Record attempt
    await DeliveryAttemptModel.create({
      eventId: event._id,
      deliveryId: delivery._id,
      destinationId: destination._id,
      attemptNumber,
      startedAt: new Date(Date.now() - deliveryResult.durationMs),
      durationMs: deliveryResult.durationMs,
      requestHeaders: deliveryResult.requestHeaders,
      responseStatus: deliveryResult.status,
      responseBodySnippet: deliveryResult.responseBodySnippet,
      error: deliveryResult.error,
      success: classification === 'success',
    });

    delivery.attemptCount = attemptNumber;

    // 7. Handle classification
    if (classification === 'success') {
      logger.info(
        { deliveryId, attemptNumber, status: deliveryResult.status },
        'Destination delivery successful',
      );

      await this.cb.recordSuccess(destination._id.toString());
      delivery.status = 'delivered';
      delivery.nextAttemptAt = null;
      delivery.lastError = null;
      await delivery.save();

      await recomputeEventStatus(delivery.eventId.toString());
      await this.publishDeliveryStatus('delivery.update', delivery);
      return { status: 'delivered', id: deliveryId };
    }

    if (classification === 'permanent') {
      logger.warn(
        { deliveryId, attemptNumber, status: deliveryResult.status, error: deliveryResult.error },
        'Permanent failure: marking delivery dead letter',
      );

      await this.cb.recordFailure(destination._id.toString());
      delivery.status = 'dead';
      delivery.nextAttemptAt = null;
      delivery.lastError = deliveryResult.error || null;
      await delivery.save();

      await recomputeEventStatus(delivery.eventId.toString());
      await this.publishDeliveryStatus('delivery.update', delivery, deliveryResult.error);
      return { status: 'dead', id: deliveryId };
    }

    // Classification is 'retryable'
    await this.cb.recordFailure(destination._id.toString());
    const retryPolicy = destination.retryPolicy ||
      endpoint.retryPolicy || {
        maxAttempts: 8,
        baseDelayMs: 1000,
        maxDelayMs: 3600000,
      };
    const maxAttempts = retryPolicy.maxAttempts || 8;

    if (attemptNumber >= maxAttempts) {
      logger.warn(
        { deliveryId, attemptNumber, maxAttempts, error: deliveryResult.error },
        'Max delivery attempts exhausted: marking delivery dead letter',
      );

      delivery.status = 'dead';
      delivery.nextAttemptAt = null;
      delivery.lastError = deliveryResult.error || null;
      await delivery.save();

      await recomputeEventStatus(delivery.eventId.toString());
      await this.publishDeliveryStatus('delivery.update', delivery, deliveryResult.error);
      return { status: 'dead', id: deliveryId };
    }

    let delayMs = computeBackoff(
      attemptNumber,
      retryPolicy.baseDelayMs || 1000,
      retryPolicy.maxDelayMs || 3600000,
    );

    if (deliveryResult.status === 429 && deliveryResult.retryAfterSec) {
      delayMs = Math.max(delayMs, deliveryResult.retryAfterSec * 1000);
    }

    const nextAttemptNumber = attemptNumber + 1;
    delivery.status = 'failed';
    delivery.nextAttemptAt = new Date(Date.now() + delayMs);
    delivery.lastError = deliveryResult.error || null;
    await delivery.save();

    await recomputeEventStatus(delivery.eventId.toString());
    await this.publishDeliveryStatus('delivery.update', delivery, deliveryResult.error);

    const queue = getDeliveryQueue();
    await queue.add(
      'deliver',
      { deliveryId },
      {
        delay: delayMs,
        jobId: `${deliveryId}-retry-${nextAttemptNumber}`,
      },
    );

    logger.info(
      { deliveryId, attemptNumber, nextAttemptNumber, delayMs },
      `Scheduled retry attempt ${nextAttemptNumber} in ${delayMs}ms`,
    );

    return { status: 'retry_scheduled', id: deliveryId };
  }

  private async processLegacyEvent(
    eventId: string,
    job: Job<DeliveryJobData>,
  ): Promise<{ status: string; id: string }> {
    const attemptNumber = job.data.attemptNumber || 1;

    if (!Types.ObjectId.isValid(eventId)) {
      return { status: 'invalid_event_id', id: eventId };
    }

    const event = await EventModel.findById(eventId);
    if (!event) {
      return { status: 'event_not_found', id: eventId };
    }

    const endpoint = await EndpointModel.findById(event.endpointId);
    if (!endpoint) {
      event.status = 'failed';
      await event.save();
      await this.publishStatus('event.status_changed', event, 'Endpoint not found');
      return { status: 'endpoint_not_found', id: eventId };
    }

    if (!endpoint.isActive) {
      event.status = 'failed';
      await event.save();
      await this.publishStatus('event.status_changed', event, 'Endpoint inactive');
      return { status: 'endpoint_inactive', id: eventId };
    }

    const cbCheck = await this.cb.canExecute(endpoint.id);
    if (!cbCheck.allowed) {
      const waitMs = cbCheck.waitMs || 5000;
      const queue = getDeliveryQueue();
      await queue.add(
        'deliver',
        { eventId, attemptNumber },
        { delay: waitMs, jobId: `${eventId}-cb-delay-${Date.now()}` },
      );
      return { status: 'circuit_breaker_paused', id: eventId };
    }

    const isUrlSafe = await validateDestinationUrl(endpoint.destinationUrl);
    if (!isUrlSafe) {
      await DeliveryAttemptModel.create({
        eventId: event._id,
        attemptNumber,
        startedAt: new Date(),
        durationMs: 0,
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
      return { status: 'ssrf_rejected', id: eventId };
    }

    event.status = 'delivering';
    await event.save();
    await this.publishStatus('event.status_changed', event);

    let deliveryResult = await performTunnelDelivery(event, endpoint, attemptNumber, 15000);
    if (!deliveryResult) {
      deliveryResult = await performDelivery(event, endpoint, attemptNumber);
    }
    const classification = classifyResponse(deliveryResult.status);

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

    if (classification === 'success') {
      await this.cb.recordSuccess(endpoint.id);
      event.status = 'delivered';
      event.nextAttemptAt = null;
      await event.save();
      await this.publishStatus('event.status_changed', event);
      return { status: 'delivered', id: eventId };
    }

    if (classification === 'permanent') {
      await this.cb.recordFailure(endpoint.id);
      event.status = 'dead';
      event.nextAttemptAt = null;
      await event.save();
      await this.publishStatus('event.dead', event, deliveryResult.error);
      return { status: 'dead', id: eventId };
    }

    await this.cb.recordFailure(endpoint.id);
    const maxAttempts = endpoint.retryPolicy.maxAttempts || 8;

    if (attemptNumber >= maxAttempts) {
      event.status = 'dead';
      event.nextAttemptAt = null;
      await event.save();
      await this.publishStatus('event.dead', event, deliveryResult.error);
      return { status: 'dead', id: eventId };
    }

    const baseDelayMs = endpoint.retryPolicy.baseDelayMs || 1000;
    const maxDelayMs = endpoint.retryPolicy.maxDelayMs || 3600000;
    let delayMs = computeBackoff(attemptNumber, baseDelayMs, maxDelayMs);

    if (deliveryResult.status === 429 && deliveryResult.retryAfterSec) {
      delayMs = Math.max(delayMs, deliveryResult.retryAfterSec * 1000);
    }

    const nextAttemptNumber = attemptNumber + 1;
    event.status = 'failed';
    event.nextAttemptAt = new Date(Date.now() + delayMs);
    await event.save();

    await this.publishStatus('event.status_changed', event, deliveryResult.error);

    const queue = getDeliveryQueue();
    await queue.add(
      'deliver',
      { eventId, attemptNumber: nextAttemptNumber },
      { delay: delayMs, jobId: `${eventId}-retry-${nextAttemptNumber}` },
    );

    return { status: 'retry_scheduled', id: eventId };
  }
}

export const deliveryProcessorInstance = new DeliveryProcessor();
export const deliveryProcessor = (job: Job<DeliveryJobData>) =>
  deliveryProcessorInstance.process(job);
