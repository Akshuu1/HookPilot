import type { Request, Response, NextFunction, CookieOptions } from 'express';
import { RegisterInputSchema, LoginInputSchema } from '@hookpilot/shared';
import { AuthService, authService as defaultAuthService } from '../services/auth.service.js';
import { env } from '../config/env.js';

const REFRESH_COOKIE_NAME = 'refreshToken';

export const getRefreshCookieOptions = (): CookieOptions => {
  const isProd = env.NODE_ENV === 'production';
  const sameSite = env.COOKIE_SAME_SITE ?? (isProd ? 'none' : 'lax');
  return {
    httpOnly: true,
    secure: isProd || sameSite === 'none',
    sameSite,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/',
  };
};

export const REFRESH_COOKIE_OPTIONS: CookieOptions = getRefreshCookieOptions();

export class AuthController {
  constructor(private readonly service: AuthService = defaultAuthService) {}

  register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const input = RegisterInputSchema.parse(req.body);
      const result = await this.service.register(input);

      res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, getRefreshCookieOptions());
      res.status(201).json({
        user: result.user,
        accessToken: result.accessToken,
      });
    } catch (err) {
      next(err);
    }
  };

  login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const input = LoginInputSchema.parse(req.body);
      const result = await this.service.login(input);

      res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, getRefreshCookieOptions());
      res.status(200).json({
        user: result.user,
        accessToken: result.accessToken,
      });
    } catch (err) {
      next(err);
    }
  };

  refresh = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rawToken = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
      const result = await this.service.refresh(rawToken);

      res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, getRefreshCookieOptions());
      res.status(200).json({
        user: result.user,
        accessToken: result.accessToken,
      });
    } catch (err) {
      // Clear cookie if refresh fails due to reuse or expiry
      res.clearCookie(REFRESH_COOKIE_NAME, { ...getRefreshCookieOptions(), maxAge: undefined });
      next(err);
    }
  };

  logout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rawToken = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
      await this.service.logout(rawToken);

      res.clearCookie(REFRESH_COOKIE_NAME, { ...getRefreshCookieOptions(), maxAge: undefined });
      res.status(200).json({ message: 'Logged out successfully' });
    } catch (err) {
      next(err);
    }
  };

  getMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.getMe(req.user!.id);
      res.status(200).json({ user: result });
    } catch (err) {
      next(err);
    }
  };
}

export const authController = new AuthController();
