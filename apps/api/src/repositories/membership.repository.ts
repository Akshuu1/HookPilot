import { Types } from 'mongoose';
import type { WorkspaceRole } from '@hookpilot/shared';
import { MembershipModel, type IMembership } from '../models/Membership.js';
import type { IWorkspace } from '../models/Workspace.js';
import type { IUser } from '../models/User.js';

export interface PopulatedWorkspaceMembership extends Omit<IMembership, 'workspaceId'> {
  workspaceId: IWorkspace;
}

export interface PopulatedUserMembership extends Omit<IMembership, 'userId'> {
  userId: IUser;
}

export interface MembershipRepository {
  create(data: { workspaceId: string; userId: string; role: WorkspaceRole }): Promise<IMembership>;
  findByWorkspaceAndUser(workspaceId: string, userId: string): Promise<IMembership | null>;
  findUserMemberships(userId: string): Promise<PopulatedWorkspaceMembership[]>;
  findWorkspaceMemberships(workspaceId: string): Promise<PopulatedUserMembership[]>;
  updateRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<IMembership | null>;
  delete(workspaceId: string, userId: string): Promise<boolean>;
}

export class MongoMembershipRepository implements MembershipRepository {
  async create(data: {
    workspaceId: string;
    userId: string;
    role: WorkspaceRole;
  }): Promise<IMembership> {
    const membership = new MembershipModel({
      workspaceId: new Types.ObjectId(data.workspaceId),
      userId: new Types.ObjectId(data.userId),
      role: data.role,
    });
    return membership.save();
  }

  async findByWorkspaceAndUser(workspaceId: string, userId: string): Promise<IMembership | null> {
    if (!Types.ObjectId.isValid(workspaceId) || !Types.ObjectId.isValid(userId)) {
      return null;
    }
    return MembershipModel.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      userId: new Types.ObjectId(userId),
    });
  }

  async findUserMemberships(userId: string): Promise<PopulatedWorkspaceMembership[]> {
    if (!Types.ObjectId.isValid(userId)) return [];
    return MembershipModel.find({ userId: new Types.ObjectId(userId) })
      .populate<{ workspaceId: IWorkspace }>('workspaceId')
      .exec() as Promise<PopulatedWorkspaceMembership[]>;
  }

  async findWorkspaceMemberships(workspaceId: string): Promise<PopulatedUserMembership[]> {
    if (!Types.ObjectId.isValid(workspaceId)) return [];
    return MembershipModel.find({ workspaceId: new Types.ObjectId(workspaceId) })
      .populate<{ userId: IUser }>('userId', 'name email createdAt')
      .exec() as Promise<PopulatedUserMembership[]>;
  }

  async updateRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ): Promise<IMembership | null> {
    if (!Types.ObjectId.isValid(workspaceId) || !Types.ObjectId.isValid(userId)) {
      return null;
    }
    return MembershipModel.findOneAndUpdate(
      {
        workspaceId: new Types.ObjectId(workspaceId),
        userId: new Types.ObjectId(userId),
      },
      { $set: { role } },
      { new: true },
    );
  }

  async delete(workspaceId: string, userId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(workspaceId) || !Types.ObjectId.isValid(userId)) {
      return false;
    }
    const result = await MembershipModel.deleteOne({
      workspaceId: new Types.ObjectId(workspaceId),
      userId: new Types.ObjectId(userId),
    });
    return result.deletedCount > 0;
  }
}

export const membershipRepository = new MongoMembershipRepository();
