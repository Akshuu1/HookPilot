import type { Request, Response, NextFunction } from 'express';
import { hasRequiredRole, type WorkspaceRole } from '@hookpilot/shared';
import { AppError } from './error-handler.js';
import { DestinationModel, type IDestination } from '../models/Destination.js';
import {
  type MembershipRepository,
  membershipRepository as defaultMembershipRepo,
} from '../repositories/membership.repository.js';
import type { IMembership } from '../models/Membership.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      destination?: IDestination;
    }
  }
}

export function requireDestinationRole(
  minRole: WorkspaceRole,
  membershipRepo: MembershipRepository = defaultMembershipRepo,
) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const destinationId = String(req.params.id);
      if (!destinationId) {
        throw new AppError('Destination ID is required in route', 400, 'DESTINATION_ID_REQUIRED');
      }

      const destination = await DestinationModel.findById(destinationId);
      if (!destination) {
        throw new AppError('Destination not found', 404, 'NOT_FOUND');
      }

      const membership = await membershipRepo.findByWorkspaceAndUser(
        destination.workspaceId.toString(),
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

      req.destination = destination;
      req.membership = membership as unknown as IMembership;
      next();
    } catch (err) {
      next(err);
    }
  };
}
