import { apiClient } from './client.js';
import type { DeliveryResponse } from '@hookpilot/shared';

export const deliveriesApi = {
  getById: async (id: string): Promise<DeliveryResponse> => {
    const res = await apiClient.get<DeliveryResponse>(`/deliveries/${id}`);
    return res.data;
  },

  replay: async (
    id: string,
    force = false,
  ): Promise<{ success: boolean; jobId: string; deliveryId: string }> => {
    const res = await apiClient.post<{ success: boolean; jobId: string; deliveryId: string }>(
      `/deliveries/${id}/replay`,
      { force },
    );
    return res.data;
  },

  forceDeliver: async (
    id: string,
  ): Promise<{ success: boolean; jobId: string; deliveryId: string }> => {
    const res = await apiClient.post<{ success: boolean; jobId: string; deliveryId: string }>(
      `/deliveries/${id}/force-deliver`,
      {},
    );
    return res.data;
  },
};
