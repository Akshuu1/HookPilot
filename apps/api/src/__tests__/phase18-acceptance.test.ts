/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Types } from 'mongoose';
import nodemailer from 'nodemailer';
import { alertEvaluatorService } from '../services/alert-evaluator.service.js';
import { alertTransportService } from '../services/alert-transport.service.js';
import { alertRuleService } from '../services/alert-rule.service.js';
import { AlertChannelModel } from '../models/AlertChannel.js';
import { AlertRuleModel } from '../models/AlertRule.js';
import { AlertStateModel } from '../models/AlertState.js';
import { AlertHistoryModel } from '../models/AlertHistory.js';
import { DeliveryModel } from '../models/Delivery.js';
import { MembershipModel } from '../models/Membership.js';
import { encryptSecret } from '../utils/crypto.js';
import * as queueConfig from '../config/queue.js';
import * as redisConfig from '../config/redis.js';

describe('Phase 18 Acceptance Verification: Broken Destination Fires Alert and Sends Email to Mailpit', () => {
  const mockSendMail = vi.fn().mockResolvedValue({ messageId: 'mailpit-msg-123' });
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

    // Mock nodemailer transporter
    vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
      sendMail: mockSendMail,
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Acceptance Criteria: breaking a destination fires a rule and the email shows up in Mailpit', async () => {
    const workspaceId = new Types.ObjectId();
    const endpointId = new Types.ObjectId();
    const brokenDestId = new Types.ObjectId();
    const ruleId = new Types.ObjectId();
    const channelId = new Types.ObjectId();
    const memberUserId = new Types.ObjectId();
    const recipientEmail = 'dev-team@hookpilot.internal';

    // 1. Setup workspace member for anti-relay verification
    vi.spyOn(MembershipModel, 'find').mockReturnValue({
      populate: vi.fn().mockResolvedValue([
        {
          userId: { _id: memberUserId, email: recipientEmail },
        },
      ]),
    } as any);

    // 2. Setup verified email channel (pointing to Mailpit in local dev)
    const channelDoc = {
      _id: channelId,
      id: channelId.toString(),
      workspaceId,
      type: 'email',
      name: 'Mailpit Dev Alerts',
      configEncrypted: encryptSecret(JSON.stringify({ emails: [recipientEmail] })),
      verifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.spyOn(AlertChannelModel, 'findById').mockResolvedValue(channelDoc as any);
    vi.spyOn(AlertChannelModel, 'find').mockResolvedValue([channelDoc] as any);

    // 3. Setup Alert Rule: when >= 1 delivery dies within 15 mins on workspace, notify Mailpit channel
    const ruleDoc = {
      _id: ruleId,
      id: ruleId.toString(),
      workspaceId,
      name: 'Broken Destination Dead Alert',
      enabled: true,
      scope: { type: 'workspace' },
      condition: {
        type: 'delivery_dead',
        count: 1,
        windowMinutes: 15,
      },
      channelIds: [channelId.toString()],
      cooldownMinutes: 30,
      notifyOnResolve: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.spyOn(AlertRuleModel, 'find').mockResolvedValue([ruleDoc] as any);
    vi.spyOn(AlertRuleModel, 'findOne').mockResolvedValue(ruleDoc as any);

    // 4. Broken Destination Simulation:
    // A destination breaks (e.g. returns 500 or connection refused), exhausting retries.
    // Delivery status becomes 'dead' with lastError recorded.
    const deadDelivery = {
      _id: new Types.ObjectId(),
      workspaceId,
      endpointId,
      destinationId: brokenDestId,
      status: 'dead',
      lastError:
        'HTTP 500: Destination service connection refused at https://broken-service.internal/webhook',
      attemptCount: 5,
      updatedAt: new Date(),
      createdAt: new Date(Date.now() - 2 * 60 * 1000),
    };
    vi.spyOn(DeliveryModel, 'find').mockReturnValue({
      limit: vi.fn().mockResolvedValue([deadDelivery]),
    } as any);

    // Initial alert state is 'ok'
    const stateDoc = {
      ruleId,
      status: 'ok',
      consecutiveClear: 0,
      lastValue: 0,
      save: vi.fn().mockResolvedValue(true),
    };
    vi.spyOn(AlertStateModel, 'findOne').mockResolvedValue(stateDoc as any);

    vi.spyOn(AlertHistoryModel.prototype, 'save').mockImplementation(async function (this: any) {
      return this;
    });

    // 5. Run Alert Evaluator
    const evalResult = await alertEvaluatorService.evaluateRule(ruleDoc as any);

    // State machine should transition to firing
    expect(evalResult.isFiring).toBe(true);
    expect(evalResult.actionTaken).toBe('fired');
    expect(stateDoc.status).toBe('firing');

    // Notification job should be dispatched to BullMQ
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'send-alert',
      expect.objectContaining({
        payload: expect.objectContaining({
          ruleName: 'Broken Destination Dead Alert',
          kind: 'firing',
          metricValueText: expect.stringContaining('1 dead deliveries in last 15m'),
          topFailureReasons: expect.arrayContaining([
            expect.stringContaining('HTTP 500: Destination service connection refused'),
          ]),
        }),
      }),
    );

    // 6. Verify direct transport delivery to Mailpit
    const transportResult = await alertTransportService.send({
      channelId: channelId.toString(),
      ruleName: 'Broken Destination Dead Alert',
      scopeName: 'Entire Workspace',
      scopeType: 'workspace',
      kind: 'firing',
      metricValueText: '1 dead deliveries in last 15m (threshold: >= 1)',
      topFailureReasons: [
        'HTTP 500: Destination service connection refused at https://broken-service.internal/webhook (1x)',
      ],
      dashboardLink: 'http://localhost:3000/events?scope=workspace',
    });

    expect(transportResult.status).toBe('sent');
    expect(transportResult.kind).toBe('firing');
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: recipientEmail,
        subject: expect.stringContaining('[FIRING] HookPilot Alert: Broken Destination Dead Alert'),
        text: expect.stringContaining('HTTP 500: Destination service connection refused'),
      }),
    );

    // 7. Test dry-run preview endpoint logic
    const previewResult = await alertRuleService.testEvaluatePreview(
      workspaceId.toString(),
      { type: 'workspace' },
      { type: 'delivery_dead', count: 1, windowMinutes: 15 },
    );
    expect(previewResult.wouldFire).toBe(true);
    expect(previewResult.currentValue).toBe(1);

    // 8. Test workspace-level history retrieval
    vi.spyOn(AlertHistoryModel, 'find').mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([
          {
            _id: new Types.ObjectId(),
            workspaceId,
            ruleId,
            firedAt: new Date(),
            resolvedAt: null,
            value: 1,
            summary: '1 dead deliveries in last 15m',
            notifications: [
              {
                channelId,
                kind: 'firing',
                status: 'sent',
                sentAt: new Date(),
              },
            ],
            createdAt: new Date(),
          },
        ]),
      }),
    } as any);

    const historyItems = await alertRuleService.getWorkspaceHistory(workspaceId.toString(), 10);
    expect(historyItems).toHaveLength(1);
    expect(historyItems[0]?.value).toBe(1);
    expect(historyItems[0]?.notifications[0]?.status).toBe('sent');
  });
});
