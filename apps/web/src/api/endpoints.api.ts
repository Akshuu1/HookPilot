import { apiClient } from './client.js';
import type { CreateEndpointInput, UpdateEndpointInput, EndpointResponse } from '@hookpilot/shared';

export const endpointsApi = {
  listByWorkspace: async (workspaceId: string): Promise<{ endpoints: EndpointResponse[] }> => {
    const res = await apiClient.get<{ endpoints: EndpointResponse[] }>(
      `/workspaces/${workspaceId}/endpoints`,
    );
    return res.data;
  },

  getById: async (id: string): Promise<{ endpoint: EndpointResponse }> => {
    const res = await apiClient.get<{ endpoint: EndpointResponse }>(`/endpoints/${id}`);
    return res.data;
  },

  create: async (
    workspaceId: string,
    input: CreateEndpointInput,
  ): Promise<{ endpoint: EndpointResponse }> => {
    const res = await apiClient.post<{ endpoint: EndpointResponse }>(
      `/workspaces/${workspaceId}/endpoints`,
      input,
    );
    return res.data;
  },

  update: async (
    id: string,
    input: UpdateEndpointInput,
  ): Promise<{ endpoint: EndpointResponse }> => {
    const res = await apiClient.patch<{ endpoint: EndpointResponse }>(`/endpoints/${id}`, input);
    return res.data;
  },

  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/endpoints/${id}`);
  },

  rotateSecret: async (
    id: string,
    secret?: string,
  ): Promise<{ secret: string; secretMasked: string }> => {
    const res = await apiClient.post<{ secret: string; secretMasked: string }>(
      `/endpoints/${id}/rotate-secret`,
      secret ? { secret } : {},
    );
    return res.data;
  },
};
