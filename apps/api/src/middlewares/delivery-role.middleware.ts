import type { Request, Response, NextFunction } from 'express';
import { hasRequiredRole, type WorkspaceRole } from '@hookpilot/shared';
import { AppError } from './error-handler.js';
import { DeliveryModel, type IDelivery } from '../models/Delivery.js';
import {
  type MembershipRepository,
  membershipRepository as defaultMembershipRepo,
} from '../repositories/membership.repository.js';
import type { IMembership } from '../models/Membership.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      delivery?: IDelivery;
    }
  }
}

export function requireDeliveryRole(
  minRole: WorkspaceRole,
  membershipRepo: MembershipRepository = defaultMembershipRepo,
) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const deliveryId = String(req.params.id);
      if (!deliveryId) {
        throw new AppError('Delivery ID is required in route', 400, 'DELIVERY_ID_REQUIRED');
      }

      const delivery = await DeliveryModel.findById(deliveryId);
      if (!delivery) {
        throw new AppError('Delivery not found', 404, 'NOT_FOUND');
      }

      const membership = await membershipRepo.findByWorkspaceAndUser(
        delivery.workspaceId.toString(),
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

      req.delivery = delivery;
      req.membership = membership as unknown as IMembership;
      next();
    } catch (err) {
      next(err);
    }
  };
}
