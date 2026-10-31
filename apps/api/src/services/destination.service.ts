import { Types } from 'mongoose';
import {
  validateDestinationUrl,
  type CreateDestinationInput,
  type UpdateDestinationInput,
  type DestinationResponse,
  type TestFilterInput,
  type FilterInput,
  type FilterExplanation,
  evaluateFilter,
  explainFilter,
} from '@hookpilot/shared';
import { AppError } from '../middlewares/error-handler.js';
import { DestinationModel, type IDestination } from '../models/Destination.js';
import { EndpointModel } from '../models/Endpoint.js';
import { DeliveryModel } from '../models/Delivery.js';
import { EventModel } from '../models/Event.js';
import { encryptSecret } from '../utils/crypto.js';
import { getRedisClient } from '../config/redis.js';
import { recomputeEventStatus } from './delivery-status.service.js';

export async function invalidateDestinationCache(endpointId: string): Promise<void> {
  try {
    const redis = getRedisClient();
    await Promise.race([
      redis.del(`ep:dest:${endpointId}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 250)),
    ]);
  } catch {
    // Non-blocking in environments without active Redis
  }
}

export function mapDestinationResponse(doc: IDestination): DestinationResponse {
  return {
    id: doc._id.toString(),
    workspaceId: doc.workspaceId.toString(),
    endpointId: doc.endpointId.toString(),
    name: doc.name,
    url: doc.url,
    customHeaders: (doc.customHeaders || []).map((h) => ({
      name: h.name,
      configured: true,
    })),
    isActive: doc.isActive,
    retryPolicy: doc.retryPolicy
      ? {
          maxAttempts: doc.retryPolicy.maxAttempts,
          baseDelayMs: doc.retryPolicy.baseDelayMs,
          maxDelayMs: doc.retryPolicy.maxDelayMs,
        }
      : undefined,
    rateLimitPerMin: doc.rateLimitPerMin ?? null,
    filter: doc.filter ?? null,
    outboundSecretConfigured: !!doc.outboundSecretEncrypted,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export class DestinationService {
  async getActiveDestinations(endpointId: string): Promise<IDestination[]> {
    try {
      const redis = getRedisClient();
      const cached = await Promise.race([
        redis.get(`ep:dest:${endpointId}`),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 250)),
      ]);
      if (cached) {
        const parsed = JSON.parse(cached) as Array<Record<string, unknown>>;
        return parsed.map((item) => new DestinationModel(item));
      }
    } catch {
      // Redis unavailable or timed out, query database directly
    }

    let destinations: IDestination[] = [];
    try {
      const filter = Types.ObjectId.isValid(endpointId)
        ? { endpointId: new Types.ObjectId(endpointId), isActive: true }
        : { endpointId: endpointId as any, isActive: true };
      destinations = await DestinationModel.find(filter).sort({ createdAt: 1 });
    } catch {
      return [];
    }

    try {
      const redis = getRedisClient();
      await Promise.race([
        redis.set(`ep:dest:${endpointId}`, JSON.stringify(destinations), 'EX', 60),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 250)),
      ]);
    } catch {
      // Ignore cache write failures
    }

    return destinations;
  }

  async createDestination(
    endpointId: string,
    input: CreateDestinationInput,
  ): Promise<DestinationResponse> {
    const endpoint = await EndpointModel.findById(endpointId);
    if (!endpoint) {
      throw new AppError('Endpoint not found', 404, 'ENDPOINT_NOT_FOUND');
    }

    const currentCount = await DestinationModel.countDocuments({
      endpointId: endpoint._id,
    });
    if (currentCount >= 10) {
      throw new AppError(
        'Maximum limit of 10 destinations reached for this endpoint',
        400,
        'MAX_DESTINATIONS_REACHED',
      );
    }

    const isUrlSafe = await validateDestinationUrl(input.url);
    if (!isUrlSafe) {
      throw new AppError(
        'Destination URL must not point to private or internal network addresses',
        400,
        'SSRF_BLOCKED',
      );
    }

    const customHeaders = (input.customHeaders || []).map((h) => ({
      name: h.name,
      valueEncrypted: encryptSecret(h.value),
    }));

    let outboundSecretEncrypted: string | null = null;
    if (input.outboundSecret && input.outboundSecret.trim().length > 0) {
      outboundSecretEncrypted = encryptSecret(input.outboundSecret);
    }

    const doc = await DestinationModel.create({
      workspaceId: endpoint.workspaceId,
      endpointId: endpoint._id,
      name: input.name,
      url: input.url,
      customHeaders,
      isActive: input.isActive !== undefined ? input.isActive : true,
      retryPolicy: input.retryPolicy,
      rateLimitPerMin: input.rateLimitPerMin,
      filter: input.filter ?? null,
      outboundSecretEncrypted,
    });

    await invalidateDestinationCache(endpointId);

    return mapDestinationResponse(doc);
  }

  async listDestinations(endpointId: string): Promise<DestinationResponse[]> {
    const destinations = await DestinationModel.find({
      endpointId: new Types.ObjectId(endpointId),
    }).sort({ createdAt: 1 });

    return destinations.map(mapDestinationResponse);
  }

  async getDestination(id: string): Promise<DestinationResponse> {
    const doc = await DestinationModel.findById(id);
    if (!doc) {
      throw new AppError('Destination not found', 404, 'DESTINATION_NOT_FOUND');
    }
    return mapDestinationResponse(doc);
  }

  async updateDestination(id: string, input: UpdateDestinationInput): Promise<DestinationResponse> {
    const doc = await DestinationModel.findById(id);
    if (!doc) {
      throw new AppError('Destination not found', 404, 'DESTINATION_NOT_FOUND');
    }

    if (input.url && input.url !== doc.url) {
      const isUrlSafe = await validateDestinationUrl(input.url);
      if (!isUrlSafe) {
        throw new AppError(
          'Destination URL must not point to private or internal network addresses',
          400,
          'SSRF_BLOCKED',
        );
      }
      doc.url = input.url;
    }

    if (input.name !== undefined) {
      doc.name = input.name;
    }

    if (input.isActive !== undefined) {
      doc.isActive = input.isActive;
    }

    if (input.customHeaders !== undefined) {
      doc.customHeaders = input.customHeaders.map((h) => ({
        name: h.name,
        valueEncrypted: encryptSecret(h.value),
      }));
    }

    if (input.retryPolicy !== undefined) {
      doc.retryPolicy = input.retryPolicy;
    }

    if (input.rateLimitPerMin !== undefined) {
      doc.rateLimitPerMin = input.rateLimitPerMin;
    }

    if (input.filter !== undefined) {
      doc.filter = input.filter;
    }

    if (input.outboundSecret !== undefined) {
      if (input.outboundSecret && input.outboundSecret.trim().length > 0) {
        doc.outboundSecretEncrypted = encryptSecret(input.outboundSecret);
      }
    }

    await doc.save();
    await invalidateDestinationCache(doc.endpointId.toString());

    return mapDestinationResponse(doc);
  }

  async deleteDestination(id: string): Promise<{ success: boolean }> {
    const doc = await DestinationModel.findById(id);
    if (!doc) {
      throw new AppError('Destination not found', 404, 'DESTINATION_NOT_FOUND');
    }

    const endpointId = doc.endpointId.toString();

    // Cancel pending deliveries instead of leaving orphans
    const pendingDeliveries = await DeliveryModel.find({
      destinationId: doc._id,
      status: 'pending',
    });

    if (pendingDeliveries.length > 0) {
      await DeliveryModel.updateMany(
        { destinationId: doc._id, status: 'pending' },
        { $set: { status: 'cancelled' } },
      );

      // Recompute event statuses for all affected events
      const affectedEventIds = Array.from(
        new Set(pendingDeliveries.map((d) => d.eventId.toString())),
      );
      for (const eventId of affectedEventIds) {
        await recomputeEventStatus(eventId);
      }
    }

    await DestinationModel.findByIdAndDelete(doc._id);
    await invalidateDestinationCache(endpointId);

    return { success: true };
  }

  async testFilter(
    destinationId: string,
    payload: TestFilterInput,
    workspaceId?: string,
  ): Promise<{ matched: boolean; explanation: FilterExplanation }> {
    const doc = await DestinationModel.findById(destinationId);
    if (!doc) {
      throw new AppError('Destination not found', 404, 'DESTINATION_NOT_FOUND');
    }

    if (workspaceId && doc.workspaceId.toString() !== workspaceId) {
      throw new AppError('Destination not found', 404, 'DESTINATION_NOT_FOUND');
    }

    let filterInput: FilterInput;

    if (payload.eventId) {
      const eventFilter = Types.ObjectId.isValid(payload.eventId)
        ? { _id: new Types.ObjectId(payload.eventId), workspaceId: doc.workspaceId }
        : { _id: payload.eventId as any, workspaceId: doc.workspaceId };
      const event = await EventModel.findOne(eventFilter);
      if (!event) {
        throw new AppError('Event not found', 404, 'EVENT_NOT_FOUND');
      }

      let headersObj: Record<string, unknown> = {};
      if (event.headers instanceof Map) {
        headersObj = Object.fromEntries(event.headers);
      } else if (event.headers && typeof event.headers === 'object') {
        headersObj = event.headers as Record<string, unknown>;
      }

      filterInput = {
        body: event.rawBody,
        headers: headersObj,
        method: event.method,
        contentType: event.contentType,
      };
    } else if (payload.sample) {
      filterInput = {
        body: payload.sample.body,
        headers: payload.sample.headers,
        method: payload.sample.method || 'POST',
        contentType: payload.sample.contentType,
      };
    } else {
      throw new AppError('Either eventId or sample must be provided', 400, 'INVALID_INPUT');
    }

    const explanation = explainFilter(doc.filter, filterInput);
    return {
      matched: explanation.matched,
      explanation,
    };
  }

  async previewFilter(
    destinationId: string,
    workspaceId?: string,
  ): Promise<{ matchedCount: number; totalEvents: number }> {
    const doc = await DestinationModel.findById(destinationId);
    if (!doc) {
      throw new AppError('Destination not found', 404, 'DESTINATION_NOT_FOUND');
    }

    if (workspaceId && doc.workspaceId.toString() !== workspaceId) {
      throw new AppError('Destination not found', 404, 'DESTINATION_NOT_FOUND');
    }

    const events = await EventModel.find({
      endpointId: doc.endpointId,
      workspaceId: doc.workspaceId,
    })
      .sort({ receivedAt: -1 })
      .limit(100);

    let matchedCount = 0;
    for (const ev of events) {
      let headersObj: Record<string, unknown> = {};
      if (ev.headers instanceof Map) {
        headersObj = Object.fromEntries(ev.headers);
      } else if (ev.headers && typeof ev.headers === 'object') {
        headersObj = ev.headers as Record<string, unknown>;
      }

      const isMatched = evaluateFilter(doc.filter, {
        body: ev.rawBody,
        headers: headersObj,
        method: ev.method,
        contentType: ev.contentType,
      });

      if (isMatched) {
        matchedCount++;
      }
    }

    return {
      matchedCount,
      totalEvents: events.length,
    };
  }
}

export const destinationService = new DestinationService();
