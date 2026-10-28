import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceService } from '../workspace.service.js';
import type { WorkspaceRepository } from '../../repositories/workspace.repository.js';
import type { MembershipRepository } from '../../repositories/membership.repository.js';
import type { UserRepository } from '../../repositories/user.repository.js';
import type { IWorkspace } from '../../models/Workspace.js';
import type { IMembership } from '../../models/Membership.js';
import type { IUser } from '../../models/User.js';

describe('WorkspaceService Unit Tests', () => {
  let mockWorkspaceRepo: WorkspaceRepository;
  let mockMembershipRepo: MembershipRepository;
  let mockUserRepo: UserRepository;
  let service: WorkspaceService;

  beforeEach(() => {
    mockWorkspaceRepo = {
      create: vi.fn(),
      findById: vi.fn(),
    };
    mockMembershipRepo = {
      create: vi.fn(),
      findByWorkspaceAndUser: vi.fn(),
      findUserMemberships: vi.fn(),
      findWorkspaceMemberships: vi.fn(),
      updateRole: vi.fn(),
      delete: vi.fn(),
    };
    mockUserRepo = {
      findByEmail: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
    };

    service = new WorkspaceService(mockWorkspaceRepo, mockMembershipRepo, mockUserRepo);
  });

  describe('createWorkspace', () => {
    it('creates workspace and automatically grants owner role', async () => {
      vi.mocked(mockWorkspaceRepo.create).mockResolvedValue({
        id: 'ws-1',
        name: 'My Workspace',
        ownerId: 'u-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as IWorkspace);

      vi.mocked(mockMembershipRepo.create).mockResolvedValue({
        id: 'mem-1',
        role: 'owner',
      } as unknown as IMembership);

      const res = await service.createWorkspace('u-1', 'My Workspace');

      expect(res.name).toBe('My Workspace');
      expect(res.role).toBe('owner');
      expect(mockMembershipRepo.create).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        userId: 'u-1',
        role: 'owner',
      });
    });
  });

  describe('changeMemberRole', () => {
    it('blocks changing the owner role with 403', async () => {
      vi.mocked(mockMembershipRepo.findByWorkspaceAndUser).mockResolvedValue({
        id: 'mem-1',
        role: 'owner',
      } as unknown as IMembership);

      await expect(
        service.changeMemberRole('ws-1', 'actor-1', 'owner-id', 'admin'),
      ).rejects.toThrow('Cannot modify role of workspace owner');
    });

    it('updates non-owner role successfully', async () => {
      vi.mocked(mockMembershipRepo.findByWorkspaceAndUser).mockResolvedValue({
        id: 'mem-1',
        role: 'viewer',
      } as unknown as IMembership);

      vi.mocked(mockMembershipRepo.updateRole).mockResolvedValue({
        id: 'mem-1',
        role: 'admin',
        createdAt: new Date(),
      } as unknown as IMembership);

      vi.mocked(mockUserRepo.findById).mockResolvedValue({
        name: 'User',
        email: 'user@example.com',
      } as unknown as IUser);

      const res = await service.changeMemberRole('ws-1', 'actor-1', 'target-id', 'admin');
      expect(res.role).toBe('admin');
    });
  });

  describe('removeMember', () => {
    it('blocks removing the owner with 403', async () => {
      vi.mocked(mockMembershipRepo.findByWorkspaceAndUser).mockResolvedValue({
        id: 'mem-1',
        role: 'owner',
      } as unknown as IMembership);

      await expect(service.removeMember('ws-1', 'actor-1', 'owner-id')).rejects.toThrow(
        'Cannot remove the workspace owner',
      );
    });
  });
});
