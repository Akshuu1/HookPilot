import { Types } from 'mongoose';
import type {
  AlertRuleCondition,
  TestEvaluateResult,
  AlertNotificationKind,
} from '@hookpilot/shared';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getRedisClient, getAlertsQueue } from '../config/redis.js';
import { AlertRuleModel, type IAlertRule } from '../models/AlertRule.js';
import { AlertStateModel } from '../models/AlertState.js';
import { AlertHistoryModel, type IAlertHistory } from '../models/AlertHistory.js';
import { AlertChannelModel } from '../models/AlertChannel.js';
import { DeliveryModel } from '../models/Delivery.js';
import { DeliveryAttemptModel } from '../models/DeliveryAttempt.js';
import { EventModel } from '../models/Event.js';
import { DestinationModel } from '../models/Destination.js';
import { EndpointModel } from '../models/Endpoint.js';
import { alertTransportService } from './alert-transport.service.js';

export interface ConditionEvaluation {
  isTriggered: boolean;
  metricValue: number;
  metricText: string;
  windowMinutes?: number;
  count?: number;
  topFailureReasons: string[];
}

export class AlertEvaluatorService {
  /**
   * Evaluates all enabled alert rules across all workspaces.
   * Runs in batches under short Redis locks keyed by ruleId.
   */
  async evaluateAllRules(batchSize = 50): Promise<{ evaluated: number; firing: number }> {
    let skip = 0;
    let evaluated = 0;
    let firing = 0;

    while (true) {
      const rules = await AlertRuleModel.find({ enabled: true }).skip(skip).limit(batchSize);

      if (rules.length === 0) break;

      for (const rule of rules) {
        const locked = await this.acquireRuleLock(rule.id);
        if (!locked) {
          logger.debug({ ruleId: rule.id }, 'Rule evaluation lock active; skipping rule');
          continue;
        }

        try {
          const res = await this.evaluateRule(rule);
          evaluated += 1;
          if (res.isFiring) firing += 1;
        } catch (err: unknown) {
          logger.error({ ruleId: rule.id, err }, 'Failed to evaluate alert rule');
        } finally {
          await this.releaseRuleLock(rule.id);
        }
      }

      skip += batchSize;
    }

    return { evaluated, firing };
  }

  /**
   * Acquires a 30-second Redis lock for ruleId.
   */
  async acquireRuleLock(ruleId: string): Promise<boolean> {
    try {
      const redis = getRedisClient();
      const lockKey = `lock:alert-rule:${ruleId}`;
      const acquired = await redis.set(lockKey, '1', 'PX', 30000, 'NX');
      return acquired === 'OK';
    } catch {
      return true; // proceed in offline/mock test environments
    }
  }

  async releaseRuleLock(ruleId: string): Promise<void> {
    try {
      const redis = getRedisClient();
      const lockKey = `lock:alert-rule:${ruleId}`;
      await redis.del(lockKey);
    } catch {
      // Ignore
    }
  }

  /**
   * Pure evaluation of condition without modifying alert state or sending notifications.
   */
  async evaluateCondition(rule: IAlertRule, now = new Date()): Promise<ConditionEvaluation> {
    const condition = rule.condition as AlertRuleCondition;

    if (condition.type === 'delivery_dead') {
      return this.evaluateDeliveryDead(rule, condition, now);
    }
    if (condition.type === 'failure_rate') {
      return this.evaluateFailureRate(rule, condition, now);
    }
    if (condition.type === 'no_events') {
      return this.evaluateNoEvents(rule, condition, now);
    }

    return {
      isTriggered: false,
      metricValue: 0,
      metricText: 'Unknown condition type',
      topFailureReasons: [],
    };
  }

  private async evaluateDeliveryDead(
    rule: IAlertRule,
    condition: { type: 'delivery_dead'; count: number; windowMinutes: number },
    now: Date,
  ): Promise<ConditionEvaluation> {
    const windowStart = new Date(now.getTime() - condition.windowMinutes * 60 * 1000);
    const filter: Record<string, unknown> = {
      workspaceId: rule.workspaceId,
      status: 'dead',
      updatedAt: { $gte: windowStart },
    };

    if (rule.scope.type === 'destination' && rule.scope.id) {
      filter.destinationId = new Types.ObjectId(rule.scope.id);
    } else if (rule.scope.type === 'endpoint' && rule.scope.id) {
      const dests = await DestinationModel.find(
        { endpointId: new Types.ObjectId(rule.scope.id) },
        '_id',
      );
      filter.destinationId = { $in: dests.map((d) => d._id) };
    }

    const deadDeliveries = await DeliveryModel.find(filter).limit(100);
    const deadCount = deadDeliveries.length;

    // Group failure reasons
    const reasonCounts = new Map<string, number>();
    for (const d of deadDeliveries) {
      if (d.lastError) {
        reasonCounts.set(d.lastError, (reasonCounts.get(d.lastError) || 0) + 1);
      }
    }
    const topFailureReasons = Array.from(reasonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([msg, c]) => `${msg} (${c}x)`);

    const isTriggered = deadCount >= condition.count;
    const metricText = `${deadCount} dead deliveries in last ${condition.windowMinutes}m (threshold: >= ${condition.count})`;

    return {
      isTriggered,
      metricValue: deadCount,
      metricText,
      windowMinutes: condition.windowMinutes,
      count: deadCount,
      topFailureReasons,
    };
  }

  private async evaluateFailureRate(
    rule: IAlertRule,
    condition: {
      type: 'failure_rate';
      thresholdPct: number;
      windowMinutes: number;
      minDeliveries: number;
    },
    now: Date,
  ): Promise<ConditionEvaluation> {
    const windowStart = new Date(now.getTime() - condition.windowMinutes * 60 * 1000);
    const filter: Record<string, unknown> = {
      workspaceId: rule.workspaceId,
      createdAt: { $gte: windowStart },
    };

    if (rule.scope.type === 'destination' && rule.scope.id) {
      filter.destinationId = new Types.ObjectId(rule.scope.id);
    } else if (rule.scope.type === 'endpoint' && rule.scope.id) {
      const dests = await DestinationModel.find(
        { endpointId: new Types.ObjectId(rule.scope.id) },
        '_id',
      );
      filter.destinationId = { $in: dests.map((d) => d._id) };
    }

    const attempts = await DeliveryAttemptModel.find(filter).limit(500);
    const totalDeliveries = attempts.length;

    if (totalDeliveries < condition.minDeliveries) {
      return {
        isTriggered: false,
        metricValue: 0,
        metricText: `Attempts count (${totalDeliveries}) below minDeliveries threshold (${condition.minDeliveries})`,
        windowMinutes: condition.windowMinutes,
        count: totalDeliveries,
        topFailureReasons: [],
      };
    }

    const failed = attempts.filter(
      (a) => !a.success || a.responseStatus >= 400 || a.responseStatus === 0,
    );
    const failureRate = Math.round((failed.length / totalDeliveries) * 1000) / 10; // e.g. 33.3%

    const reasonCounts = new Map<string, number>();
    for (const a of failed) {
      const reason = a.error || `HTTP ${a.responseStatus || 0}`;
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }
    const topFailureReasons = Array.from(reasonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([msg, c]) => `${msg} (${c}x)`);

    const isTriggered = failureRate >= condition.thresholdPct;
    const metricText = `Failure rate ${failureRate}% (${failed.length}/${totalDeliveries} attempts) in last ${condition.windowMinutes}m (threshold: >= ${condition.thresholdPct}%)`;

    return {
      isTriggered,
      metricValue: failureRate,
      metricText,
      windowMinutes: condition.windowMinutes,
      count: totalDeliveries,
      topFailureReasons,
    };
  }

  private async evaluateNoEvents(
    rule: IAlertRule,
    condition: { type: 'no_events'; silenceMinutes: number },
    now: Date,
  ): Promise<ConditionEvaluation> {
    const silenceStart = new Date(now.getTime() - condition.silenceMinutes * 60 * 1000);

    const filter: Record<string, unknown> = {
      workspaceId: rule.workspaceId,
    };
    if (rule.scope.type === 'endpoint' && rule.scope.id) {
      filter.endpointId = new Types.ObjectId(rule.scope.id);
    }

    // Check if the scope ever received at least one event before!
    const anyEventEver = await EventModel.findOne(filter);
    if (!anyEventEver) {
      return {
        isTriggered: false,
        metricValue: 0,
        metricText: 'Scope has never received any events (no-events alert skipped)',
        topFailureReasons: [],
      };
    }

    // Check if any event was received within the silence window
    const recentEvent = await EventModel.findOne({
      ...filter,
      receivedAt: { $gte: silenceStart },
    });

    if (recentEvent) {
      return {
        isTriggered: false,
        metricValue: 0,
        metricText: `Active events present within the last ${condition.silenceMinutes}m`,
        topFailureReasons: [],
      };
    }

    // Find the latest event timestamp to compute exact silence duration
    const latestEvent = await EventModel.findOne(filter).sort({ receivedAt: -1 });
    const diffMinutes = latestEvent
      ? Math.floor((now.getTime() - new Date(latestEvent.receivedAt).getTime()) / 60000)
      : condition.silenceMinutes;

    const metricText = `No events received for ${diffMinutes} minutes (silence threshold: ${condition.silenceMinutes}m)`;

    return {
      isTriggered: true,
      metricValue: diffMinutes,
      metricText,
      windowMinutes: condition.silenceMinutes,
      topFailureReasons: [],
    };
  }

  /**
   * Resolves scope human-readable name for notifications.
   */
  async resolveScopeName(rule: IAlertRule): Promise<string> {
    if (rule.scope.type === 'workspace') return 'Entire Workspace';
    if (rule.scope.type === 'endpoint' && rule.scope.id) {
      const ep = await EndpointModel.findById(rule.scope.id);
      return ep ? ep.name : `Endpoint ${rule.scope.id}`;
    }
    if (rule.scope.type === 'destination' && rule.scope.id) {
      const dest = await DestinationModel.findById(rule.scope.id);
      return dest ? dest.name : `Destination ${rule.scope.id}`;
    }
    return rule.scope.type;
  }

  /**
   * Full state-machine evaluation: transitions ok -> firing, resolves after 3 clears,
   * enforces cooldown, logs AlertHistory, and dispatches notifications.
   */
  async evaluateRule(
    rule: IAlertRule,
    now = new Date(),
  ): Promise<{ isFiring: boolean; actionTaken: string }> {
    const evaluation = await this.evaluateCondition(rule, now);

    let state = await AlertStateModel.findOne({ ruleId: rule._id });
    if (!state) {
      state = new AlertStateModel({
        ruleId: rule._id,
        status: 'ok',
        consecutiveClear: 0,
      });
    }

    const scopeName = await this.resolveScopeName(rule);
    const dashboardLink = `${env.DASHBOARD_URL}/events?scope=${rule.scope.type}&scopeId=${rule.scope.id || ''}`;

    let actionTaken = 'none';

    if (evaluation.isTriggered) {
      state.consecutiveClear = 0;

      if (state.status === 'ok') {
        // Transition ok -> firing
        state.status = 'firing';
        state.lastFiredAt = now;
        state.lastNotifiedAt = now;
        state.lastValue = evaluation.metricValue;

        const history = new AlertHistoryModel({
          workspaceId: rule.workspaceId,
          ruleId: rule._id,
          firedAt: now,
          value: evaluation.metricValue,
          summary: evaluation.metricText,
          notifications: [],
        });
        await history.save();

        await this.dispatchNotifications(rule, history, {
          kind: 'firing',
          scopeName,
          dashboardLink,
          evaluation,
        });

        actionTaken = 'fired';
      } else {
        // Already firing: check cooldown
        const cooldownMs = (rule.cooldownMinutes || 30) * 60 * 1000;
        const canRepeat =
          !state.lastNotifiedAt || now.getTime() - state.lastNotifiedAt.getTime() >= cooldownMs;

        if (canRepeat) {
          state.lastNotifiedAt = now;
          state.lastValue = evaluation.metricValue;

          // Find current open history or create one
          let history = await AlertHistoryModel.findOne({
            ruleId: rule._id,
            resolvedAt: null,
          }).sort({ firedAt: -1 });

          if (!history) {
            history = new AlertHistoryModel({
              workspaceId: rule.workspaceId,
              ruleId: rule._id,
              firedAt: now,
              value: evaluation.metricValue,
              summary: evaluation.metricText,
              notifications: [],
            });
            await history.save();
          }

          await this.dispatchNotifications(rule, history, {
            kind: 'firing',
            scopeName,
            dashboardLink,
            evaluation,
          });

          actionTaken = 'cooldown_repeated';
        } else {
          actionTaken = 'cooldown_suppressed';
        }
      }
    } else {
      // Condition is not triggered
      state.consecutiveClear += 1;
      state.lastValue = evaluation.metricValue;

      if (state.status === 'firing') {
        // Flapping protection: only resolve after 3 consecutive clear checks
        if (state.consecutiveClear >= 3) {
          state.status = 'ok';
          state.lastResolvedAt = now;

          // Close active history
          const history = await AlertHistoryModel.findOne({
            ruleId: rule._id,
            resolvedAt: null,
          }).sort({ firedAt: -1 });

          if (history) {
            history.resolvedAt = now;
            await history.save();

            if (rule.notifyOnResolve) {
              await this.dispatchNotifications(rule, history, {
                kind: 'resolved',
                scopeName,
                dashboardLink,
                evaluation,
              });
            }
          }

          actionTaken = 'resolved';
        } else {
          actionTaken = 'clearing_flapping_guard';
        }
      }
    }

    await state.save();
    return { isFiring: state.status === 'firing', actionTaken };
  }

  /**
   * Dispatches notifications to all configured channels.
   * Enqueues BullMQ jobs with 5 attempts & exponential backoff.
   * If in offline/test environment, calls transport directly.
   */
  async dispatchNotifications(
    rule: IAlertRule,
    history: IAlertHistory,
    params: {
      kind: 'firing' | 'resolved';
      scopeName: string;
      dashboardLink: string;
      evaluation: ConditionEvaluation;
    },
  ): Promise<void> {
    for (const channelId of rule.channelIds) {
      const channel = await AlertChannelModel.findById(channelId);
      if (!channel) continue;

      const payload = {
        workspaceId: rule.workspaceId.toString(),
        channelId: channel.id,
        kind: params.kind,
        ruleName: rule.name,
        scopeType: rule.scope.type,
        scopeName: params.scopeName,
        metricValueText: params.evaluation.metricText,
        dashboardLink: params.dashboardLink,
        topFailureReasons: params.evaluation.topFailureReasons,
        ...(params.evaluation.windowMinutes !== undefined
          ? { windowMinutes: params.evaluation.windowMinutes }
          : {}),
        ...(params.evaluation.count !== undefined ? { count: params.evaluation.count } : {}),
      };

      try {
        const queue = getAlertsQueue();
        await queue.add('send-alert', {
          historyId: history.id,
          payload,
        });
      } catch {
        // Fallback for direct execution / tests without running BullMQ worker
        const result = await alertTransportService.send(payload);
        history.notifications.push({
          channelId: channel._id as Types.ObjectId,
          kind: result.kind as AlertNotificationKind,
          status: result.status,
          error: result.error || null,
          sentAt: result.sentAt,
        });
        await history.save();
      }
    }
  }

  /**
   * Dry-run evaluation endpoint: POST /alert-rules/:id/test-evaluate
   */
  async testEvaluateRule(ruleId: string, workspaceId: string): Promise<TestEvaluateResult> {
    const rule = await AlertRuleModel.findOne({
      _id: new Types.ObjectId(ruleId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!rule) {
      throw new Error('Alert rule not found');
    }

    const evaluation = await this.evaluateCondition(rule);
    return {
      ruleId: rule.id,
      conditionType: (rule.condition as AlertRuleCondition).type,
      currentValue: evaluation.metricValue,
      wouldFire: evaluation.isTriggered,
      summary: evaluation.metricText,
      topFailureReasons: evaluation.topFailureReasons,
    };
  }
}

export const alertEvaluatorService = new AlertEvaluatorService();
