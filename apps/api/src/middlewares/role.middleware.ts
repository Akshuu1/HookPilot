import type { Request, Response, NextFunction } from 'express';
import { hasRequiredRole, type WorkspaceRole } from '@hookpilot/shared';
import { AppError } from './error-handler.js';
import {
  type MembershipRepository,
  membershipRepository as defaultMembershipRepo,
} from '../repositories/membership.repository.js';

/**
 * Middleware factory requiring a minimum workspace role.
 * Reads the workspace ID from route parameters (req.params.id or req.params.workspaceId).
 */
export function requireRole(
  minRole: WorkspaceRole,
  membershipRepo: MembershipRepository = defaultMembershipRepo,
) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const rawWorkspaceId = req.params.id || req.params.workspaceId;
      if (!rawWorkspaceId) {
        throw new AppError('Workspace ID is required in route', 400, 'WORKSPACE_ID_REQUIRED');
      }
      const workspaceId = String(rawWorkspaceId);

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

      req.membership = membership;
      next();
    } catch (err) {
      next(err);
    }
  };
}
