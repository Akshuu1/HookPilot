import { Schema, model, type Document, type Types } from 'mongoose';
import {
  SignatureProviders,
  EndpointModes,
  type SignatureProvider,
  type EndpointMode,
} from '@hookpilot/shared';

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
      maxlength: 64,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      index: true,
      minlength: 12,
      maxlength: 16,
    },
    destinationUrl: {
      type: String,
      required: true,
      trim: true,
    },
    signatureConfig: {
      provider: {
        type: String,
        enum: SignatureProviders,
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
        min: 1,
        max: 20,
      },
      baseDelayMs: {
        type: Number,
        default: 1000,
        min: 100,
      },
      maxDelayMs: {
        type: Number,
        default: 3600000,
      },
    },
    rateLimitPerMin: {
      type: Number,
      default: 60,
      min: 1,
      max: 1000000,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    mode: {
      type: String,
      enum: EndpointModes,
      default: 'forward',
    },
  },
  {
    timestamps: true,
  },
);

export const EndpointModel = model<IEndpoint>('Endpoint', endpointSchema);
