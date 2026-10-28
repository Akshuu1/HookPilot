import type { Request, Response, NextFunction } from 'express';
import type { IMembership } from '../models/Membership.js';
import { AppError } from './error-handler.js';
import { verifyAccessToken, type AccessTokenPayload } from '../utils/security.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      membership?: IMembership;
    }
  }
}

export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next(new AppError('Authentication required. Missing Bearer token.', 401, 'UNAUTHORIZED'));
    return;
  }

  const token = authHeader.substring(7).trim();

  try {
    const payload: AccessTokenPayload = verifyAccessToken(token);
    req.user = {
      id: payload.userId,
      email: payload.email,
      name: payload.name,
    };
    next();
  } catch {
    next(new AppError('Invalid or expired access token', 401, 'INVALID_TOKEN'));
  }
}
