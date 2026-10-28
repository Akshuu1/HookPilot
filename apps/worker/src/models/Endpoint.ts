import { Schema, model, type Document, type Types } from 'mongoose';
import type { SignatureProvider, EndpointMode } from '@hookpilot/shared';

export interface IEndpoint extends Document {
  workspaceId: Types.ObjectId;
  name: string;
  slug: string;
  destinationUrl: string;
  signatureConfig: {
    provider: SignatureProvider;
    secretEncrypted?: string | null;
    headerName?: string | null;
    enforce?: boolean;
  };
  retryPolicy: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  rateLimitPerMin: number;
  isActive: boolean;
  mode: EndpointMode;
  createdAt: Date;
  updatedAt: Date;
}

const endpointSchema = new Schema<IEndpoint>(
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
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 8,
      maxlength: 16,
      index: true,
    },
    destinationUrl: {
      type: String,
      required: true,
      trim: true,
    },
    signatureConfig: {
      provider: {
        type: String,
        enum: ['none', 'stripe', 'github', 'generic'],
        default: 'none',
      },
      secretEncrypted: {
        type: String,
        default: null,
      },
      headerName: {
        type: String,
        default: null,
      },
      enforce: {
        type: Boolean,
        default: false,
      },
    },
    retryPolicy: {
      maxAttempts: {
        type: Number,
        default: 8,
      },
      baseDelayMs: {
        type: Number,
        default: 1000,
      },
      maxDelayMs: {
        type: Number,
        default: 3600000,
      },
    },
    rateLimitPerMin: {
      type: Number,
      default: 60,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    mode: {
      type: String,
      enum: ['forward', 'capture-only'],
      default: 'forward',
    },
  },
  {
    timestamps: true,
  },
);

export const EndpointModel = model<IEndpoint>('Endpoint', endpointSchema);
