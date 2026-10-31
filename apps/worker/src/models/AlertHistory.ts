import mongoose, { Schema, Document, Model, model } from 'mongoose';
import type { AlertNotificationKind, AlertNotificationStatus } from '@hookpilot/shared';

export interface IAlertHistoryNotification {
  channelId: mongoose.Types.ObjectId;
  kind: AlertNotificationKind;
  status: AlertNotificationStatus;
  error?: string | null;
  sentAt: Date;
}

export interface IAlertHistory extends Document {
  workspaceId: mongoose.Types.ObjectId;
  ruleId: mongoose.Types.ObjectId;
  firedAt: Date;
  resolvedAt: Date | null;
  value: number;
  summary: string;
  notifications: IAlertHistoryNotification[];
  createdAt: Date;
  updatedAt: Date;
}

const alertHistorySchema = new Schema<IAlertHistory>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    ruleId: {
      type: Schema.Types.ObjectId,
      ref: 'AlertRule',
      required: true,
      index: true,
    },
    firedAt: {
      type: Date,
      required: true,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    value: {
      type: Number,
      required: true,
    },
    summary: {
      type: String,
      required: true,
    },
    notifications: [
      {
        channelId: {
          type: Schema.Types.ObjectId,
          ref: 'AlertChannel',
          required: true,
        },
        kind: {
          type: String,
          enum: ['firing', 'resolved', 'summary', 'test'],
          required: true,
        },
        status: {
          type: String,
          enum: ['sent', 'failed'],
          required: true,
        },
        error: {
          type: String,
          default: null,
        },
        sentAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  {
    timestamps: true,
  },
);

alertHistorySchema.index({ ruleId: 1, firedAt: -1 });
alertHistorySchema.index({ workspaceId: 1, firedAt: -1 });

export const AlertHistoryModel =
  (mongoose.models.AlertHistory as Model<IAlertHistory>) ||
  model<IAlertHistory>('AlertHistory', alertHistorySchema);
