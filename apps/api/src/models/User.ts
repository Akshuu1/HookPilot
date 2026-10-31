import { Schema, model, type Document } from 'mongoose';

export interface IUser extends Document {
  email: string;
  passwordHash?: string | null;
  name: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: {
      type: String,
      required: false,
      default: null,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    displayName: {
      type: String,
      default: null,
      trim: true,
    },
    avatarUrl: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

export const UserModel = model<IUser>('User', userSchema);
