import type { Request, Response, NextFunction } from 'express';
import { CreateApiKeyInputSchema } from '@hookpilot/shared';
import {
  ApiKeyService,
  apiKeyService as defaultApiKeyService,
} from '../services/api-key.service.js';
import { AppError } from '../middlewares/error-handler.js';

export class ApiKeyController {
  constructor(private readonly service: ApiKeyService = defaultApiKeyService) {}

  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const workspaceId =
        req.workspaceId || (typeof req.params.id === 'string' ? req.params.id : undefined);
      if (!workspaceId) {
        throw new AppError('Workspace context missing', 400, 'WORKSPACE_MISSING');
      }

      if (!req.user) {
        throw new AppError('User not authenticated', 401, 'UNAUTHORIZED');
      }

      const input = CreateApiKeyInputSchema.parse(req.body);
      const result = await this.service.createApiKey(workspaceId, req.user.id, input);

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const workspaceId =
        req.workspaceId || (typeof req.params.id === 'string' ? req.params.id : undefined);
      if (!workspaceId) {
        throw new AppError('Workspace context missing', 400, 'WORKSPACE_MISSING');
      }

      const keys = await this.service.listApiKeys(workspaceId);
      res.status(200).json({ apiKeys: keys });
    } catch (err) {
      next(err);
    }
  };

  revoke = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const workspaceId =
        req.workspaceId || (typeof req.params.id === 'string' ? req.params.id : undefined);
      const keyId =
        typeof req.params.keyId === 'string'
          ? req.params.keyId
          : typeof req.params.id === 'string'
            ? req.params.id
            : undefined;

      if (!workspaceId || !keyId) {
        throw new AppError('Workspace or key ID missing', 400, 'INVALID_PARAMS');
      }

      await this.service.revokeApiKey(workspaceId, keyId);
      res.status(200).json({ message: 'API key successfully revoked' });
    } catch (err) {
      next(err);
    }
  };
}

export const apiKeyController = new ApiKeyController();
