import { redactHeaders, type EventPubSubMessage } from '@hookpilot/shared';
import { AppError } from '../middlewares/error-handler.js';
import {
  type EndpointRepository,
  endpointRepository as defaultEndpointRepo,
} from '../repositories/endpoint.repository.js';
import {
  type EventRepository,
  eventRepository as defaultEventRepo,
} from '../repositories/event.repository.js';
import { getRedisClient } from '../config/redis.js';
import { getDeliveryQueue } from '../config/queue.js';
import { decryptSecret } from '../utils/crypto.js';
import { verifySignature } from '../utils/signature.js';
import { extractIdempotencyKey } from '../utils/idempotency.js';
import type { IEndpoint } from '../models/Endpoint.js';

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
      throw new AppError(
        `Signature verification failed: ${signatureResult.reason || 'Invalid signature'}`,
        401,
        'INVALID_SIGNATURE',
      );
    }

    // Extract idempotency key
    const idempotencyKey = extractIdempotencyKey(params.headers, params.rawBody, endpointId);

    // Redact sensitive headers for storage
    const sanitizedHeaders = redactHeaders(params.headers);

    // Persist event (returns existing event if duplicate key error occurred)
    const { event, isDuplicate } = await this.eventRepo.create({
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

    const eventId = String(event._id ?? event.id);

    // Enqueue delivery job to BullMQ queue 'delivery' with jobId = eventId
    // Skip if mode is capture-only OR if this was a duplicate of an already enqueued event
    if (!isDuplicate && endpoint.mode !== 'capture-only') {
      try {
        const queue = getDeliveryQueue();
        await queue.add(
          'deliver',
          { eventId },
          {
            jobId: eventId,
            attempts: 1,
            removeOnComplete: true,
          },
        );
      } catch {
        // In environments without Redis (e.g. basic unit tests), let persistence stand
      }
    }

    // Publish event.created to Redis 'events' channel for realtime Socket.IO emission
    if (!isDuplicate) {
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
            timestamp: event.receivedAt ? event.receivedAt.toISOString() : new Date().toISOString(),
          };
          await redis.publish('events', JSON.stringify(pubSubMessage));
        }
      } catch {
        // Non-blocking in environments without active Redis
      }
    }

    return {
      eventId,
      isDuplicate,
    };
  }
}

export const ingestService = new IngestService();
