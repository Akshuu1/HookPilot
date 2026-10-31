/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { alertRuleService, mapAlertRuleResponse } from '../alert-rule.service.js';
import { AlertRuleModel } from '../../models/AlertRule.js';
import { AlertStateModel } from '../../models/AlertState.js';
import { AlertHistoryModel } from '../../models/AlertHistory.js';
import { AlertChannelModel } from '../../models/AlertChannel.js';
import { EndpointModel } from '../../models/Endpoint.js';
import { DestinationModel } from '../../models/Destination.js';
import { alertEvaluatorService } from '../alert-evaluator.service.js';

describe('AlertRuleService Unit Tests', () => {
  const workspaceId = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();
  const channelId = new Types.ObjectId().toString();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('mapAlertRuleResponse', () => {
    it('maps rule and state into AlertRuleResponse', () => {
      const rule: any = {
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(workspaceId),
        name: 'High Dead Deliveries',
        enabled: true,
        scope: { type: 'workspace' },
        condition: { type: 'delivery_dead', count: 10, windowMinutes: 5 },
        channelIds: [new Types.ObjectId(channelId)],
        cooldownMinutes: 30,
        notifyOnResolve: true,
        createdBy: new Types.ObjectId(userId),
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      };

      const state: any = {
        status: 'firing',
        consecutiveClear: 0,
        lastValue: 12,
        lastFiredAt: new Date('2026-01-01T01:00:00Z'),
        lastNotifiedAt: new Date('2026-01-01T01:00:00Z'),
        lastResolvedAt: null,
      };

      const res = mapAlertRuleResponse(rule, state);
      expect(res.name).toBe('High Dead Deliveries');
      expect(res.state?.status).toBe('firing');
      expect(res.state?.lastValue).toBe(12);
      expect(res.channelIds).toEqual([channelId]);
    });
  });

  describe('createRule', () => {
    it('creates rule with workspace scope and verified channels', async () => {
      vi.spyOn(AlertChannelModel, 'find').mockResolvedValue([
        {
          _id: new Types.ObjectId(channelId),
          name: 'Verified Channel',
          verifiedAt: new Date(),
        },
      ] as any);

      vi.spyOn(AlertRuleModel.prototype, 'save').mockImplementation(async function (this: any) {
        this.createdAt = new Date();
        this.updatedAt = new Date();
      });
      vi.spyOn(AlertStateModel.prototype, 'save').mockResolvedValue(undefined as any);

      const res = await alertRuleService.createRule(workspaceId, userId, {
        name: 'Dead Letter Alert',
        scope: { type: 'workspace' },
        condition: { type: 'delivery_dead', count: 5, windowMinutes: 10 },
        channelIds: [channelId],
      });

      expect(res.name).toBe('Dead Letter Alert');
      expect(res.enabled).toBe(true);
      expect(res.state?.status).toBe('ok');
    });

    it('rejects rule creation if channel is unverified', async () => {
      vi.spyOn(AlertChannelModel, 'find').mockResolvedValue([
        {
          _id: new Types.ObjectId(channelId),
          name: 'Unverified Channel',
          verifiedAt: null,
        },
      ] as any);

      await expect(
        alertRuleService.createRule(workspaceId, userId, {
          name: 'Dead Letter Alert',
          scope: { type: 'workspace' },
          condition: { type: 'delivery_dead', count: 5, windowMinutes: 10 },
          channelIds: [channelId],
        }),
      ).rejects.toThrow('has not passed a test verification');
    });

    it('validates scope endpoint exists', async () => {
      const epId = new Types.ObjectId().toString();
      vi.spyOn(EndpointModel, 'findOne').mockResolvedValue(null);

      await expect(
        alertRuleService.createRule(workspaceId, userId, {
          name: 'Rule',
          scope: { type: 'endpoint', id: epId },
          condition: { type: 'delivery_dead', count: 5, windowMinutes: 10 },
          channelIds: [channelId],
        }),
      ).rejects.toThrow('Specified endpoint not found');
    });

    it('validates scope destination exists', async () => {
      const destId = new Types.ObjectId().toString();
      vi.spyOn(DestinationModel, 'findOne').mockResolvedValue(null);

      await expect(
        alertRuleService.createRule(workspaceId, userId, {
          name: 'Rule',
          scope: { type: 'destination', id: destId },
          condition: { type: 'delivery_dead', count: 5, windowMinutes: 10 },
          channelIds: [channelId],
        }),
      ).rejects.toThrow('Specified destination not found');
    });
  });

  describe('listRules and getRuleById', () => {
    it('lists rules with attached alert states', async () => {
      const ruleId = new Types.ObjectId();
      const ruleDoc = {
        _id: ruleId,
        id: ruleId.toString(),
        workspaceId: new Types.ObjectId(workspaceId),
        name: 'Rule 1',
        enabled: true,
        scope: { type: 'workspace' },
        condition: { type: 'delivery_dead', count: 5, windowMinutes: 10 },
        channelIds: [],
        cooldownMinutes: 30,
        notifyOnResolve: true,
        createdBy: new Types.ObjectId(userId),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.spyOn(AlertRuleModel, 'find').mockReturnValue({
        sort: vi.fn().mockResolvedValue([ruleDoc]),
      } as any);

      vi.spyOn(AlertStateModel, 'find').mockResolvedValue([
        {
          ruleId,
          status: 'ok',
          consecutiveClear: 0,
        },
      ] as any);

      const rules = await alertRuleService.listRules(workspaceId);
      expect(rules).toHaveLength(1);
      expect(rules[0]?.state?.status).toBe('ok');
    });

    it('returns 404 if rule not found', async () => {
      vi.spyOn(AlertRuleModel, 'findOne').mockResolvedValue(null);
      await expect(
        alertRuleService.getRuleById(new Types.ObjectId().toString(), workspaceId),
      ).rejects.toThrow('Alert rule not found');
    });
  });

  describe('updateRule and deleteRule', () => {
    it('updates rule properties and revalidates channels', async () => {
      const ruleDoc: any = {
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(workspaceId),
        name: 'Old Rule',
        enabled: true,
        cooldownMinutes: 30,
        notifyOnResolve: true,
        scope: { type: 'workspace' },
        condition: { type: 'delivery_dead', count: 5, windowMinutes: 10 },
        channelIds: [],
        createdBy: new Types.ObjectId(userId),
        createdAt: new Date(),
        updatedAt: new Date(),
        save: vi.fn().mockResolvedValue(undefined),
      };

      vi.spyOn(AlertRuleModel, 'findOne').mockResolvedValue(ruleDoc);
      vi.spyOn(AlertChannelModel, 'find').mockResolvedValue([
        {
          _id: new Types.ObjectId(channelId),
          name: 'Verified',
          verifiedAt: new Date(),
        },
      ] as any);
      vi.spyOn(AlertStateModel, 'findOne').mockResolvedValue({
        ruleId: ruleDoc._id,
        status: 'ok',
      } as any);

      const updated = await alertRuleService.updateRule(ruleDoc._id.toString(), workspaceId, {
        name: 'New Rule Name',
        channelIds: [channelId],
      });

      expect(updated.name).toBe('New Rule Name');
      expect(ruleDoc.save).toHaveBeenCalled();
    });

    it('deletes rule and cascades state deletion', async () => {
      const ruleDoc: any = {
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(workspaceId),
        deleteOne: vi.fn().mockResolvedValue(undefined),
      };
      vi.spyOn(AlertRuleModel, 'findOne').mockResolvedValue(ruleDoc);
      const deleteStateMock = vi.spyOn(AlertStateModel, 'deleteOne').mockResolvedValue({} as any);

      await alertRuleService.deleteRule(ruleDoc._id.toString(), workspaceId);
      expect(deleteStateMock).toHaveBeenCalledWith({ ruleId: ruleDoc._id });
      expect(ruleDoc.deleteOne).toHaveBeenCalled();
    });
  });

  describe('history and test evaluation', () => {
    it('retrieves rule history', async () => {
      const ruleDoc: any = {
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(workspaceId),
      };
      vi.spyOn(AlertRuleModel, 'findOne').mockResolvedValue(ruleDoc);

      const historyDoc: any = {
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(workspaceId),
        ruleId: ruleDoc._id,
        firedAt: new Date(),
        resolvedAt: null,
        value: 15,
        summary: 'Dead letter spike',
        notifications: [],
        createdAt: new Date(),
      };

      vi.spyOn(AlertHistoryModel, 'find').mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([historyDoc]),
        }),
      } as any);

      const history = await alertRuleService.getRuleHistory(ruleDoc._id.toString(), workspaceId);
      expect(history).toHaveLength(1);
      expect(history[0]?.summary).toBe('Dead letter spike');
    });

    it('delegates test evaluation to evaluator service', async () => {
      const testResult = {
        ruleId: 'r-1',
        conditionType: 'delivery_dead',
        currentValue: 0,
        wouldFire: false,
        summary: '0 dead deliveries',
      };
      vi.spyOn(alertEvaluatorService, 'testEvaluateRule').mockResolvedValue(testResult as any);

      const res = await alertRuleService.testEvaluate('r-1', workspaceId);
      expect(res.wouldFire).toBe(false);
    });
  });
});
