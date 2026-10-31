import { Schema, model, type Document, type Types } from 'mongoose';
import { EventStatuses, type EventStatus } from '@hookpilot/shared';

export interface IEvent extends Document {
  workspaceId: Types.ObjectId;
  endpointId: Types.ObjectId;
  receivedAt: Date;
  method: string;
  headers: Record<string, string>;
  rawBody: string;
  bodySize: number;
  contentType?: string | null;
  sourceIp: string;
  signatureValid: boolean;
  idempotencyKey: string;
  status: EventStatus;
  attemptCount: number;
  replayCount: number;
  searchIndex: string;
  lastAttemptAt?: Date | null;
  nextAttemptAt?: Date | null;
  expiresAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const eventSchema = new Schema<IEvent>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    endpointId: {
      type: Schema.Types.ObjectId,
      ref: 'Endpoint',
      required: true,
      index: true,
    },
    receivedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    method: {
      type: String,
      required: true,
      uppercase: true,
    },
    headers: {
      type: Map,
      of: String,
      required: true,
    },
    rawBody: {
      type: String,
      required: true,
    },
    bodySize: {
      type: Number,
      required: true,
      min: 0,
    },
    contentType: {
      type: String,
      default: null,
    },
    sourceIp: {
      type: String,
      required: true,
    },
    signatureValid: {
      type: Boolean,
      required: true,
      default: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: EventStatuses,
      default: 'pending',
      index: true,
    },
    attemptCount: {
      type: Number,
      default: 0,
    },
    replayCount: {
      type: Number,
      default: 0,
    },
    searchIndex: {
      type: String,
      default: '',
    },
    lastAttemptAt: {
      type: Date,
      default: null,
    },
    nextAttemptAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Indexes defined in specification:
eventSchema.index({ endpointId: 1, receivedAt: 1 });
eventSchema.index({ endpointId: 1, receivedAt: -1, _id: -1 });
eventSchema.index({ workspaceId: 1, status: 1, receivedAt: -1 });
eventSchema.index({ endpointId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
eventSchema.index({ searchIndex: 'text', rawBody: 'text' });
eventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EventModel = model<IEvent>('Event', eventSchema);
