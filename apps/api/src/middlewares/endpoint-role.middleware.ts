import type { Request, Response, NextFunction } from 'express';
import { hasRequiredRole, type WorkspaceRole } from '@hookpilot/shared';
import { AppError } from './error-handler.js';
import {
  type EndpointRepository,
  endpointRepository as defaultEndpointRepo,
} from '../repositories/endpoint.repository.js';
import {
  type MembershipRepository,
  membershipRepository as defaultMembershipRepo,
} from '../repositories/membership.repository.js';
import type { IEndpoint } from '../models/Endpoint.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      endpoint?: IEndpoint;
    }
  }
}

/**
 * Middleware factory requiring a minimum role on the workspace owning the target endpoint.
 * Reads the endpoint ID from req.params.id.
 */
export function requireEndpointRole(
  minRole: WorkspaceRole,
  endpointRepo: EndpointRepository = defaultEndpointRepo,
  membershipRepo: MembershipRepository = defaultMembershipRepo,
) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const endpointId = String(req.params.id);
      if (!endpointId) {
        throw new AppError('Endpoint ID is required in route', 400, 'ENDPOINT_ID_REQUIRED');
      }

      const endpoint = await endpointRepo.findById(endpointId);
      if (!endpoint) {
        throw new AppError('Endpoint not found', 404, 'NOT_FOUND');
      }

      const membership = await membershipRepo.findByWorkspaceAndUser(
        endpoint.workspaceId.toString(),
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

      req.endpoint = endpoint;
      req.membership = membership;
      next();
    } catch (err) {
      next(err);
    }
  };
}
