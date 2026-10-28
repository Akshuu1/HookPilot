import { Types } from 'mongoose';
import type { EventStatus } from '@hookpilot/shared';
import { EventModel, type IEvent } from '../models/Event.js';

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
}

export interface PersistEventResult {
  event: IEvent;
  isDuplicate: boolean;
}

export interface EventRepository {
  create(data: CreateEventData): Promise<PersistEventResult>;
  findById(id: string): Promise<IEvent | null>;
  findByEndpoint(endpointId: string): Promise<IEvent[]>;
}

export class MongoEventRepository implements EventRepository {
  async create(data: CreateEventData): Promise<PersistEventResult> {
    try {
      const event = new EventModel({
        ...data,
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
    return EventModel.find({ endpointId: new Types.ObjectId(endpointId) }).sort({ receivedAt: -1 });
  }
}

export const eventRepository = new MongoEventRepository();
