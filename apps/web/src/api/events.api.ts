import { apiClient } from './client.js';
import type {
  EventFilterQuery,
  PaginatedEventsResponse,
  EventWithAttemptsResponse,
  BulkReplayInput,
  BulkReplayResponse,
  ReplayEventResponse,
} from '@hookpilot/shared';

export const eventsApi = {
  listEndpointEvents: async (
    endpointId: string,
    query: Partial<EventFilterQuery> = {},
  ): Promise<PaginatedEventsResponse> => {
    const res = await apiClient.get<PaginatedEventsResponse>(`/endpoints/${endpointId}/events`, {
      params: query,
    });
    return res.data;
  },

  getById: async (id: string): Promise<EventWithAttemptsResponse> => {
    const res = await apiClient.get<EventWithAttemptsResponse>(`/events/${id}`);
    return res.data;
  },

  replay: async (id: string): Promise<ReplayEventResponse> => {
    const res = await apiClient.post<ReplayEventResponse>(`/events/${id}/replay`);
    return res.data;
  },

  bulkReplay: async (input: BulkReplayInput): Promise<BulkReplayResponse> => {
    const res = await apiClient.post<BulkReplayResponse>('/events/bulk-replay', input);
    return res.data;
  },

  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/events/${id}`);
  },
};
