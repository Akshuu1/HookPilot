import mongoose, { Schema, model, type Document, type Types, type Model } from 'mongoose';
import { DeliveryStatuses, type DeliveryStatus } from '@hookpilot/shared';

export interface IDelivery extends Document {
  workspaceId: Types.ObjectId;
  eventId: Types.ObjectId;
  destinationId: Types.ObjectId;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt?: Date | null;
  lastError?: string | null;
  filterReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const deliverySchema = new Schema<IDelivery>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    eventId: {
      type: Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
      index: true,
    },
    destinationId: {
      type: Schema.Types.ObjectId,
      ref: 'Destination',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: DeliveryStatuses,
      default: 'pending',
      index: true,
    },
    attemptCount: {
      type: Number,
      default: 0,
    },
    nextAttemptAt: {
      type: Date,
      default: null,
      index: true,
    },
    lastError: {
      type: String,
      default: null,
    },
    filterReason: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

deliverySchema.index({ eventId: 1, destinationId: 1 }, { unique: true });
deliverySchema.index({ status: 1, createdAt: 1 });
deliverySchema.index({ workspaceId: 1, status: 1, updatedAt: 1 });

export const DeliveryModel =
  (mongoose.models.Delivery as Model<IDelivery>) || model<IDelivery>('Delivery', deliverySchema);
