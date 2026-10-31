import mongoose, { Schema, model, type Document, type Types, type Model } from 'mongoose';

export interface IDeliveryAttempt extends Document {
  eventId: Types.ObjectId;
  deliveryId?: Types.ObjectId | null;
  destinationId?: Types.ObjectId | null;
  attemptNumber: number;
  startedAt: Date;
  durationMs: number;
  requestHeaders: Record<string, string>;
  responseStatus: number;
  responseBodySnippet: string;
  error?: string | null;
  success: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const deliveryAttemptSchema = new Schema<IDeliveryAttempt>(
  {
    eventId: {
      type: Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
      index: true,
    },
    deliveryId: {
      type: Schema.Types.ObjectId,
      ref: 'Delivery',
      default: null,
    },
    destinationId: {
      type: Schema.Types.ObjectId,
      ref: 'Destination',
      default: null,
    },
    attemptNumber: {
      type: Number,
      required: true,
    },
    startedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    durationMs: {
      type: Number,
      required: true,
      min: 0,
    },
    requestHeaders: {
      type: Map,
      of: String,
      default: {},
    },
    responseStatus: {
      type: Number,
      required: true,
    },
    responseBodySnippet: {
      type: String,
      default: '',
      maxlength: 2048,
    },
    error: {
      type: String,
      default: null,
    },
    success: {
      type: Boolean,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

deliveryAttemptSchema.index({ eventId: 1, attemptNumber: 1 });
deliveryAttemptSchema.index({ deliveryId: 1 });
deliveryAttemptSchema.index({ destinationId: 1 });
deliveryAttemptSchema.index({ startedAt: -1 });

export const DeliveryAttemptModel =
  (mongoose.models.DeliveryAttempt as Model<IDeliveryAttempt>) ||
  model<IDeliveryAttempt>('DeliveryAttempt', deliveryAttemptSchema);
