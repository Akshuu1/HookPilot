import { Types } from 'mongoose';
import {
  type AlertChannelResponse,
  emailChannelConfigSchema,
  slackChannelConfigSchema,
} from '@hookpilot/shared';
import { AppError } from '../middlewares/error-handler.js';
import { AlertChannelModel, type IAlertChannel } from '../models/AlertChannel.js';
import { AlertRuleModel } from '../models/AlertRule.js';
import { encryptSecret, decryptSecret } from '../utils/crypto.js';
import { alertTransportService } from './alert-transport.service.js';

export function mapAlertChannelResponse(channel: IAlertChannel): AlertChannelResponse {
  let configPreview: { emails?: string[]; webhookUrlMasked?: string } = {};

  try {
    const decrypted = JSON.parse(decryptSecret(channel.configEncrypted));
    if (channel.type === 'email') {
      configPreview = { emails: decrypted.emails || [] };
    } else if (channel.type === 'slack') {
      configPreview = {
        webhookUrlMasked: 'https://hooks.slack.com/services/••••••••',
      };
    }
  } catch {
    configPreview = {};
  }

  return {
    id: channel._id.toString(),
    workspaceId: channel.workspaceId.toString(),
    type: channel.type,
    name: channel.name,
    configPreview,
    verifiedAt: channel.verifiedAt ? channel.verifiedAt.toISOString() : null,
    createdBy: channel.createdBy.toString(),
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  };
}

export class AlertChannelService {
  async createChannel(
    workspaceId: string,
    userId: string,
    data: { type: 'email' | 'slack'; name: string; config: Record<string, unknown> },
  ): Promise<AlertChannelResponse> {
    if (!Types.ObjectId.isValid(workspaceId)) {
      throw new AppError('Invalid workspace ID', 400, 'INVALID_WORKSPACE_ID');
    }

    let sanitizedConfig: Record<string, unknown>;

    if (data.type === 'email') {
      const parsed = emailChannelConfigSchema.safeParse(data.config);
      if (!parsed.success) {
        throw new AppError(
          parsed.error.issues[0]?.message || 'Invalid email config',
          400,
          'INVALID_CHANNEL_CONFIG',
        );
      }
      await alertTransportService.validateRecipientEmails(workspaceId, parsed.data.emails);
      sanitizedConfig = { emails: parsed.data.emails };
    } else if (data.type === 'slack') {
      const parsed = slackChannelConfigSchema.safeParse(data.config);
      if (!parsed.success) {
        throw new AppError(
          parsed.error.issues[0]?.message || 'Invalid Slack config',
          400,
          'INVALID_CHANNEL_CONFIG',
        );
      }
      await alertTransportService.validateSlackWebhookUrl(parsed.data.webhookUrl);
      sanitizedConfig = { webhookUrl: parsed.data.webhookUrl };
    } else {
      throw new AppError('Unsupported alert channel type', 400, 'UNSUPPORTED_CHANNEL_TYPE');
    }

    const configEncrypted = encryptSecret(JSON.stringify(sanitizedConfig));

    const channel = new AlertChannelModel({
      workspaceId: new Types.ObjectId(workspaceId),
      type: data.type,
      name: data.name,
      configEncrypted,
      verifiedAt: null, // must be tested before rules can use it
      createdBy: new Types.ObjectId(userId),
    });

    await channel.save();
    return mapAlertChannelResponse(channel);
  }

  async listChannels(workspaceId: string): Promise<AlertChannelResponse[]> {
    if (!Types.ObjectId.isValid(workspaceId)) {
      throw new AppError('Invalid workspace ID', 400, 'INVALID_WORKSPACE_ID');
    }

    const channels = await AlertChannelModel.find({
      workspaceId: new Types.ObjectId(workspaceId),
    }).sort({ createdAt: -1 });

    return channels.map(mapAlertChannelResponse);
  }

  async getChannelById(channelId: string, workspaceId: string): Promise<AlertChannelResponse> {
    if (!Types.ObjectId.isValid(channelId) || !Types.ObjectId.isValid(workspaceId)) {
      throw new AppError('Invalid channel or workspace ID', 400, 'INVALID_ID');
    }

    const channel = await AlertChannelModel.findOne({
      _id: new Types.ObjectId(channelId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!channel) {
      throw new AppError('Alert channel not found', 404, 'CHANNEL_NOT_FOUND');
    }

    return mapAlertChannelResponse(channel);
  }

  async updateChannel(
    channelId: string,
    workspaceId: string,
    data: { name?: string | undefined; config?: Record<string, unknown> | undefined },
  ): Promise<AlertChannelResponse> {
    const channel = await AlertChannelModel.findOne({
      _id: new Types.ObjectId(channelId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!channel) {
      throw new AppError('Alert channel not found', 404, 'CHANNEL_NOT_FOUND');
    }

    if (data.name !== undefined) {
      channel.name = data.name.trim();
    }

    if (data.config !== undefined) {
      let sanitizedConfig: Record<string, unknown>;

      if (channel.type === 'email') {
        const parsed = emailChannelConfigSchema.safeParse(data.config);
        if (!parsed.success) {
          throw new AppError(
            parsed.error.issues[0]?.message || 'Invalid email config',
            400,
            'INVALID_CHANNEL_CONFIG',
          );
        }
        await alertTransportService.validateRecipientEmails(workspaceId, parsed.data.emails);
        sanitizedConfig = { emails: parsed.data.emails };
      } else {
        const parsed = slackChannelConfigSchema.safeParse(data.config);
        if (!parsed.success) {
          throw new AppError(
            parsed.error.issues[0]?.message || 'Invalid Slack config',
            400,
            'INVALID_CHANNEL_CONFIG',
          );
        }
        await alertTransportService.validateSlackWebhookUrl(parsed.data.webhookUrl);
        sanitizedConfig = { webhookUrl: parsed.data.webhookUrl };
      }

      channel.configEncrypted = encryptSecret(JSON.stringify(sanitizedConfig));
      channel.verifiedAt = null; // Re-verification required when config changes
    }

    await channel.save();
    return mapAlertChannelResponse(channel);
  }

  async deleteChannel(channelId: string, workspaceId: string): Promise<void> {
    const channel = await AlertChannelModel.findOne({
      _id: new Types.ObjectId(channelId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!channel) {
      throw new AppError('Alert channel not found', 404, 'CHANNEL_NOT_FOUND');
    }

    // Check if channel is used by any active alert rules
    const activeRules = await AlertRuleModel.find({
      workspaceId: new Types.ObjectId(workspaceId),
      channelIds: channel._id,
      enabled: true,
    });

    if (activeRules.length > 0) {
      throw new AppError(
        `Channel "${channel.name}" cannot be deleted because it is assigned to ${activeRules.length} enabled alert rule(s).`,
        400,
        'CHANNEL_IN_USE',
      );
    }

    await channel.deleteOne();
  }

  /**
   * Sends a clearly labeled test message and marks the channel as verified.
   */
  async testChannel(
    channelId: string,
    workspaceId: string,
  ): Promise<{ success: boolean; verifiedAt: string }> {
    const channel = await AlertChannelModel.findOne({
      _id: new Types.ObjectId(channelId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!channel) {
      throw new AppError('Alert channel not found', 404, 'CHANNEL_NOT_FOUND');
    }

    const testPayload = {
      workspaceId,
      channelId: channel.id,
      kind: 'test' as const,
      ruleName: 'Test Alert Verification',
      scopeType: 'channel',
      scopeName: channel.name,
      metricValueText: 'Test notification check',
      dashboardLink: `${process.env.DASHBOARD_URL || 'http://localhost:5173'}/settings`,
      testMessage: `[TEST] This is an automated test message from HookPilot to verify delivery for channel "${channel.name}".`,
    };

    const result = await alertTransportService.send(testPayload);

    if (result.status === 'failed') {
      throw new AppError(result.error || 'Failed to send test message', 400, 'CHANNEL_TEST_FAILED');
    }

    const verifiedAt = new Date();
    channel.verifiedAt = verifiedAt;
    await channel.save();

    return {
      success: true,
      verifiedAt: verifiedAt.toISOString(),
    };
  }
}

export const alertChannelService = new AlertChannelService();
