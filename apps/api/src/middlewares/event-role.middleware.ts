import type { Request, Response, NextFunction } from 'express';
import { hasRequiredRole, type WorkspaceRole } from '@hookpilot/shared';
import { AppError } from './error-handler.js';
import {
  type EventRepository,
  eventRepository as defaultEventRepo,
} from '../repositories/event.repository.js';
import {
  type MembershipRepository,
  membershipRepository as defaultMembershipRepo,
} from '../repositories/membership.repository.js';
import type { IEvent } from '../models/Event.js';
import type { IMembership } from '../models/Membership.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      event?: IEvent;
    }
  }
}

/**
 * Middleware factory requiring a minimum role on the workspace owning the target event.
 * Reads event ID from req.params.id.
 */
export function requireEventRole(
  minRole: WorkspaceRole,
  eventRepo: EventRepository = defaultEventRepo,
  membershipRepo: MembershipRepository = defaultMembershipRepo,
) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const eventId = String(req.params.id);
      if (!eventId) {
        throw new AppError('Event ID is required in route', 400, 'EVENT_ID_REQUIRED');
      }

      const event = await eventRepo.findById(eventId);
      if (!event) {
        throw new AppError('Event not found', 404, 'NOT_FOUND');
      }

      const membership = await membershipRepo.findByWorkspaceAndUser(
        event.workspaceId.toString(),
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

      req.event = event;
      req.membership = membership as IMembership;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Middleware factory requiring a minimum role on the workspace specified in the request body (for bulk operations).
 */
export function requireBodyWorkspaceRole(
  minRole: WorkspaceRole,
  membershipRepo: MembershipRepository = defaultMembershipRepo,
) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
      if (!workspaceId) {
        throw new AppError('workspaceId is required in request body', 400, 'WORKSPACE_ID_REQUIRED');
      }

      const membership = await membershipRepo.findByWorkspaceAndUser(workspaceId, req.user.id);
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

      req.membership = membership as IMembership;
      next();
    } catch (err) {
      next(err);
    }
  };
}
