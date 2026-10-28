import { apiClient } from './client.js';
import type { CreateWorkspaceInput, WorkspaceResponse, WorkspaceRole } from '@hookpilot/shared';

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: {
    _id?: string;
    id?: string;
    email: string;
    name: string;
  };
  role: WorkspaceRole;
  createdAt: string;
}

export const workspacesApi = {
  listMine: async (): Promise<{ workspaces: WorkspaceResponse[] }> => {
    const res = await apiClient.get<{ workspaces: WorkspaceResponse[] }>('/workspaces');
    return res.data;
  },

  create: async (input: CreateWorkspaceInput): Promise<{ workspace: WorkspaceResponse }> => {
    const res = await apiClient.post<{ workspace: WorkspaceResponse }>('/workspaces', input);
    return res.data;
  },

  getById: async (
    workspaceId: string,
  ): Promise<{ workspace: WorkspaceResponse; role: WorkspaceRole }> => {
    const res = await apiClient.get<{ workspace: WorkspaceResponse; role: WorkspaceRole }>(
      `/workspaces/${workspaceId}`,
    );
    return res.data;
  },

  update: async (
    workspaceId: string,
    data: { name?: string; retentionDays?: number },
  ): Promise<{ workspace: WorkspaceResponse }> => {
    const res = await apiClient.patch<{ workspace: WorkspaceResponse }>(
      `/workspaces/${workspaceId}`,
      data,
    );
    return res.data;
  },

  listMembers: async (workspaceId: string): Promise<{ members: WorkspaceMember[] }> => {
    const res = await apiClient.get<{ members: WorkspaceMember[] }>(
      `/workspaces/${workspaceId}/members`,
    );
    return res.data;
  },

  addMember: async (
    workspaceId: string,
    data: { email: string; role: WorkspaceRole },
  ): Promise<void> => {
    await apiClient.post(`/workspaces/${workspaceId}/members`, data);
  },

  changeRole: async (workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> => {
    await apiClient.patch(`/workspaces/${workspaceId}/members/${userId}`, { role });
  },

  removeMember: async (workspaceId: string, userId: string): Promise<void> => {
    await apiClient.delete(`/workspaces/${workspaceId}/members/${userId}`);
  },
};
