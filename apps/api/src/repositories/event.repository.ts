import { Types, type FilterQuery } from 'mongoose';
import { encodeCursor, type CursorData, type EventStatus } from '@hookpilot/shared';
import { EventModel, type IEvent } from '../models/Event.js';
import { DeliveryAttemptModel, type IDeliveryAttempt } from '../models/DeliveryAttempt.js';

export interface CreateEventData {
  workspaceId: string;
  endpointId: string;
  method: string;
  headers: Record<string, string>;
  rawBody: string;
  bodySize: number;
  contentType?: string | null;
  sourceIp: string;
  signatureValid: boolean;
  idempotencyKey: string;
  status?: EventStatus;
  retentionDays?: number;
}

export interface PersistEventResult {
  event: IEvent;
  isDuplicate: boolean;
}

export interface FindEndpointEventsParams {
  endpointId: string;
  status?: EventStatus | undefined;
  q?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  signatureValid?: boolean | undefined;
  limit?: number | undefined;
  cursor?: CursorData | null | undefined;
}

export interface PaginatedEventsResult {
  events: IEvent[];
  nextCursor: string | null;
  hasNextPage: boolean;
}

export interface BulkReplayFilterParams {
  workspaceId: string;
  endpointId?: string | undefined;
  status?: 'failed' | 'dead' | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  limit?: number | undefined;
}

export interface EventRepository {
  create(data: CreateEventData): Promise<PersistEventResult>;
  findById(id: string): Promise<IEvent | null>;
  findByEndpoint(endpointId: string): Promise<IEvent[]>;
  findEndpointEvents(params: FindEndpointEventsParams): Promise<PaginatedEventsResult>;
  findByIdWithAttempts(
    eventId: string,
  ): Promise<{ event: IEvent; attempts: IDeliveryAttempt[] } | null>;
  replay(eventId: string): Promise<IEvent | null>;
  findEventsForBulkReplay(filter: BulkReplayFilterParams): Promise<IEvent[]>;
  delete(eventId: string): Promise<boolean>;
}

export class MongoEventRepository implements EventRepository {
  async create(data: CreateEventData): Promise<PersistEventResult> {
    try {
      // Build flattened tokenized searchIndex from headers and raw body
      const headerTokens = Object.entries(data.headers || {})
        .map(([k, v]) => `${k} ${v}`)
        .join(' ');
      const searchIndex = `${headerTokens} ${data.rawBody || ''}`.trim();

      // Configurable retention expiration date (default 30 days)
      const retentionDays = data.retentionDays || 30;
      const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);

      const event = new EventModel({
        ...data,
        searchIndex,
        expiresAt,
        workspaceId: new Types.ObjectId(data.workspaceId),
        endpointId: new Types.ObjectId(data.endpointId),
      });

      const saved = await event.save();
      return { event: saved, isDuplicate: false };
    } catch (err: unknown) {
      const mongoErr = err as { code?: number; name?: string };
      // Handle MongoDB unique index violation on { endpointId, idempotencyKey }
      if (mongoErr.code === 11000) {
        const existing = await EventModel.findOne({
          endpointId: new Types.ObjectId(data.endpointId),
          idempotencyKey: data.idempotencyKey,
        });

        if (existing) {
          return { event: existing, isDuplicate: true };
        }
      }
      throw err;
    }
  }

  async findById(id: string): Promise<IEvent | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return EventModel.findById(id);
  }

  async findByEndpoint(endpointId: string): Promise<IEvent[]> {
    if (!Types.ObjectId.isValid(endpointId)) return [];
    return EventModel.find({ endpointId: new Types.ObjectId(endpointId) }).sort({
      receivedAt: -1,
    });
  }

  async findEndpointEvents(params: FindEndpointEventsParams): Promise<PaginatedEventsResult> {
    if (!Types.ObjectId.isValid(params.endpointId)) {
      return { events: [], nextCursor: null, hasNextPage: false };
    }

    const limit = Math.min(Math.max(params.limit || 20, 1), 100);
    const conditions: FilterQuery<IEvent>[] = [
      { endpointId: new Types.ObjectId(params.endpointId) },
    ];

    if (params.status) {
      conditions.push({ status: params.status });
    }

    if (params.signatureValid !== undefined) {
      conditions.push({ signatureValid: params.signatureValid });
    }

    if (params.from || params.to) {
      const dateCond: Record<string, Date> = {};
      if (params.from) dateCond.$gte = params.from;
      if (params.to) dateCond.$lte = params.to;
      conditions.push({ receivedAt: dateCond });
    }

    if (params.q && params.q.trim()) {
      const term = params.q.trim();
      conditions.push({
        $or: [
          { searchIndex: { $regex: term, $options: 'i' } },
          { rawBody: { $regex: term, $options: 'i' } },
        ],
      });
    }

    if (params.cursor && Types.ObjectId.isValid(params.cursor.id)) {
      conditions.push({
        $or: [
          { receivedAt: { $lt: params.cursor.receivedAt } },
          {
            receivedAt: params.cursor.receivedAt,
            _id: { $lt: new Types.ObjectId(params.cursor.id) },
          },
        ],
      });
    }

    const query: FilterQuery<IEvent> =
      conditions.length === 1 ? conditions[0]! : { $and: conditions };

    // Fetch limit + 1 to check if there is a next page
    const docs = await EventModel.find(query)
      .sort({ receivedAt: -1, _id: -1 })
      .limit(limit + 1);

    const hasNextPage = docs.length > limit;
    const events = hasNextPage ? docs.slice(0, limit) : docs;

    let nextCursor: string | null = null;
    if (hasNextPage && events.length > 0) {
      const lastDoc = events[events.length - 1]!;
      nextCursor = encodeCursor(lastDoc.receivedAt, lastDoc._id.toString());
    }

    return { events, nextCursor, hasNextPage };
  }

  async findByIdWithAttempts(
    eventId: string,
  ): Promise<{ event: IEvent; attempts: IDeliveryAttempt[] } | null> {
    if (!Types.ObjectId.isValid(eventId)) return null;

    const event = await EventModel.findById(eventId);
    if (!event) return null;

    const attempts = await DeliveryAttemptModel.find({
      eventId: new Types.ObjectId(eventId),
    }).sort({ attemptNumber: 1 });

    return { event, attempts };
  }

  async replay(eventId: string): Promise<IEvent | null> {
    if (!Types.ObjectId.isValid(eventId)) return null;

    return EventModel.findByIdAndUpdate(
      eventId,
      {
        $inc: { replayCount: 1 },
        $set: {
          status: 'pending',
          nextAttemptAt: null,
        },
      },
      { new: true },
    );
  }

  async findEventsForBulkReplay(filter: BulkReplayFilterParams): Promise<IEvent[]> {
    if (!Types.ObjectId.isValid(filter.workspaceId)) return [];

    const conditions: FilterQuery<IEvent>[] = [
      { workspaceId: new Types.ObjectId(filter.workspaceId) },
    ];

    if (filter.endpointId && Types.ObjectId.isValid(filter.endpointId)) {
      conditions.push({ endpointId: new Types.ObjectId(filter.endpointId) });
    }

    if (filter.status) {
      conditions.push({ status: filter.status });
    } else {
      conditions.push({ status: { $in: ['failed', 'dead'] } });
    }

    if (filter.from || filter.to) {
      const dateCond: Record<string, Date> = {};
      if (filter.from) dateCond.$gte = filter.from;
      if (filter.to) dateCond.$lte = filter.to;
      conditions.push({ receivedAt: dateCond });
    }

    const query: FilterQuery<IEvent> =
      conditions.length === 1 ? conditions[0]! : { $and: conditions };
    const limit = Math.min(filter.limit || 500, 500);

    return EventModel.find(query).sort({ receivedAt: -1 }).limit(limit);
  }

  async delete(eventId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(eventId)) return false;

    const deleted = await EventModel.findByIdAndDelete(eventId);
    if (!deleted) return false;

    // Delete associated attempts
    await DeliveryAttemptModel.deleteMany({ eventId: new Types.ObjectId(eventId) });
    return true;
  }
}

export const eventRepository = new MongoEventRepository();
