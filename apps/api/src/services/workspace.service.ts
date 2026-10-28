import type { WorkspaceRole, WorkspaceResponse } from '@hookpilot/shared';
import { AppError } from '../middlewares/error-handler.js';
import {
  type WorkspaceRepository,
  workspaceRepository as defaultWorkspaceRepo,
} from '../repositories/workspace.repository.js';
import {
  type MembershipRepository,
  membershipRepository as defaultMembershipRepo,
} from '../repositories/membership.repository.js';
import {
  type UserRepository,
  userRepository as defaultUserRepo,
} from '../repositories/user.repository.js';

export interface WorkspaceMemberInfo {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  createdAt: string;
}

export class WorkspaceService {
  constructor(
    private readonly workspaceRepo: WorkspaceRepository = defaultWorkspaceRepo,
    private readonly membershipRepo: MembershipRepository = defaultMembershipRepo,
    private readonly userRepo: UserRepository = defaultUserRepo,
  ) {}

  async createWorkspace(userId: string, name: string): Promise<WorkspaceResponse> {
    const workspace = await this.workspaceRepo.create({
      name,
      ownerId: userId,
    });

    await this.membershipRepo.create({
      workspaceId: workspace.id,
      userId,
      role: 'owner',
    });

    return {
      id: workspace.id,
      name: workspace.name,
      ownerId: workspace.ownerId.toString(),
      role: 'owner',
      createdAt: workspace.createdAt.toISOString(),
    };
  }

  async listUserWorkspaces(userId: string): Promise<WorkspaceResponse[]> {
    const memberships = await this.membershipRepo.findUserMemberships(userId);

    return memberships
      .filter((m) => Boolean(m.workspaceId))
      .map((m) => ({
        id: m.workspaceId.id,
        name: m.workspaceId.name,
        ownerId: m.workspaceId.ownerId.toString(),
        role: m.role,
        createdAt: m.workspaceId.createdAt.toISOString(),
      }));
  }

  async addMember(
    workspaceId: string,
    email: string,
    role: 'admin' | 'member' | 'viewer',
  ): Promise<WorkspaceMemberInfo> {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace) {
      throw new AppError('Workspace not found', 404, 'WORKSPACE_NOT_FOUND');
    }

    const targetUser = await this.userRepo.findByEmail(email);
    if (!targetUser) {
      throw new AppError('User with this email is not registered yet', 404, 'USER_NOT_REGISTERED');
    }

    const existingMembership = await this.membershipRepo.findByWorkspaceAndUser(
      workspaceId,
      targetUser.id,
    );
    if (existingMembership) {
      throw new AppError('User is already a member of this workspace', 409, 'ALREADY_MEMBER');
    }

    const membership = await this.membershipRepo.create({
      workspaceId,
      userId: targetUser.id,
      role,
    });

    return {
      id: membership.id,
      userId: targetUser.id,
      name: targetUser.name,
      email: targetUser.email,
      role: membership.role,
      createdAt: membership.createdAt.toISOString(),
    };
  }

  async changeMemberRole(
    workspaceId: string,
    _actorUserId: string,
    targetUserId: string,
    newRole: 'admin' | 'member' | 'viewer',
  ): Promise<WorkspaceMemberInfo> {
    const membership = await this.membershipRepo.findByWorkspaceAndUser(workspaceId, targetUserId);
    if (!membership) {
      throw new AppError('Membership not found in workspace', 404, 'MEMBERSHIP_NOT_FOUND');
    }

    if (membership.role === 'owner') {
      throw new AppError('Cannot modify role of workspace owner', 403, 'CANNOT_MODIFY_OWNER');
    }

    const updated = await this.membershipRepo.updateRole(workspaceId, targetUserId, newRole);
    if (!updated) {
      throw new AppError('Failed to update membership', 500, 'UPDATE_FAILED');
    }

    const user = await this.userRepo.findById(targetUserId);

    return {
      id: updated.id,
      userId: targetUserId,
      name: user?.name || 'Unknown',
      email: user?.email || 'Unknown',
      role: updated.role,
      createdAt: updated.createdAt.toISOString(),
    };
  }

  async removeMember(
    workspaceId: string,
    _actorUserId: string,
    targetUserId: string,
  ): Promise<void> {
    const membership = await this.membershipRepo.findByWorkspaceAndUser(workspaceId, targetUserId);
    if (!membership) {
      throw new AppError('Membership not found in workspace', 404, 'MEMBERSHIP_NOT_FOUND');
    }

    if (membership.role === 'owner') {
      throw new AppError('Cannot remove the workspace owner', 403, 'CANNOT_REMOVE_OWNER');
    }

    await this.membershipRepo.delete(workspaceId, targetUserId);
  }
}

export const workspaceService = new WorkspaceService();
