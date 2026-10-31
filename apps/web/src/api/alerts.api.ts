import { apiClient } from './client.js';
import type {
  AlertChannelResponse,
  AlertRuleResponse,
  AlertHistoryResponse,
  TestEvaluateResult,
  AlertRuleScope,
  AlertRuleCondition,
  AlertChannelType,
} from '@hookpilot/shared';

export interface CreateAlertChannelInput {
  type: AlertChannelType;
  name: string;
  config: {
    emails?: string[];
    webhookUrl?: string;
  };
}

export interface UpdateAlertChannelInput {
  name?: string;
  config?: {
    emails?: string[];
    webhookUrl?: string;
  };
}

export interface CreateAlertRuleInput {
  name: string;
  enabled?: boolean;
  scope: AlertRuleScope;
  condition: AlertRuleCondition;
  channelIds: string[];
  cooldownMinutes?: number;
  notifyOnResolve?: boolean;
}

export interface UpdateAlertRuleInput {
  name?: string;
  enabled?: boolean;
  scope?: AlertRuleScope;
  condition?: AlertRuleCondition;
  channelIds?: string[];
  cooldownMinutes?: number;
  notifyOnResolve?: boolean;
}

export const alertsApi = {
  // Channels
  listChannels: async (workspaceId: string): Promise<{ channels: AlertChannelResponse[] }> => {
    const res = await apiClient.get<{ channels: AlertChannelResponse[] }>(
      `/workspaces/${workspaceId}/alert-channels`,
    );
    return res.data;
  },

  createChannel: async (
    workspaceId: string,
    data: CreateAlertChannelInput,
  ): Promise<AlertChannelResponse> => {
    const res = await apiClient.post<AlertChannelResponse>(
      `/workspaces/${workspaceId}/alert-channels`,
      data,
    );
    return res.data;
  },

  updateChannel: async (
    channelId: string,
    data: UpdateAlertChannelInput,
  ): Promise<AlertChannelResponse> => {
    const res = await apiClient.patch<AlertChannelResponse>(`/alert-channels/${channelId}`, data);
    return res.data;
  },

  deleteChannel: async (channelId: string): Promise<{ success: boolean; message: string }> => {
    const res = await apiClient.delete<{ success: boolean; message: string }>(
      `/alert-channels/${channelId}`,
    );
    return res.data;
  },

  testChannel: async (channelId: string): Promise<{ success: boolean; message: string }> => {
    const res = await apiClient.post<{ success: boolean; message: string }>(
      `/alert-channels/${channelId}/test`,
    );
    return res.data;
  },

  // Rules
  listRules: async (workspaceId: string): Promise<{ rules: AlertRuleResponse[] }> => {
    const res = await apiClient.get<{ rules: AlertRuleResponse[] }>(
      `/workspaces/${workspaceId}/alert-rules`,
    );
    return res.data;
  },

  createRule: async (
    workspaceId: string,
    data: CreateAlertRuleInput,
  ): Promise<AlertRuleResponse> => {
    const res = await apiClient.post<AlertRuleResponse>(
      `/workspaces/${workspaceId}/alert-rules`,
      data,
    );
    return res.data;
  },

  getRule: async (ruleId: string): Promise<AlertRuleResponse> => {
    const res = await apiClient.get<AlertRuleResponse>(`/alert-rules/${ruleId}`);
    return res.data;
  },

  updateRule: async (ruleId: string, data: UpdateAlertRuleInput): Promise<AlertRuleResponse> => {
    const res = await apiClient.patch<AlertRuleResponse>(`/alert-rules/${ruleId}`, data);
    return res.data;
  },

  deleteRule: async (ruleId: string): Promise<{ success: boolean; message: string }> => {
    const res = await apiClient.delete<{ success: boolean; message: string }>(
      `/alert-rules/${ruleId}`,
    );
    return res.data;
  },

  getRuleHistory: async (
    ruleId: string,
    limit = 50,
  ): Promise<{ history: AlertHistoryResponse[] }> => {
    const res = await apiClient.get<{ history: AlertHistoryResponse[] }>(
      `/alert-rules/${ruleId}/history`,
      { params: { limit } },
    );
    return res.data;
  },

  getWorkspaceHistory: async (
    workspaceId: string,
    limit = 100,
  ): Promise<{ history: AlertHistoryResponse[] }> => {
    const res = await apiClient.get<{ history: AlertHistoryResponse[] }>(
      `/workspaces/${workspaceId}/alert-history`,
      { params: { limit } },
    );
    return res.data;
  },

  testEvaluateRule: async (ruleId: string): Promise<TestEvaluateResult> => {
    const res = await apiClient.post<TestEvaluateResult>(`/alert-rules/${ruleId}/test-evaluate`);
    return res.data;
  },

  testEvaluatePreview: async (
    workspaceId: string,
    scope: AlertRuleScope,
    condition: AlertRuleCondition,
  ): Promise<TestEvaluateResult> => {
    const res = await apiClient.post<TestEvaluateResult>(
      `/workspaces/${workspaceId}/alert-rules/test-evaluate`,
      { scope, condition },
    );
    return res.data;
  },
};
