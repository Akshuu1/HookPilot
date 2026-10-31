import { apiClient } from './client.js';
import type {
  RegisterInput,
  LoginInput,
  LoginResponse,
  UserResponse,
  ProvidersConfigResponse,
} from '@hookpilot/shared';

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

  getProviders: async (): Promise<ProvidersConfigResponse> => {
    const res = await apiClient.get<ProvidersConfigResponse>('/auth/providers');
    return res.data;
  },

  linkStart: async (
    provider: string,
    returnTo?: string,
  ): Promise<{ url: string; state: string }> => {
    const res = await apiClient.post<{ url: string; state: string }>(
      `/auth/oauth/${provider}/link-start`,
      { returnTo: returnTo || '/settings' },
    );
    return res.data;
  },

  unlinkIdentity: async (identityId: string): Promise<{ success: boolean; message?: string }> => {
    const res = await apiClient.delete<{ success: boolean; message?: string }>(
      `/auth/identities/${identityId}`,
    );
    return res.data;
  },
};
