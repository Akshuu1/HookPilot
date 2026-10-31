import { Schema, model, type Document, type Types } from 'mongoose';
import { WorkspaceRoles, type WorkspaceRole } from '@hookpilot/shared';

export interface IMembership extends Document {
  workspaceId: Types.ObjectId;
  userId: Types.ObjectId;
  role: WorkspaceRole;
  createdAt: Date;
  updatedAt: Date;
}

const membershipSchema = new Schema<IMembership>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: WorkspaceRoles,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

// Compound unique index ensuring a user has at most one membership per workspace
membershipSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });

export const MembershipModel = model<IMembership>('Membership', membershipSchema);
