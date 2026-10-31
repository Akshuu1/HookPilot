import { z } from 'zod';

export type AlertChannelType = 'email' | 'slack';
export type AlertScopeType = 'workspace' | 'endpoint' | 'destination';
export type AlertConditionType = 'delivery_dead' | 'failure_rate' | 'no_events';
export type AlertStateStatus = 'ok' | 'firing';
export type AlertNotificationKind = 'firing' | 'resolved' | 'summary' | 'test';
export type AlertNotificationStatus = 'sent' | 'failed';

// ----------------------------------------------------------------------------
// Channel Schemas & Types
// ----------------------------------------------------------------------------

export const emailChannelConfigSchema = z.object({
  emails: z.array(z.string().email().trim()).min(1, 'At least one recipient email is required'),
});

export const slackChannelConfigSchema = z.object({
  webhookUrl: z
    .string()
    .url('Must be a valid URL')
    .refine((url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && parsed.hostname === 'hooks.slack.com';
      } catch {
        return false;
      }
    }, 'Slack webhook URL must be https on hooks.slack.com'),
});

export const createAlertChannelSchema = z.object({
  type: z.enum(['email', 'slack']),
  name: z.string().min(1).max(100).trim(),
  config: z.record(z.unknown()), // validated conditionally by type in service/controller
});

export const updateAlertChannelSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  config: z.record(z.unknown()).optional(),
});

export interface AlertChannelResponse {
  id: string;
  workspaceId: string;
  type: AlertChannelType;
  name: string;
  configPreview: {
    emails?: string[];
    webhookUrlMasked?: string;
  };
  verifiedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ----------------------------------------------------------------------------
// Rule Scope & Condition Schemas (Discriminated Unions)
// ----------------------------------------------------------------------------

export const alertRuleScopeSchema = z.object({
  type: z.enum(['workspace', 'endpoint', 'destination']),
  id: z.string().optional(),
});

export const deliveryDeadConditionSchema = z.object({
  type: z.literal('delivery_dead'),
  count: z.number().int().min(1, 'Count must be at least 1'),
  windowMinutes: z.number().int().min(1).max(1440, 'Window cannot exceed 24 hours'),
});

export const failureRateConditionSchema = z.object({
  type: z.literal('failure_rate'),
  thresholdPct: z.number().min(0.1).max(100, 'Threshold percentage must be between 0.1 and 100'),
  windowMinutes: z.number().int().min(1).max(1440, 'Window cannot exceed 24 hours'),
  minDeliveries: z.number().int().min(1, 'minDeliveries must be at least 1'),
});

export const noEventsConditionSchema = z.object({
  type: z.literal('no_events'),
  silenceMinutes: z.number().int().min(1).max(10080, 'Silence cannot exceed 7 days'),
});

export const alertRuleConditionSchema = z.discriminatedUnion('type', [
  deliveryDeadConditionSchema,
  failureRateConditionSchema,
  noEventsConditionSchema,
]);

export type DeliveryDeadCondition = z.infer<typeof deliveryDeadConditionSchema>;
export type FailureRateCondition = z.infer<typeof failureRateConditionSchema>;
export type NoEventsCondition = z.infer<typeof noEventsConditionSchema>;
export type AlertRuleCondition = z.infer<typeof alertRuleConditionSchema>;
export type AlertRuleScope = z.infer<typeof alertRuleScopeSchema>;

export const createAlertRuleSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  enabled: z.boolean().default(true),
  scope: alertRuleScopeSchema,
  condition: alertRuleConditionSchema,
  channelIds: z.array(z.string()).min(1, 'At least one alert channel must be selected'),
  cooldownMinutes: z.number().int().min(1).max(1440).default(30),
  notifyOnResolve: z.boolean().default(true),
});

export const updateAlertRuleSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  enabled: z.boolean().optional(),
  scope: alertRuleScopeSchema.optional(),
  condition: alertRuleConditionSchema.optional(),
  channelIds: z.array(z.string()).min(1).optional(),
  cooldownMinutes: z.number().int().min(1).max(1440).optional(),
  notifyOnResolve: z.boolean().optional(),
});

export interface AlertRuleResponse {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  scope: AlertRuleScope;
  condition: AlertRuleCondition;
  channelIds: string[];
  cooldownMinutes: number;
  notifyOnResolve: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  state?:
    | {
        status: AlertStateStatus;
        consecutiveClear: number;
        lastValue: number | null;
        lastFiredAt: string | null;
        lastNotifiedAt: string | null;
        lastResolvedAt: string | null;
      }
    | undefined;
}

// ----------------------------------------------------------------------------
// History & Evaluation Schemas
// ----------------------------------------------------------------------------

export interface AlertNotificationRecord {
  channelId: string;
  kind: AlertNotificationKind;
  status: AlertNotificationStatus;
  error?: string | null;
  sentAt: string;
}

export interface AlertHistoryResponse {
  id: string;
  workspaceId: string;
  ruleId: string;
  firedAt: string;
  resolvedAt: string | null;
  value: number;
  summary: string;
  notifications: AlertNotificationRecord[];
  createdAt: string;
}

export interface TestEvaluateResult {
  ruleId: string;
  conditionType: AlertConditionType;
  currentValue: number;
  wouldFire: boolean;
  summary: string;
  topFailureReasons: string[];
}
