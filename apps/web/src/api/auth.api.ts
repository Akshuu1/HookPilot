import { apiClient } from './client.js';
import type { RegisterInput, LoginInput, LoginResponse, UserResponse } from '@hookpilot/shared';

export const authApi = {
  register: async (input: RegisterInput): Promise<LoginResponse> => {
    const res = await apiClient.post<LoginResponse>('/auth/register', input);
    return res.data;
  },

  login: async (input: LoginInput): Promise<LoginResponse> => {
    const res = await apiClient.post<LoginResponse>('/auth/login', input);
    return res.data;
  },

  getMe: async (): Promise<{ user: UserResponse }> => {
    const res = await apiClient.get<{ user: UserResponse }>('/auth/me');
    return res.data;
  },

  logout: async (): Promise<void> => {
    await apiClient.post('/auth/logout');
  },

  refresh: async (): Promise<{ accessToken: string }> => {
    const res = await apiClient.post<{ accessToken: string }>('/auth/refresh');
    return res.data;
  },
};
