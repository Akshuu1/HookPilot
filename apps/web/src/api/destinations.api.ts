import { apiClient } from './client.js';
import type {
  DestinationResponse,
  CreateDestinationInput,
  UpdateDestinationInput,
  TestFilterInput,
  FilterExplanation,
} from '@hookpilot/shared';

export const destinationsApi = {
  listByEndpoint: async (endpointId: string): Promise<{ data: DestinationResponse[] }> => {
    const res = await apiClient.get<{ data: DestinationResponse[] }>(
      `/endpoints/${endpointId}/destinations`,
    );
    return res.data;
  },

  getById: async (id: string): Promise<DestinationResponse> => {
    const res = await apiClient.get<DestinationResponse>(`/destinations/${id}`);
    return res.data;
  },

  create: async (
    endpointId: string,
    input: CreateDestinationInput,
  ): Promise<DestinationResponse> => {
    const res = await apiClient.post<DestinationResponse>(
      `/endpoints/${endpointId}/destinations`,
      input,
    );
    return res.data;
  },

  update: async (id: string, input: UpdateDestinationInput): Promise<DestinationResponse> => {
    const res = await apiClient.patch<DestinationResponse>(`/destinations/${id}`, input);
    return res.data;
  },

  delete: async (id: string): Promise<{ success: boolean; message?: string }> => {
    const res = await apiClient.delete<{ success: boolean; message?: string }>(
      `/destinations/${id}`,
    );
    return res.data;
  },

  testFilter: async (
    id: string,
    input: TestFilterInput,
  ): Promise<{ matched: boolean; explanation: FilterExplanation }> => {
    const res = await apiClient.post<{ matched: boolean; explanation: FilterExplanation }>(
      `/destinations/${id}/test-filter`,
      input,
    );
    return res.data;
  },

  previewFilter: async (id: string): Promise<{ matchedCount: number; totalEvents: number }> => {
    const res = await apiClient.post<{ matchedCount: number; totalEvents: number }>(
      `/destinations/${id}/filter-preview`,
      {},
    );
    return res.data;
  },
};
