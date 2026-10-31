import type { Request, Response, NextFunction } from 'express';
import { hasRequiredRole, type WorkspaceRole } from '@hookpilot/shared';
import { AppError } from './error-handler.js';
import { AlertChannelModel, type IAlertChannel } from '../models/AlertChannel.js';
import { AlertRuleModel, type IAlertRule } from '../models/AlertRule.js';
import {
  type MembershipRepository,
  membershipRepository as defaultMembershipRepo,
} from '../repositories/membership.repository.js';
import type { IMembership } from '../models/Membership.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      alertChannel?: IAlertChannel;
      alertRule?: IAlertRule;
      membership?: IMembership;
    }
  }
}

export function requireChannelRole(
  minRole: WorkspaceRole,
  membershipRepo: MembershipRepository = defaultMembershipRepo,
) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const channelId = String(req.params.id);
      if (!channelId) {
        throw new AppError('Alert channel ID is required', 400, 'CHANNEL_ID_REQUIRED');
      }

      const channel = await AlertChannelModel.findById(channelId);
      if (!channel) {
        throw new AppError('Alert channel not found', 404, 'NOT_FOUND');
      }

      const membership = await membershipRepo.findByWorkspaceAndUser(
        channel.workspaceId.toString(),
        req.user.id,
      );

      if (!membership) {
        throw new AppError('You are not a member of this workspace', 403, 'FORBIDDEN');
      }

      if (!hasRequiredRole(membership.role, minRole)) {
        throw new AppError(
          `Forbidden: Role '${membership.role}' does not meet required level '${minRole}'`,
          403,
          'INSUFFICIENT_PERMISSIONS',
        );
      }

      req.alertChannel = channel;
      req.membership = membership;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireRuleRole(
  minRole: WorkspaceRole,
  membershipRepo: MembershipRepository = defaultMembershipRepo,
) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const ruleId = String(req.params.id);
      if (!ruleId) {
        throw new AppError('Alert rule ID is required', 400, 'RULE_ID_REQUIRED');
      }

      const rule = await AlertRuleModel.findById(ruleId);
      if (!rule) {
        throw new AppError('Alert rule not found', 404, 'NOT_FOUND');
      }

      const membership = await membershipRepo.findByWorkspaceAndUser(
        rule.workspaceId.toString(),
        req.user.id,
      );

      if (!membership) {
        throw new AppError('You are not a member of this workspace', 403, 'FORBIDDEN');
      }

      if (!hasRequiredRole(membership.role, minRole)) {
        throw new AppError(
          `Forbidden: Role '${membership.role}' does not meet required level '${minRole}'`,
          403,
          'INSUFFICIENT_PERMISSIONS',
        );
      }

      req.alertRule = rule;
      req.membership = membership;
      next();
    } catch (err) {
      next(err);
    }
  };
}
