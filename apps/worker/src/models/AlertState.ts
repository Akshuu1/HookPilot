import mongoose, { Schema, Document, Model, model } from 'mongoose';
import type { AlertStateStatus } from '@hookpilot/shared';

export interface IAlertState extends Document {
  ruleId: mongoose.Types.ObjectId;
  status: AlertStateStatus;
  consecutiveClear: number;
  lastValue: number | null;
  lastFiredAt: Date | null;
  lastNotifiedAt: Date | null;
  lastResolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const alertStateSchema = new Schema<IAlertState>(
  {
    ruleId: {
      type: Schema.Types.ObjectId,
      ref: 'AlertRule',
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['ok', 'firing'],
      default: 'ok',
      required: true,
    },
    consecutiveClear: {
      type: Number,
      default: 0,
    },
    lastValue: {
      type: Number,
      default: null,
    },
    lastFiredAt: {
      type: Date,
      default: null,
    },
    lastNotifiedAt: {
      type: Date,
      default: null,
    },
    lastResolvedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

export const AlertStateModel =
  (mongoose.models.AlertState as Model<IAlertState>) ||
  model<IAlertState>('AlertState', alertStateSchema);
