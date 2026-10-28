import { Schema, model, type Document, type Types } from 'mongoose';

export interface IApiKey extends Document {
  workspaceId: Types.ObjectId;
  name: string;
  prefix: string;
  keyHash: string;
  createdBy: Types.ObjectId;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const apiKeySchema = new Schema<IApiKey>(
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
      maxlength: 64,
    },
    prefix: {
      type: String,
      required: true,
      trim: true,
    },
    keyHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
    revokedAt: {
      type: Date,
      default: null,
      index: true,
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

apiKeySchema.index({ workspaceId: 1, revokedAt: 1 });

export const ApiKeyModel = model<IApiKey>('ApiKey', apiKeySchema);
