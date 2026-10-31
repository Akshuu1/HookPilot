import mongoose, { Schema, model, type Document, type Types, type Model } from 'mongoose';

export interface IDestinationCustomHeader {
  name: string;
  valueEncrypted: string;
}

export interface IDestination extends Document {
  workspaceId: Types.ObjectId;
  endpointId: Types.ObjectId;
  name: string;
  url: string;
  customHeaders: IDestinationCustomHeader[];
  isActive: boolean;
  retryPolicy?: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  rateLimitPerMin?: number | null;
  filter?: Record<string, unknown> | null;
  outboundSecretEncrypted?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const destinationSchema = new Schema<IDestination>(
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
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    customHeaders: [
      {
        name: { type: String, required: true },
        valueEncrypted: { type: String, required: true },
        _id: false,
      },
    ],
    isActive: {
      type: Boolean,
      default: true,
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
      default: null,
      min: 1,
      max: 1000000,
    },
    filter: {
      type: Schema.Types.Mixed,
      default: null,
    },
    outboundSecretEncrypted: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

destinationSchema.index({ endpointId: 1, isActive: 1 });

export const DestinationModel =
  (mongoose.models.Destination as Model<IDestination>) ||
  model<IDestination>('Destination', destinationSchema);
