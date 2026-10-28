import { apiClient } from './client.js';
import type { AnalyticsResponse, AnalyticsRange } from '@hookpilot/shared';

export const analyticsApi = {
  getAnalytics: async (
    workspaceId: string,
    range: AnalyticsRange = '24h',
    endpointId?: string,
  ): Promise<AnalyticsResponse> => {
    const params = new URLSearchParams({ range });
    if (endpointId) params.append('endpointId', endpointId);

    const res = await apiClient.get<AnalyticsResponse>(
      `/workspaces/${workspaceId}/analytics?${params.toString()}`,
    );
    return res.data;
  },
};
