import mongoose, { Schema, Document, Model, model } from 'mongoose';
import type { OAuthProvider } from '@hookpilot/shared';

export interface IIdentity extends Document {
  userId: mongoose.Types.ObjectId;
  provider: OAuthProvider;
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  avatarUrl: string | null;
  createdAt: Date;
  lastLoginAt: Date;
  updatedAt: Date;
}

const identitySchema = new Schema<IIdentity>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: ['github', 'google'],
      required: true,
    },
    providerUserId: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    emailVerified: {
      type: Boolean,
      required: true,
      default: false,
    },
    avatarUrl: {
      type: String,
      default: null,
    },
    lastLoginAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

identitySchema.index({ provider: 1, providerUserId: 1 }, { unique: true });

export const IdentityModel =
  (mongoose.models.Identity as Model<IIdentity>) || model<IIdentity>('Identity', identitySchema);
