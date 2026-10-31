/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { alertChannelService, mapAlertChannelResponse } from '../alert-channel.service.js';
import { AlertChannelModel } from '../../models/AlertChannel.js';
import { AlertRuleModel } from '../../models/AlertRule.js';
import { alertTransportService } from '../alert-transport.service.js';
import { encryptSecret } from '../../utils/crypto.js';

describe('AlertChannelService Unit Tests', () => {
  const workspaceId = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('mapAlertChannelResponse', () => {
    it('maps email channel with preview correctly', () => {
      const encrypted = encryptSecret(JSON.stringify({ emails: ['ops@example.com'] }));
      const channel = {
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(workspaceId),
        type: 'email' as const,
        name: 'Email Channel',
        configEncrypted: encrypted,
        verifiedAt: new Date('2026-01-01T00:00:00Z'),
        createdBy: new Types.ObjectId(userId),
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      } as any;

      const res = mapAlertChannelResponse(channel);
      expect(res.name).toBe('Email Channel');
      expect(res.type).toBe('email');
      expect(res.configPreview.emails).toEqual(['ops@example.com']);
      expect(res.verifiedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('maps slack channel with masked preview', () => {
      const encrypted = encryptSecret(
        JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/T00/B00/X00' }),
      );
      const channel = {
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(workspaceId),
        type: 'slack' as const,
        name: 'Slack Alerts',
        configEncrypted: encrypted,
        verifiedAt: null,
        createdBy: new Types.ObjectId(userId),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      const res = mapAlertChannelResponse(channel);
      expect(res.configPreview.webhookUrlMasked).toContain('hooks.slack.com');
      expect(res.verifiedAt).toBeNull();
    });
  });

  describe('createChannel', () => {
    it('creates an email channel after validating recipients', async () => {
      vi.spyOn(alertTransportService, 'validateRecipientEmails').mockResolvedValue(true as any);
      vi.spyOn(AlertChannelModel.prototype, 'save').mockImplementation(async function (this: any) {
        this.createdAt = new Date();
        this.updatedAt = new Date();
      });

      const res = await alertChannelService.createChannel(workspaceId, userId, {
        type: 'email',
        name: 'DevOps Email',
        config: { emails: ['devops@example.com'] },
      });

      expect(res.name).toBe('DevOps Email');
      expect(res.type).toBe('email');
      expect(res.verifiedAt).toBeNull();
    });

    it('creates a slack channel after validating webhook URL', async () => {
      vi.spyOn(alertTransportService, 'validateSlackWebhookUrl').mockResolvedValue(true as any);
      vi.spyOn(AlertChannelModel.prototype, 'save').mockImplementation(async function (this: any) {
        this.createdAt = new Date();
        this.updatedAt = new Date();
      });

      const res = await alertChannelService.createChannel(workspaceId, userId, {
        type: 'slack',
        name: 'Slack Alerts',
        config: { webhookUrl: 'https://hooks.slack.com/services/T1/B1/K1' },
      });

      expect(res.name).toBe('Slack Alerts');
      expect(res.type).toBe('slack');
    });

    it('rejects invalid workspace ID', async () => {
      await expect(
        alertChannelService.createChannel('invalid-id', userId, {
          type: 'email',
          name: 'Channel',
          config: { emails: ['a@b.com'] },
        }),
      ).rejects.toThrow('Invalid workspace ID');
    });
  });

  describe('listChannels and getChannelById', () => {
    it('lists channels for a workspace', async () => {
      const channelObj = {
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(workspaceId),
        type: 'email' as const,
        name: 'Ch1',
        configEncrypted: encryptSecret(JSON.stringify({ emails: ['a@b.com'] })),
        verifiedAt: null,
        createdBy: new Types.ObjectId(userId),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.spyOn(AlertChannelModel, 'find').mockReturnValue({
        sort: vi.fn().mockResolvedValue([channelObj]),
      } as any);

      const channels = await alertChannelService.listChannels(workspaceId);
      expect(channels).toHaveLength(1);
      expect(channels[0]?.name).toBe('Ch1');
    });

    it('returns 404 when channel is not found', async () => {
      vi.spyOn(AlertChannelModel, 'findOne').mockResolvedValue(null);
      await expect(
        alertChannelService.getChannelById(new Types.ObjectId().toString(), workspaceId),
      ).rejects.toThrow('Alert channel not found');
    });
  });

  describe('updateChannel and deleteChannel', () => {
    it('updates channel name and requires reverification if config is changed', async () => {
      const channelDoc: any = {
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(workspaceId),
        type: 'email',
        name: 'Old Name',
        configEncrypted: encryptSecret(JSON.stringify({ emails: ['old@b.com'] })),
        verifiedAt: new Date(),
        createdBy: new Types.ObjectId(userId),
        createdAt: new Date(),
        updatedAt: new Date(),
        save: vi.fn().mockResolvedValue(undefined),
      };

      vi.spyOn(AlertChannelModel, 'findOne').mockResolvedValue(channelDoc);
      vi.spyOn(alertTransportService, 'validateRecipientEmails').mockResolvedValue(true as any);

      const updated = await alertChannelService.updateChannel(
        channelDoc._id.toString(),
        workspaceId,
        {
          name: 'New Name',
          config: { emails: ['new@b.com'] },
        },
      );

      expect(updated.name).toBe('New Name');
      expect(channelDoc.verifiedAt).toBeNull();
      expect(channelDoc.save).toHaveBeenCalled();
    });

    it('prevents deleting channel if assigned to active alert rules', async () => {
      const channelDoc: any = {
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(workspaceId),
        name: 'In Use Channel',
      };
      vi.spyOn(AlertChannelModel, 'findOne').mockResolvedValue(channelDoc);
      vi.spyOn(AlertRuleModel, 'find').mockResolvedValue([{ _id: 'rule-1' }] as any);

      await expect(
        alertChannelService.deleteChannel(channelDoc._id.toString(), workspaceId),
      ).rejects.toThrow('cannot be deleted because it is assigned to 1 enabled alert rule(s)');
    });

    it('deletes channel when not in use', async () => {
      const deleteOne = vi.fn().mockResolvedValue(undefined);
      const channelDoc: any = {
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(workspaceId),
        name: 'Unused Channel',
        deleteOne,
      };
      vi.spyOn(AlertChannelModel, 'findOne').mockResolvedValue(channelDoc);
      vi.spyOn(AlertRuleModel, 'find').mockResolvedValue([]);

      await alertChannelService.deleteChannel(channelDoc._id.toString(), workspaceId);
      expect(deleteOne).toHaveBeenCalled();
    });
  });

  describe('testChannel', () => {
    it('sends test notification and marks channel as verified on success', async () => {
      const save = vi.fn().mockResolvedValue(undefined);
      const channelDoc: any = {
        _id: new Types.ObjectId(),
        id: 'ch-1',
        workspaceId: new Types.ObjectId(workspaceId),
        name: 'Verified Channel',
        verifiedAt: null,
        save,
      };
      vi.spyOn(AlertChannelModel, 'findOne').mockResolvedValue(channelDoc);
      vi.spyOn(alertTransportService, 'send').mockResolvedValue({
        channelId: 'ch-1',
        kind: 'test',
        status: 'delivered',
        sentAt: new Date(),
      } as any);

      const res = await alertChannelService.testChannel(channelDoc._id.toString(), workspaceId);
      expect(res.success).toBe(true);
      expect(res.verifiedAt).toBeDefined();
      expect(channelDoc.verifiedAt).toBeDefined();
      expect(save).toHaveBeenCalled();
    });

    it('throws error when test notification delivery fails', async () => {
      const channelDoc: any = {
        _id: new Types.ObjectId(),
        id: 'ch-1',
        workspaceId: new Types.ObjectId(workspaceId),
        name: 'Failing Channel',
        verifiedAt: null,
      };
      vi.spyOn(AlertChannelModel, 'findOne').mockResolvedValue(channelDoc);
      vi.spyOn(alertTransportService, 'send').mockResolvedValue({
        channelId: 'ch-1',
        kind: 'test',
        status: 'failed',
        error: 'Slack webhook returned 404',
        sentAt: new Date(),
      } as any);

      await expect(
        alertChannelService.testChannel(channelDoc._id.toString(), workspaceId),
      ).rejects.toThrow('Slack webhook returned 404');
    });
  });
});
