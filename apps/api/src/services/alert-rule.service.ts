import { Types } from 'mongoose';
import {
  type AlertRuleResponse,
  type AlertHistoryResponse,
  type AlertRuleCondition,
  type AlertRuleScope,
  type TestEvaluateResult,
} from '@hookpilot/shared';
import { AppError } from '../middlewares/error-handler.js';
import { AlertRuleModel, type IAlertRule } from '../models/AlertRule.js';
import { AlertStateModel, type IAlertState } from '../models/AlertState.js';
import { AlertHistoryModel } from '../models/AlertHistory.js';
import { AlertChannelModel } from '../models/AlertChannel.js';
import { EndpointModel } from '../models/Endpoint.js';
import { DestinationModel } from '../models/Destination.js';
import { alertEvaluatorService } from './alert-evaluator.service.js';

export function mapAlertRuleResponse(
  rule: IAlertRule,
  state?: IAlertState | null,
): AlertRuleResponse {
  return {
    id: rule._id.toString(),
    workspaceId: rule.workspaceId.toString(),
    name: rule.name,
    enabled: rule.enabled,
    scope: rule.scope,
    condition: rule.condition as AlertRuleCondition,
    channelIds: (rule.channelIds || []).map((c) => c.toString()),
    cooldownMinutes: rule.cooldownMinutes,
    notifyOnResolve: rule.notifyOnResolve,
    createdBy: rule.createdBy.toString(),
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
    ...(state
      ? {
          state: {
            status: state.status,
            consecutiveClear: state.consecutiveClear,
            lastValue: state.lastValue,
            lastFiredAt: state.lastFiredAt ? state.lastFiredAt.toISOString() : null,
            lastNotifiedAt: state.lastNotifiedAt ? state.lastNotifiedAt.toISOString() : null,
            lastResolvedAt: state.lastResolvedAt ? state.lastResolvedAt.toISOString() : null,
          },
        }
      : {}),
  };
}

export class AlertRuleService {
  private async validateScope(workspaceId: string, scope: AlertRuleScope): Promise<void> {
    if (scope.type === 'workspace') return;

    if (!scope.id || !Types.ObjectId.isValid(scope.id)) {
      throw new AppError(`A valid ${scope.type} ID must be provided`, 400, 'INVALID_SCOPE_ID');
    }

    if (scope.type === 'endpoint') {
      const ep = await EndpointModel.findOne({
        _id: new Types.ObjectId(scope.id),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!ep) {
        throw new AppError(
          'Specified endpoint not found in workspace',
          404,
          'SCOPE_ENDPOINT_NOT_FOUND',
        );
      }
    } else if (scope.type === 'destination') {
      const dest = await DestinationModel.findOne({
        _id: new Types.ObjectId(scope.id),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!dest) {
        throw new AppError(
          'Specified destination not found in workspace',
          404,
          'SCOPE_DESTINATION_NOT_FOUND',
        );
      }
    }
  }

  private async validateChannels(
    workspaceId: string,
    channelIds: string[],
  ): Promise<Types.ObjectId[]> {
    const objectIds: Types.ObjectId[] = [];
    for (const cid of channelIds) {
      if (!Types.ObjectId.isValid(cid)) {
        throw new AppError(`Invalid channel ID: ${cid}`, 400, 'INVALID_CHANNEL_ID');
      }
      objectIds.push(new Types.ObjectId(cid));
    }

    const channels = await AlertChannelModel.find({
      _id: { $in: objectIds },
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (channels.length !== objectIds.length) {
      throw new AppError(
        'One or more alert channels were not found in this workspace',
        404,
        'CHANNEL_NOT_FOUND',
      );
    }

    for (const ch of channels) {
      if (!ch.verifiedAt) {
        throw new AppError(
          `Channel "${ch.name}" has not passed a test verification. Please run a test on the channel before using it in a rule.`,
          400,
          'CHANNEL_UNVERIFIED',
        );
      }
    }

    return objectIds;
  }

  async createRule(
    workspaceId: string,
    userId: string,
    data: {
      name: string;
      enabled?: boolean;
      scope: AlertRuleScope;
      condition: AlertRuleCondition;
      channelIds: string[];
      cooldownMinutes?: number;
      notifyOnResolve?: boolean;
    },
  ): Promise<AlertRuleResponse> {
    await this.validateScope(workspaceId, data.scope);
    const validChannelIds = await this.validateChannels(workspaceId, data.channelIds);

    const rule = new AlertRuleModel({
      workspaceId: new Types.ObjectId(workspaceId),
      name: data.name.trim(),
      enabled: data.enabled ?? true,
      scope: data.scope,
      condition: data.condition,
      channelIds: validChannelIds,
      cooldownMinutes: data.cooldownMinutes ?? 30,
      notifyOnResolve: data.notifyOnResolve ?? true,
      createdBy: new Types.ObjectId(userId),
    });

    await rule.save();

    const state = new AlertStateModel({
      ruleId: rule._id,
      status: 'ok',
      consecutiveClear: 0,
    });
    await state.save();

    return mapAlertRuleResponse(rule, state);
  }

  async listRules(workspaceId: string): Promise<AlertRuleResponse[]> {
    const rules = await AlertRuleModel.find({
      workspaceId: new Types.ObjectId(workspaceId),
    }).sort({ createdAt: -1 });

    const ruleIds = rules.map((r) => r._id);
    const states = await AlertStateModel.find({ ruleId: { $in: ruleIds } });
    const stateMap = new Map(states.map((s) => [s.ruleId.toString(), s]));

    return rules.map((r) => mapAlertRuleResponse(r, stateMap.get(r.id)));
  }

  async getRuleById(ruleId: string, workspaceId: string): Promise<AlertRuleResponse> {
    const rule = await AlertRuleModel.findOne({
      _id: new Types.ObjectId(ruleId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!rule) {
      throw new AppError('Alert rule not found', 404, 'RULE_NOT_FOUND');
    }

    const state = await AlertStateModel.findOne({ ruleId: rule._id });
    return mapAlertRuleResponse(rule, state);
  }

  async updateRule(
    ruleId: string,
    workspaceId: string,
    data: {
      name?: string | undefined;
      enabled?: boolean | undefined;
      scope?: AlertRuleScope | undefined;
      condition?: AlertRuleCondition | undefined;
      channelIds?: string[] | undefined;
      cooldownMinutes?: number | undefined;
      notifyOnResolve?: boolean | undefined;
    },
  ): Promise<AlertRuleResponse> {
    const rule = await AlertRuleModel.findOne({
      _id: new Types.ObjectId(ruleId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!rule) {
      throw new AppError('Alert rule not found', 404, 'RULE_NOT_FOUND');
    }

    if (data.name !== undefined) rule.name = data.name.trim();
    if (data.enabled !== undefined) rule.enabled = data.enabled;
    if (data.cooldownMinutes !== undefined) rule.cooldownMinutes = data.cooldownMinutes;
    if (data.notifyOnResolve !== undefined) rule.notifyOnResolve = data.notifyOnResolve;

    if (data.scope !== undefined) {
      await this.validateScope(workspaceId, data.scope);
      rule.scope = data.scope;
    }

    if (data.condition !== undefined) {
      rule.condition = data.condition;
    }

    if (data.channelIds !== undefined) {
      rule.channelIds = await this.validateChannels(workspaceId, data.channelIds);
    }

    await rule.save();
    const state = await AlertStateModel.findOne({ ruleId: rule._id });
    return mapAlertRuleResponse(rule, state);
  }

  async deleteRule(ruleId: string, workspaceId: string): Promise<void> {
    const rule = await AlertRuleModel.findOne({
      _id: new Types.ObjectId(ruleId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!rule) {
      throw new AppError('Alert rule not found', 404, 'RULE_NOT_FOUND');
    }

    await AlertStateModel.deleteOne({ ruleId: rule._id });
    await rule.deleteOne();
  }

  async getRuleHistory(
    ruleId: string,
    workspaceId: string,
    limit = 50,
  ): Promise<AlertHistoryResponse[]> {
    const rule = await AlertRuleModel.findOne({
      _id: new Types.ObjectId(ruleId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!rule) {
      throw new AppError('Alert rule not found', 404, 'RULE_NOT_FOUND');
    }

    const histories = await AlertHistoryModel.find({
      ruleId: rule._id,
      workspaceId: new Types.ObjectId(workspaceId),
    })
      .sort({ firedAt: -1 })
      .limit(limit);

    return histories.map((h) => ({
      id: h._id.toString(),
      workspaceId: h.workspaceId.toString(),
      ruleId: h.ruleId.toString(),
      firedAt: h.firedAt.toISOString(),
      resolvedAt: h.resolvedAt ? h.resolvedAt.toISOString() : null,
      value: h.value,
      summary: h.summary,
      notifications: (h.notifications || []).map((n) => ({
        channelId: n.channelId.toString(),
        kind: n.kind,
        status: n.status,
        error: n.error || null,
        sentAt: n.sentAt.toISOString(),
      })),
      createdAt: h.createdAt.toISOString(),
    }));
  }

  async testEvaluate(ruleId: string, workspaceId: string): Promise<TestEvaluateResult> {
    return alertEvaluatorService.testEvaluateRule(ruleId, workspaceId);
  }
}

export const alertRuleService = new AlertRuleService();
