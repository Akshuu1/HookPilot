import type { Request, Response, NextFunction } from 'express';
import { apiKeyService } from '../services/api-key.service.js';
import { AppError } from './error-handler.js';
import type { IApiKey } from '../models/ApiKey.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: IApiKey;
      workspaceId?: string;
    }
  }
}

export async function apiKeyAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    let key: string | undefined;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      key = authHeader.slice(7).trim();
    } else if (req.headers['x-api-key']) {
      key = Array.isArray(req.headers['x-api-key'])
        ? req.headers['x-api-key'][0]
        : req.headers['x-api-key'];
    }

    if (!key) {
      throw new AppError(
        'Authentication required. Missing API key in Authorization or X-API-Key header.',
        401,
        'API_KEY_REQUIRED',
      );
    }

    const { apiKey, workspaceId } = await apiKeyService.verifyApiKey(key);
    req.workspaceId = workspaceId;
    req.apiKey = apiKey;

    next();
  } catch (err) {
    next(err);
  }
}
