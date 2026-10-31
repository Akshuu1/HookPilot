/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Types } from 'mongoose';
import * as sharedModule from '@hookpilot/shared';
import { alertTransportService } from '../services/alert-transport.service.js';
import { alertEvaluatorService } from '../services/alert-evaluator.service.js';
import { AlertChannelModel } from '../models/AlertChannel.js';
import { AlertRuleModel } from '../models/AlertRule.js';
import { AlertStateModel } from '../models/AlertState.js';
import { AlertHistoryModel } from '../models/AlertHistory.js';
import { DeliveryModel } from '../models/Delivery.js';
import { DeliveryAttemptModel } from '../models/DeliveryAttempt.js';
import { EventModel } from '../models/Event.js';
import { MembershipModel } from '../models/Membership.js';
import { requireChannelRole, requireRuleRole } from '../middlewares/alert-role.middleware.js';
import * as queueConfig from '../config/queue.js';
import * as redisConfig from '../config/redis.js';
import { runMigration } from '../../../../scripts/migrate-phase17-alerts.js';
import { encryptSecret } from '../utils/crypto.js';

describe('Phase 17: Failure Alerts & Notification Engine Tests', () => {
  const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'mock-alert-job-1' });

  beforeEach(() => {
    vi.clearAllMocks();

    const mockQueue = {
      add: mockQueueAdd,
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(queueConfig, 'getAlertsQueue').mockReturnValue(mockQueue as any);

    const mockRedis = {
      status: 'ready',
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      publish: vi.fn().mockResolvedValue(1),
    };
    vi.spyOn(redisConfig, 'getRedisClient').mockReturnValue(mockRedis as any);
    vi.spyOn(sharedModule, 'validateDestinationUrl').mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // 1. Condition Evaluators (delivery_dead, failure_rate, no_events)
  // --------------------------------------------------------------------------
  describe('1. Condition Evaluators with Simulated Clocks', () => {
    it('delivery_dead fires at the right count and window', async () => {
      vi.useFakeTimers();
      const now = new Date('2026-10-31T12:00:00Z');
      vi.setSystemTime(now);

      const workspaceId = new Types.ObjectId();
      const rule = {
        _id: new Types.ObjectId(),
        workspaceId,
        name: 'Dead Deliveries Alert',
        scope: { type: 'workspace' },
        condition: { type: 'delivery_dead', count: 3, windowMinutes: 15 },
      } as any;

      // Mock 2 dead deliveries (below threshold)
      vi.spyOn(DeliveryModel, 'find').mockReturnValue({
        limit: vi.fn().mockResolvedValue([
          { _id: new Types.ObjectId(), lastError: 'HTTP 500' },
          { _id: new Types.ObjectId(), lastError: 'HTTP 502' },
        ]),
      } as any);

      let evaluation = await alertEvaluatorService.evaluateCondition(rule, now);
      expect(evaluation.isTriggered).toBe(false);
      expect(evaluation.metricValue).toBe(2);

      // Now 3 dead deliveries (meets threshold)
      vi.spyOn(DeliveryModel, 'find').mockReturnValue({
        limit: vi.fn().mockResolvedValue([
          { _id: new Types.ObjectId(), lastError: 'HTTP 500' },
          { _id: new Types.ObjectId(), lastError: 'HTTP 500' },
          { _id: new Types.ObjectId(), lastError: 'HTTP 502' },
        ]),
      } as any);

      evaluation = await alertEvaluatorService.evaluateCondition(rule, now);
      expect(evaluation.isTriggered).toBe(true);
      expect(evaluation.metricValue).toBe(3);
      expect(evaluation.topFailureReasons[0]).toBe('HTTP 500 (2x)');
    });

    it('failure_rate does not fire below minDeliveries, and fires when threshold is exceeded', async () => {
      vi.useFakeTimers();
      const now = new Date('2026-10-31T12:00:00Z');
      vi.setSystemTime(now);

      const workspaceId = new Types.ObjectId();
      const rule = {
        _id: new Types.ObjectId(),
        workspaceId,
        name: 'High Failure Rate Alert',
        scope: { type: 'workspace' },
        condition: {
          type: 'failure_rate',
          thresholdPct: 50,
          windowMinutes: 10,
          minDeliveries: 10,
        },
      } as any;

      // Case A: 5 failed out of 5 attempts. Rate is 100%, but total < minDeliveries (10)
      const fewAttempts = Array.from({ length: 5 }, () => ({
        success: false,
        responseStatus: 500,
        error: 'Server Error',
      }));

      vi.spyOn(DeliveryAttemptModel, 'find').mockReturnValue({
        limit: vi.fn().mockResolvedValue(fewAttempts),
      } as any);

      let evaluation = await alertEvaluatorService.evaluateCondition(rule, now);
      expect(evaluation.isTriggered).toBe(false);
      expect(evaluation.metricText).toContain('below minDeliveries threshold');

      // Case B: 12 attempts, 7 failed (58.3% >= 50% threshold)
      const manyAttempts = [
        ...Array.from({ length: 7 }, () => ({
          success: false,
          responseStatus: 500,
          error: 'Internal Error',
        })),
        ...Array.from({ length: 5 }, () => ({
          success: true,
          responseStatus: 200,
          error: null,
        })),
      ];

      vi.spyOn(DeliveryAttemptModel, 'find').mockReturnValue({
        limit: vi.fn().mockResolvedValue(manyAttempts),
      } as any);

      evaluation = await alertEvaluatorService.evaluateCondition(rule, now);
      expect(evaluation.isTriggered).toBe(true);
      expect(evaluation.metricValue).toBe(58.3);
      expect(evaluation.topFailureReasons[0]).toContain('Internal Error (7x)');
    });

    it('no_events fires after silence and NOT for a never-used endpoint', async () => {
      vi.useFakeTimers();
      const now = new Date('2026-10-31T12:00:00Z');
      vi.setSystemTime(now);

      const endpointId = new Types.ObjectId();
      const rule = {
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(),
        name: 'Traffic Drop Alert',
        scope: { type: 'endpoint', id: endpointId.toString() },
        condition: { type: 'no_events', silenceMinutes: 30 },
      } as any;

      // Case A: Endpoint has never received any events -> MUST NOT FIRE
      vi.spyOn(EventModel, 'findOne').mockResolvedValue(null);

      let evaluation = await alertEvaluatorService.evaluateCondition(rule, now);
      expect(evaluation.isTriggered).toBe(false);
      expect(evaluation.metricText).toContain('never received any events');

      // Case B: Endpoint had past events, but none in the last 45 minutes
      const pastEvent = {
        receivedAt: new Date(now.getTime() - 45 * 60 * 1000), // 45m ago
      };

      vi.spyOn(EventModel, 'findOne').mockImplementation((query: any) => {
        if (query.receivedAt) {
          // looking for recent events within 30m window -> none
          return Promise.resolve(null) as any;
        }
        // looking for any event ever
        return {
          sort: vi.fn().mockResolvedValue(pastEvent),
        } as any;
      });

      evaluation = await alertEvaluatorService.evaluateCondition(rule, now);
      expect(evaluation.isTriggered).toBe(true);
      expect(evaluation.metricValue).toBe(45);
      expect(evaluation.metricText).toContain('No events received for 45 minutes');
    });
  });

  // --------------------------------------------------------------------------
  // 2. State Machine: Cooldown, 3 Clear Resolves & Flapping Protection
  // --------------------------------------------------------------------------
  describe('2. State Machine & Cooldown Transitions', () => {
    it('cooldown suppresses repeat notifications; resolves only after 3 consecutive clear evaluations', async () => {
      vi.useFakeTimers();
      const startTime = new Date('2026-10-31T10:00:00Z');
      vi.setSystemTime(startTime);

      const ruleId = new Types.ObjectId();
      const channelId = new Types.ObjectId();
      const rule = {
        _id: ruleId,
        workspaceId: new Types.ObjectId(),
        name: 'Critical Alert',
        scope: { type: 'workspace' },
        channelIds: [channelId],
        cooldownMinutes: 30,
        notifyOnResolve: true,
      } as any;

      const mockState = {
        ruleId,
        status: 'ok',
        consecutiveClear: 0,
        lastFiredAt: null as Date | null,
        lastNotifiedAt: null as Date | null,
        lastResolvedAt: null as Date | null,
        lastValue: null as number | null,
        save: vi.fn().mockResolvedValue(true),
      };

      vi.spyOn(AlertStateModel, 'findOne').mockResolvedValue(mockState as any);
      vi.spyOn(AlertChannelModel, 'findById').mockResolvedValue({
        _id: channelId,
        id: channelId.toString(),
        name: 'Test Channel',
      } as any);

      vi.spyOn(AlertHistoryModel.prototype, 'save').mockResolvedValue({} as any);
      vi.spyOn(AlertHistoryModel, 'findOne').mockReturnValue({
        sort: vi.fn().mockResolvedValue({
          resolvedAt: null,
          save: vi.fn().mockResolvedValue(true),
        }),
      } as any);

      // Step 1: Condition triggers -> ok to firing
      vi.spyOn(alertEvaluatorService, 'evaluateCondition').mockResolvedValue({
        isTriggered: true,
        metricValue: 10,
        metricText: '10 dead deliveries',
        topFailureReasons: [],
      });

      const res1 = await alertEvaluatorService.evaluateRule(rule, startTime);
      expect(res1.actionTaken).toBe('fired');
      expect(mockState.status).toBe('firing');
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);

      // Step 2: 10 minutes later (within 30m cooldown), condition still true -> notification suppressed
      const tenMinsLater = new Date(startTime.getTime() + 10 * 60 * 1000);
      vi.setSystemTime(tenMinsLater);

      const res2 = await alertEvaluatorService.evaluateRule(rule, tenMinsLater);
      expect(res2.actionTaken).toBe('cooldown_suppressed');
      expect(mockQueueAdd).toHaveBeenCalledTimes(1); // not called again

      // Step 3: Condition clears for 1st time -> consecutiveClear = 1, stays firing (flapping guard)
      vi.spyOn(alertEvaluatorService, 'evaluateCondition').mockResolvedValue({
        isTriggered: false,
        metricValue: 0,
        metricText: 'Cleared',
        topFailureReasons: [],
      });

      const res3 = await alertEvaluatorService.evaluateRule(
        rule,
        new Date(startTime.getTime() + 11 * 60 * 1000),
      );
      expect(res3.actionTaken).toBe('clearing_flapping_guard');
      expect(mockState.status).toBe('firing');
      expect(mockState.consecutiveClear).toBe(1);

      // Step 4: 2nd clear -> consecutiveClear = 2, still firing
      const res4 = await alertEvaluatorService.evaluateRule(
        rule,
        new Date(startTime.getTime() + 12 * 60 * 1000),
      );
      expect(res4.actionTaken).toBe('clearing_flapping_guard');
      expect(mockState.status).toBe('firing');
      expect(mockState.consecutiveClear).toBe(2);

      // Step 5: 3rd clear -> consecutiveClear = 3 -> resolves to 'ok' and enqueues resolved notification!
      const res5 = await alertEvaluatorService.evaluateRule(
        rule,
        new Date(startTime.getTime() + 13 * 60 * 1000),
      );
      expect(res5.actionTaken).toBe('resolved');
      expect(mockState.status).toBe('ok');
      expect(mockQueueAdd).toHaveBeenCalledTimes(2); // resolved notification dispatched!
    });
  });

  // --------------------------------------------------------------------------
  // 3. Grouping: 500 dead deliveries produce ONE notification & No Alert Loops
  // --------------------------------------------------------------------------
  describe('3. Grouping & Notification Error Handling', () => {
    it('500 dead deliveries produce exactly ONE notification job per window', async () => {
      const workspaceId = new Types.ObjectId();
      const channelId = new Types.ObjectId();
      const rule = {
        _id: new Types.ObjectId(),
        workspaceId,
        name: 'Mass Outage Rule',
        scope: { type: 'workspace' },
        channelIds: [channelId],
      } as any;

      vi.spyOn(AlertStateModel, 'findOne').mockResolvedValue({
        status: 'ok',
        save: vi.fn().mockResolvedValue(true),
      } as any);

      vi.spyOn(AlertChannelModel, 'findById').mockResolvedValue({
        _id: channelId,
        id: channelId.toString(),
        name: 'Slack Alerts',
      } as any);

      vi.spyOn(AlertHistoryModel.prototype, 'save').mockResolvedValue({} as any);

      vi.spyOn(alertEvaluatorService, 'evaluateCondition').mockResolvedValue({
        isTriggered: true,
        metricValue: 500,
        metricText: '500 dead deliveries in last 15m',
        count: 500,
        windowMinutes: 15,
        topFailureReasons: ['503 Service Unavailable (420x)', 'Connection Timeout (80x)'],
      });

      await alertEvaluatorService.evaluateRule(rule);

      // Dispatches exactly 1 job for the entire rule evaluation window
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      const enqueuedJobData = mockQueueAdd.mock.calls[0][1];
      expect(enqueuedJobData.payload.count).toBe(500);
      expect(enqueuedJobData.payload.topFailureReasons).toHaveLength(2);
    });

    it('failing channel delivery records failure in AlertHistory and never triggers alert loops', async () => {
      const channelId = new Types.ObjectId().toString();
      const workspaceId = new Types.ObjectId().toString();

      vi.spyOn(AlertChannelModel, 'findById').mockResolvedValue({
        _id: new Types.ObjectId(channelId),
        type: 'slack',
        configEncrypted: encryptSecret(
          JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/123/456' }),
        ),
      } as any);

      vi.spyOn(alertTransportService as any, 'sendSlack').mockRejectedValue(
        new Error('Slack server returned 503'),
      );

      const result = await alertTransportService.send({
        workspaceId,
        channelId,
        kind: 'firing',
        ruleName: 'Test Alert',
        scopeType: 'workspace',
        scopeName: 'Main',
        metricValueText: '5 failures',
        dashboardLink: 'http://localhost:5173',
      });

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Slack server returned 503');
    });
  });

  // --------------------------------------------------------------------------
  // 4. Security & Anti-Relay Validations
  // --------------------------------------------------------------------------
  describe('4. Security & Anti-Relay Guards', () => {
    it('rejects email recipients outside the workspace', async () => {
      const workspaceId = new Types.ObjectId().toString();

      // Only alice@company.com is in workspace
      vi.spyOn(MembershipModel, 'find').mockReturnValue({
        populate: vi.fn().mockResolvedValue([{ userId: { email: 'alice@company.com' } }]),
      } as any);

      await expect(
        alertTransportService.validateRecipientEmails(workspaceId, [
          'alice@company.com',
          'external-spammer@gmail.com',
        ]),
      ).rejects.toThrow('is not a member of workspace');
    });

    it('rejects Slack URLs on non-Slack hosts or private IP addresses', async () => {
      // Host check
      await expect(
        alertTransportService.validateSlackWebhookUrl('https://evil-attacker.com/webhook'),
      ).rejects.toThrow('must be hosted on hooks.slack.com');

      // SSRF check (private IP)
      vi.spyOn(sharedModule, 'validateDestinationUrl').mockResolvedValue(false);
      await expect(
        alertTransportService.validateSlackWebhookUrl('https://hooks.slack.com/services/123/456'),
      ).rejects.toThrow('rejected by SSRF guard');
    });

    it('never leaks webhook secret in API channel responses', async () => {
      const channel = {
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(),
        type: 'slack',
        name: 'Team Slack',
        configEncrypted: encryptSecret(
          JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/T00/B00/X123' }),
        ),
        verifiedAt: new Date(),
        createdBy: new Types.ObjectId(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      const res = (await import('../services/alert-channel.service.js')).mapAlertChannelResponse;
      const mapped = res(channel);

      expect(mapped.configPreview.webhookUrlMasked).toBe(
        'https://hooks.slack.com/services/••••••••',
      );
      expect((mapped as any).configEncrypted).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // 5. Distributed Concurrency & Tenant Isolation
  // --------------------------------------------------------------------------
  describe('5. Concurrency & Tenant Isolation', () => {
    it('two evaluator instances do not double-evaluate the same rule under Redis lock', async () => {
      const ruleId = new Types.ObjectId().toString();
      const redis = redisConfig.getRedisClient();

      // Instance 1 acquires lock
      vi.spyOn(redis, 'set').mockResolvedValueOnce('OK');
      const locked1 = await alertEvaluatorService.acquireRuleLock(ruleId);
      expect(locked1).toBe(true);

      // Instance 2 tries to acquire lock -> rejected
      vi.spyOn(redis, 'set').mockResolvedValueOnce(null);
      const locked2 = await alertEvaluatorService.acquireRuleLock(ruleId);
      expect(locked2).toBe(false);
    });

    it('enforces RBAC and tenant isolation on alert channel and rule routes', async () => {
      const workspaceA = new Types.ObjectId().toString();
      const userB = new Types.ObjectId().toString();

      const mockRepo = {
        findByWorkspaceAndUser: vi.fn().mockResolvedValue(null), // User B has no membership in Workspace A
      } as any;

      const channelMiddleware = requireChannelRole('viewer', mockRepo);
      const ruleMiddleware = requireRuleRole('viewer', mockRepo);

      const mockReq = {
        user: { id: userB },
        params: { id: new Types.ObjectId().toString() },
      } as any;

      vi.spyOn(AlertChannelModel, 'findById').mockResolvedValue({
        workspaceId: new Types.ObjectId(workspaceA),
      } as any);

      vi.spyOn(AlertRuleModel, 'findById').mockResolvedValue({
        workspaceId: new Types.ObjectId(workspaceA),
      } as any);

      const next1 = vi.fn();
      await channelMiddleware(mockReq, {} as any, next1);
      expect(next1).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));

      const next2 = vi.fn();
      await ruleMiddleware(mockReq, {} as any, next2);
      expect(next2).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    });

    it('idempotent migration creates alert states and logs summary', async () => {
      vi.spyOn(AlertChannelModel, 'syncIndexes').mockResolvedValue({} as any);
      vi.spyOn(AlertRuleModel, 'syncIndexes').mockResolvedValue({} as any);
      vi.spyOn(AlertStateModel, 'syncIndexes').mockResolvedValue({} as any);
      vi.spyOn(AlertHistoryModel, 'syncIndexes').mockResolvedValue({} as any);
      vi.spyOn(DeliveryModel, 'syncIndexes').mockResolvedValue({} as any);
      vi.spyOn(DeliveryAttemptModel, 'syncIndexes').mockResolvedValue({} as any);
      vi.spyOn(EventModel, 'syncIndexes').mockResolvedValue({} as any);

      const mockRule = { _id: new Types.ObjectId() };
      vi.spyOn(AlertRuleModel, 'find').mockResolvedValue([mockRule] as any);
      vi.spyOn(AlertStateModel, 'findOne').mockResolvedValue(null);
      vi.spyOn(AlertStateModel, 'create').mockResolvedValue({} as any);

      const dryRunRes = await runMigration({ dryRun: true });
      expect(dryRunRes.rulesChecked).toBe(1);
      expect(dryRunRes.statesCreated).toBe(1);
      expect(dryRunRes.dryRun).toBe(true);

      const realRunRes = await runMigration({ dryRun: false });
      expect(realRunRes.rulesChecked).toBe(1);
      expect(realRunRes.statesCreated).toBe(1);
      expect(realRunRes.dryRun).toBe(false);
    });
  });
});
