import type { Request, Response, NextFunction, CookieOptions } from 'express';
import { oauthService, type OAuthService } from '../services/oauth.service.js';
import { getRefreshCookieOptions, REFRESH_COOKIE_NAME } from './auth.controller.js';
import { env } from '../config/env.js';

export const OAUTH_COOKIE_NAME = 'oauth_state';

export const getOAuthCookieOptions = (): CookieOptions => {
  const isProd = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000, // 10 minutes
    path: '/',
    signed: true,
  };
};

export class OAuthController {
  constructor(private readonly service: OAuthService = oauthService) {}

  /**
   * GET /auth/oauth/:provider/start?returnTo=/path
   */
  start = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const provider = String(req.params.provider).toLowerCase();
      const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : null;

      const { authorizationUrl, state } = await this.service.startAuthorization(provider, returnTo);

      res.cookie(OAUTH_COOKIE_NAME, state, getOAuthCookieOptions());

      if (req.query.json === 'true' || req.headers.accept?.includes('application/json')) {
        res.status(200).json({ url: authorizationUrl, state });
        return;
      }

      res.redirect(authorizationUrl);
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /auth/oauth/:provider/link-start
   * Authenticated user links a provider to their current account
   */
  linkStart = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const provider = String(req.params.provider).toLowerCase();
      const returnTo = typeof req.body?.returnTo === 'string' ? req.body.returnTo : '/settings';

      const { authorizationUrl, state } = await this.service.startAuthorization(
        provider,
        returnTo,
        req.user!.id,
      );

      res.cookie(OAUTH_COOKIE_NAME, state, getOAuthCookieOptions());

      res.status(200).json({ url: authorizationUrl, state });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /auth/oauth/:provider/callback
   */
  callback = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const provider = String(req.params.provider).toLowerCase();
      const cookieState =
        (req.signedCookies?.[OAUTH_COOKIE_NAME] as string | undefined) ||
        (req.cookies?.[OAUTH_COOKIE_NAME] as string | undefined);

      // Always clear state cookie on callback to enforce single use
      res.clearCookie(OAUTH_COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      });

      const result = await this.service.handleCallback(
        provider,
        {
          code: typeof req.query.code === 'string' ? req.query.code : undefined,
          state: typeof req.query.state === 'string' ? req.query.state : undefined,
          error: typeof req.query.error === 'string' ? req.query.error : undefined,
          error_description:
            typeof req.query.error_description === 'string'
              ? req.query.error_description
              : undefined,
        },
        cookieState,
      );

      if (result.tokens) {
        // Issue refresh token cookie with same flags as password login
        res.cookie(REFRESH_COOKIE_NAME, result.tokens.refreshToken, getRefreshCookieOptions());
      }

      // Redirect without exposing tokens or authorization codes in URLs
      res.redirect(result.redirectUrl);
    } catch (err) {
      next(err);
    }
  };

  /**
   * DELETE /auth/identities/:id
   * Unlinks an identity from the user account
   */
  unlink = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const identityId = String(req.params.id);
      await this.service.unlinkIdentity(req.user!.id, identityId);
      res.status(200).json({ success: true, message: 'Identity unlinked successfully' });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /auth/providers
   * Returns configured OAuth providers
   */
  getProviders = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const providers = this.service.getProvidersConfig();
      res.status(200).json({ providers });
    } catch (err) {
      next(err);
    }
  };
}

export const oauthController = new OAuthController();
