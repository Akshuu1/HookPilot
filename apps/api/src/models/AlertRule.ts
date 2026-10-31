import mongoose, { Schema, Document, Model, model } from 'mongoose';
import type { AlertRuleCondition, AlertRuleScope } from '@hookpilot/shared';

export interface IAlertRule extends Document {
  workspaceId: mongoose.Types.ObjectId;
  name: string;
  enabled: boolean;
  scope: AlertRuleScope;
  condition: AlertRuleCondition;
  channelIds: mongoose.Types.ObjectId[];
  cooldownMinutes: number;
  notifyOnResolve: boolean;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const alertRuleSchema = new Schema<IAlertRule>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    enabled: {
      type: Boolean,
      default: true,
      index: true,
    },
    scope: {
      type: {
        type: String,
        enum: ['workspace', 'endpoint', 'destination'],
        required: true,
      },
      id: {
        type: String,
        default: null,
      },
    },
    condition: {
      type: Schema.Types.Mixed,
      required: true,
    },
    channelIds: [
      {
        type: Schema.Types.ObjectId,
        ref: 'AlertChannel',
      },
    ],
    cooldownMinutes: {
      type: Number,
      default: 30,
      min: 1,
      max: 1440,
    },
    notifyOnResolve: {
      type: Boolean,
      default: true,
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

alertRuleSchema.index({ workspaceId: 1, enabled: 1 });
alertRuleSchema.index({ 'scope.type': 1, 'scope.id': 1 });

export const AlertRuleModel =
  (mongoose.models.AlertRule as Model<IAlertRule>) ||
  model<IAlertRule>('AlertRule', alertRuleSchema);
