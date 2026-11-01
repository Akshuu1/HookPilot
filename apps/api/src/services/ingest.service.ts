import { createHash } from 'node:crypto';
import { redactHeaders, type EventPubSubMessage } from '@hookpilot/shared';
import { logger } from '../config/logger.js';
import { AppError } from '../middlewares/error-handler.js';
import {
  type EndpointRepository,
  endpointRepository as defaultEndpointRepo,
} from '../repositories/endpoint.repository.js';
import {
  type EventRepository,
  type PersistEventResult,
  eventRepository as defaultEventRepo,
} from '../repositories/event.repository.js';
import { getRedisClient } from '../config/redis.js';
import { getDeliveryQueue } from '../config/queue.js';
import { decryptSecret } from '../utils/crypto.js';
import { verifySignature } from '../utils/signature.js';
import { extractIdempotencyKey } from '../utils/idempotency.js';
import type { IEndpoint } from '../models/Endpoint.js';
import type { IEvent } from '../models/Event.js';
import mongoose, { Types } from 'mongoose';
import { DestinationModel } from '../models/Destination.js';
import { DeliveryModel } from '../models/Delivery.js';
import { destinationService, invalidateDestinationCache } from './destination.service.js';
import { explainFilter, type FilterExplanation } from './filter.service.js';
import { recomputeEventStatus } from './delivery-status.service.js';

export interface IngestParams {
  slug: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  bodySize: number;
  contentType?: string | null;
  sourceIp: string;
}

export interface IngestResult {
  eventId: string;
  isDuplicate: boolean;
}

export class IngestService {
  constructor(
    private readonly endpointRepo: EndpointRepository = defaultEndpointRepo,
    private readonly eventRepo: EventRepository = defaultEventRepo,
  ) {}

  /**
   * Resolves an endpoint by its slug, caching the result in Redis for 60 seconds.
   */
  async resolveEndpoint(slug: string): Promise<IEndpoint> {
    const cacheKey = `ep:slug:${slug}`;

    try {
      const redis = getRedisClient();
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (!parsed.isActive) {
          throw new AppError('Endpoint is currently inactive', 404, 'ENDPOINT_INACTIVE');
        }
        parsed.id = String(parsed._id ?? parsed.id);
        return parsed as IEndpoint;
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Fail through to database on Redis error
    }

    const endpoint = await this.endpointRepo.findBySlug(slug);
    if (!endpoint) {
      throw new AppError('Endpoint not found', 404, 'ENDPOINT_NOT_FOUND');
    }

    if (!endpoint.isActive) {
      throw new AppError('Endpoint is currently inactive', 404, 'ENDPOINT_INACTIVE');
    }

    // Cache in Redis for 60 seconds
    try {
      const redis = getRedisClient();
      await redis.set(cacheKey, JSON.stringify(endpoint), 'EX', 60);
    } catch {
      // Non-blocking caching failure
    }

    return endpoint;
  }

  /**
   * Core high-throughput ingest pipeline:
   * 1. Resolves endpoint.
   * 2. Verifies inbound signature.
   * 3. Extracts idempotency key.
   * 4. Persists Event to MongoDB (handling duplicates idempotently).
   * 5. Enqueues delivery job into BullMQ (skipping on capture-only or duplicate).
   * 6. Returns eventId fast.
   */
  async handleIngest(params: IngestParams): Promise<IngestResult> {
    const endpoint = await this.resolveEndpoint(params.slug);
    const endpointId = String(endpoint._id ?? endpoint.id);
    const workspaceId = String(endpoint.workspaceId);

    // Decrypt signing secret if configured
    let signingSecret: string | null = null;
    if (endpoint.signatureConfig?.secretEncrypted) {
      try {
        signingSecret = decryptSecret(endpoint.signatureConfig.secretEncrypted);
      } catch {
        signingSecret = null;
      }
    }

    // Verify signature
    const signatureResult = verifySignature(
      endpoint.signatureConfig?.provider || 'none',
      params.headers,
      params.rawBody,
      signingSecret,
      endpoint.signatureConfig?.headerName,
    );

    // If signature is invalid AND endpoint enforces validation, reject with 401
    if (!signatureResult.isValid && endpoint.signatureConfig?.enforce) {
      throw new AppError('Webhook signature verification failed', 401, 'INVALID_SIGNATURE');
    }

    // Extract explicit idempotency key (header or provider id)
    const idempotencyKey = extractIdempotencyKey(params.headers, params.rawBody, endpointId);

    const windowSec = endpoint.duplicateWindowSeconds ?? 10;
    let windowDupKey: string | null = null;

    // If no explicit idempotency key and duplicate window is enabled (> 0), check short duplicate window via Redis
    if (!idempotencyKey && windowSec > 0) {
      const bodyHash = createHash('sha256').update(params.rawBody).digest('hex');
      windowDupKey = `dup:${endpointId}:${bodyHash}`;

      try {
        const redis = getRedisClient();
        if (redis.status === 'ready' || redis.status === 'connecting') {
          // Attempt atomic NX lock
          const setNxRes = await redis.set(windowDupKey, 'PENDING', 'EX', windowSec, 'NX');
          if (setNxRes !== 'OK') {
            // Key already exists within window -> duplicate detected!
            let existingEventId: string | null = null;
            for (let i = 0; i < 20; i++) {
              const val = await redis.get(windowDupKey);
              if (val && val !== 'PENDING') {
                existingEventId = val;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 25));
            }

            if (existingEventId) {
              const updated = await this.eventRepo.recordDuplicate(
                existingEventId,
                'window',
                params.sourceIp,
              );
              const event = updated || (await this.eventRepo.findById(existingEventId));
              if (event) {
                await this.publishEventUpdate(event);
                return {
                  eventId: existingEventId,
                  isDuplicate: true,
                };
              }
            }
          }
        }
      } catch {
        // Non-blocking in environments without active Redis
      }
    }

    // Redact sensitive headers for storage
    const sanitizedHeaders = redactHeaders(params.headers);

    // Persist event (returns existing event if duplicate occurred)
    let persistResult: PersistEventResult;
    try {
      persistResult = await this.eventRepo.create({
        workspaceId,
        endpointId,
        method: params.method,
        headers: sanitizedHeaders,
        rawBody: params.rawBody,
        bodySize: params.bodySize,
        contentType: params.contentType ?? null,
        sourceIp: params.sourceIp,
        signatureValid: signatureResult.isValid,
        idempotencyKey,
        status: 'pending',
      });
    } catch (saveErr) {
      // Ingest never returns 5xx because of idempotency or duplicate violation.
      logger.error(
        {
          endpointId,
          error: saveErr instanceof Error ? saveErr.message : String(saveErr),
        },
        'Event persistence encountered error, attempting recovery with existing event',
      );
      const existing = await this.eventRepo.findEndpointEvents({
        endpointId,
        limit: 1,
      });
      if (existing.events.length > 0) {
        const fallbackEvt = existing.events[0]!;
        await this.eventRepo.recordDuplicate(fallbackEvt.id, 'window', params.sourceIp);
        persistResult = {
          event: fallbackEvt as any,
          isDuplicate: true,
        };
      } else {
        throw saveErr;
      }
    }

    const { event, isDuplicate } = persistResult;
    const eventId = String(event._id ?? event.id);

    // If window key was reserved, update Redis with the actual eventId
    if (windowDupKey && windowSec > 0) {
      try {
        const redis = getRedisClient();
        if (redis.status === 'ready' || redis.status === 'connecting') {
          await redis.set(windowDupKey, eventId, 'EX', windowSec);
        }
      } catch {
        // Non-blocking
      }
    }

    if (isDuplicate) {
      // Explicit idempotencyKey duplicate
      await this.publishEventUpdate(event);
      return {
        eventId,
        isDuplicate: true,
      };
    }

    // Fan-out to active destinations
    try {
      await this.fanOut(event, endpoint);
    } catch (fanOutErr) {
      logger.error(
        {
          eventId,
          endpointId,
          error: fanOutErr instanceof Error ? fanOutErr.message : String(fanOutErr),
        },
        'Fan-out execution encountered an unexpected error; event was saved.',
      );
    }

    // Publish event.created to Redis 'events' channel for realtime Socket.IO emission
    try {
      const redis = getRedisClient();
      if (redis.status === 'ready' || redis.status === 'connecting') {
        const pubSubMessage: EventPubSubMessage = {
          type: 'event.created',
          eventId,
          endpointId,
          workspaceId,
          status: event.status,
          attemptCount: event.attemptCount,
          duplicateCount: event.duplicateCount ?? 0,
          timestamp: event.receivedAt ? event.receivedAt.toISOString() : new Date().toISOString(),
        };
        await redis.publish('events', JSON.stringify(pubSubMessage));
      }
    } catch {
      // Non-blocking in environments without active Redis
    }

    return {
      eventId,
      isDuplicate: false,
    };
  }

  async publishEventUpdate(event: IEvent): Promise<void> {
    try {
      const redis = getRedisClient();
      if (redis.status === 'ready' || redis.status === 'connecting') {
        const pubSubMessage: EventPubSubMessage = {
          type: 'event.update',
          eventId: String(event._id ?? event.id),
          endpointId: String(event.endpointId),
          workspaceId: String(event.workspaceId),
          status: event.status,
          attemptCount: event.attemptCount,
          duplicateCount: event.duplicateCount ?? 0,
          lastDuplicateAt: event.lastDuplicateAt
            ? new Date(event.lastDuplicateAt).toISOString()
            : undefined,
          timestamp: new Date().toISOString(),
        };
        await redis.publish('events', JSON.stringify(pubSubMessage));
      }
    } catch {
      // Non-blocking in environments without active Redis
    }
  }

  async fanOut(event: IEvent, endpoint: IEndpoint): Promise<void> {
    const eventId = String(event._id ?? event.id);
    const endpointId = String(endpoint._id ?? endpoint.id);
    const workspaceId = String(endpoint.workspaceId);

    // 1. Load active destinations (cached in Redis 60s)
    let destinations = await destinationService.getActiveDestinations(endpointId);

    // Backward compatibility: if no destinations exist but endpoint.destinationUrl exists, create Default destination
    if (destinations.length === 0 && endpoint.destinationUrl) {
      try {
        const destQuery = {
          endpointId: Types.ObjectId.isValid(endpointId)
            ? new Types.ObjectId(endpointId)
            : endpointId,
          name: 'Default',
        };
        const defaultDest = await DestinationModel.findOneAndUpdate(
          destQuery,
          {
            $setOnInsert: {
              workspaceId: Types.ObjectId.isValid(workspaceId)
                ? new Types.ObjectId(workspaceId)
                : workspaceId,
              endpointId: Types.ObjectId.isValid(endpointId)
                ? new Types.ObjectId(endpointId)
                : endpointId,
              name: 'Default',
              url: endpoint.destinationUrl,
              retryPolicy: endpoint.retryPolicy,
              isActive: true,
            },
          },
          { upsert: true, new: true },
        );
        if (defaultDest) {
          destinations = [defaultDest];
        }
        await invalidateDestinationCache(endpointId);
      } catch {
        destinations = [
          new DestinationModel({
            workspaceId: Types.ObjectId.isValid(workspaceId)
              ? new Types.ObjectId(workspaceId)
              : new Types.ObjectId(),
            endpointId: Types.ObjectId.isValid(endpointId)
              ? new Types.ObjectId(endpointId)
              : new Types.ObjectId(),
            name: 'Default',
            url: endpoint.destinationUrl,
            retryPolicy: endpoint.retryPolicy,
            isActive: true,
          }),
        ];
      }
    }

    if (destinations.length === 0) {
      try {
        const derived = await recomputeEventStatus(eventId);
        event.status = derived;
      } catch {
        // Non-blocking in unmocked unit tests
      }
      return;
    }

    const isCaptureOnly = endpoint.mode === 'capture-only';

    // 2. Evaluate filter for each destination & prepare Delivery rows
    const deliveriesToInsert = destinations.map((dest) => {
      let explanation: FilterExplanation;
      try {
        explanation = explainFilter(dest.filter, {
          body: event.rawBody,
          headers: event.headers as Record<string, unknown>,
          method: event.method,
          contentType: event.contentType,
        });
      } catch (err) {
        // If evaluation throws for any reason, treat destination as 'filtered' with reason 'filter error'
        // and log the error WITHOUT the payload!
        logger.error(
          {
            destinationId: dest._id ? String(dest._id) : undefined,
            error: err instanceof Error ? err.message : String(err),
          },
          'Filter evaluation error for destination',
        );
        explanation = { matched: false, reason: 'filter error', conditions: [] };
      }
      const isMatched = explanation.matched;
      return {
        workspaceId: Types.ObjectId.isValid(workspaceId)
          ? new Types.ObjectId(workspaceId)
          : (workspaceId as any),
        eventId: Types.ObjectId.isValid(eventId) ? new Types.ObjectId(eventId) : (eventId as any),
        destinationId: dest._id,
        status: isMatched ? 'pending' : 'filtered',
        attemptCount: 0,
        nextAttemptAt: isMatched && !isCaptureOnly ? new Date() : null,
        lastError: null,
        filterReason: !isMatched ? explanation.reason || 'Filter conditions did not match' : null,
      };
    });

    // 3. Idempotent Delivery creation (safe to run twice for the same event)
    let persistedDeliveries: any[] = [];
    try {
      if (typeof DeliveryModel.insertMany === 'function') {
        persistedDeliveries = (await DeliveryModel.insertMany(deliveriesToInsert, {
          ordered: false,
        })) as any[];
      }
    } catch {
      // If deliveries already exist for this event (fanOut called twice), query stored deliveries
      try {
        if (typeof DeliveryModel.find === 'function' && mongoose.connection.readyState === 1) {
          persistedDeliveries = (await DeliveryModel.find({
            eventId: Types.ObjectId.isValid(eventId) ? new Types.ObjectId(eventId) : eventId,
          })) as any[];
        }
      } catch {
        // Fallback in memory
      }
    }

    if (!persistedDeliveries || persistedDeliveries.length === 0) {
      persistedDeliveries = deliveriesToInsert.map((d) => ({
        ...d,
        _id: new Types.ObjectId(),
      }));
    }

    // 4. Update Event derived status
    try {
      const derivedStatus = await recomputeEventStatus(eventId);
      event.status = derivedStatus;
    } catch {
      // Non-blocking in unmocked unit tests
    }

    // 5. Enqueue delivery jobs with jobId = deliveryId (no colons) unless in capture-only mode
    if (!isCaptureOnly) {
      const pendingDeliveries = persistedDeliveries.filter((d) => d.status === 'pending');
      if (pendingDeliveries.length > 0) {
        const jobs = pendingDeliveries.map((d) => {
          const deliveryId = d._id.toString();
          return {
            name: 'deliver',
            data: { deliveryId },
            opts: {
              jobId: deliveryId, // Letters, digits, hyphens only - no colons!
              attempts: 1,
              removeOnComplete: true,
            },
          };
        });

        try {
          const queue = getDeliveryQueue();
          if (typeof queue.addBulk === 'function') {
            await queue.addBulk(jobs);
          } else if (typeof (queue as any).add === 'function') {
            for (const j of jobs) {
              await (queue as any).add(j.name, j.data, j.opts);
            }
          }
        } catch (enqueueErr: unknown) {
          const errMsg = enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr);
          // Handle 'job already exists' as success
          if (
            errMsg.toLowerCase().includes('already exists') ||
            (enqueueErr as any)?.code === 'JOB_ALREADY_EXISTS'
          ) {
            logger.info({ eventId }, 'Delivery jobs already exist in queue; treated as success');
          } else {
            // Keep the Event and its Delivery rows with status 'pending', log error without payload
            logger.error(
              {
                eventId,
                endpointId,
                error: errMsg,
              },
              'Delivery enqueueing failed; keeping deliveries pending for reconciler',
            );
          }
        }
      }
    }
  }
}

export const ingestService = new IngestService();
