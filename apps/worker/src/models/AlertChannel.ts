import mongoose, { Schema, Document, Model, model } from 'mongoose';
import type { AlertChannelType } from '@hookpilot/shared';

export interface IAlertChannel extends Document {
  workspaceId: mongoose.Types.ObjectId;
  type: AlertChannelType;
  name: string;
  configEncrypted: string;
  verifiedAt: Date | null;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const alertChannelSchema = new Schema<IAlertChannel>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['email', 'slack'],
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    configEncrypted: {
      type: String,
      required: true,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

alertChannelSchema.index({ workspaceId: 1, type: 1 });

export const AlertChannelModel =
  (mongoose.models.AlertChannel as Model<IAlertChannel>) ||
  model<IAlertChannel>('AlertChannel', alertChannelSchema);
