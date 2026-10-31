import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { randomState, randomPKCECodeVerifier, calculatePKCECodeChallenge } from 'openid-client';
import { Types } from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getRedisClient } from '../config/redis.js';
import { AppError } from '../middlewares/error-handler.js';
import { IdentityModel } from '../models/Identity.js';
import { UserModel } from '../models/User.js';
import { authService, type AuthTokens } from './auth.service.js';
import { workspaceService } from './workspace.service.js';
import type { OAuthProvider, IdentityResponse } from '@hookpilot/shared';

export interface OAuthStateData {
  state: string;
  codeVerifier: string;
  returnTo: string;
  provider: OAuthProvider;
  linkingUserId?: string | undefined;
  createdAt: number;
}

export interface NormalizedOAuthProfile {
  provider: OAuthProvider;
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface OAuthCallbackResult {
  isLinking: boolean;
  redirectUrl: string;
  tokens?: AuthTokens;
  error?: string;
}

/**
 * Sanitizes returnTo to prevent open redirects.
 * Must start with exactly one '/' and contain no backslashes or protocol-relative prefixes.
 */
export function sanitizeReturnTo(returnTo?: string | null): string {
  if (!returnTo || typeof returnTo !== 'string') return '/';
  const trimmed = returnTo.trim();

  // Must start with exactly one '/' and NOT followed by '/' or '\'
  if (!/^\/[^/\\]/.test(trimmed)) {
    if (trimmed === '/') return '/';
    return '/';
  }

  // Reject backslashes anywhere in path
  if (trimmed.includes('\\')) {
    return '/';
  }

  try {
    const parsed = new URL(trimmed, 'http://localhost');
    if (parsed.origin !== 'http://localhost' || !parsed.pathname.startsWith('/')) {
      return '/';
    }
    return trimmed;
  } catch {
    return '/';
  }
}

/**
 * Constant-time string equality check to prevent timing attacks.
 */
export function safeEqual(a?: string | null, b?: string | null): boolean {
  if (!a || !b || typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export class OAuthService {
  // In-memory fallback for test environment or if Redis is temporarily offline
  private memoryStateStore = new Map<string, OAuthStateData>();

  /**
   * Returns which OAuth providers are configured and enabled.
   */
  getProvidersConfig(): { github: boolean; google: boolean } {
    return {
      github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
      google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    };
  }

  /**
   * Checks if a specific provider is enabled.
   */
  isProviderEnabled(provider: string): provider is OAuthProvider {
    if (provider === 'github') {
      return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
    }
    if (provider === 'google') {
      return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
    }
    return false;
  }

  /**
   * Generates redirect URI matching registered OAuth configuration.
   */
  getRedirectUri(provider: OAuthProvider): string {
    const baseUrl = env.API_PUBLIC_URL.replace(/\/+$/, '');
    return `${baseUrl}/auth/oauth/${provider}/callback`;
  }

  /**
   * Initiates authorization code flow with PKCE and state.
   */
  async startAuthorization(
    provider: string,
    returnToRaw?: string | null,
    linkingUserId?: string,
  ): Promise<{ authorizationUrl: string; state: string }> {
    if (provider !== 'github' && provider !== 'google') {
      throw new AppError(`Unsupported OAuth provider: ${provider}`, 400, 'UNSUPPORTED_PROVIDER');
    }

    if (!this.isProviderEnabled(provider)) {
      throw new AppError(
        `OAuth provider "${provider}" is not configured`,
        400,
        'PROVIDER_DISABLED',
      );
    }

    const state = randomState();
    const codeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    const returnTo = sanitizeReturnTo(returnToRaw);

    const stateData: OAuthStateData = {
      state,
      codeVerifier,
      returnTo,
      provider,
      linkingUserId,
      createdAt: Date.now(),
    };

    // Store state with 10-minute (600s) TTL
    await this.storeState(state, stateData);

    const redirectUri = this.getRedirectUri(provider);
    let authorizationUrl: string;

    if (provider === 'github') {
      const params = new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID!,
        redirect_uri: redirectUri,
        scope: 'read:user user:email',
        state,
      });
      authorizationUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;
    } else {
      // Google OIDC with PKCE
      const params = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID!,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'select_account',
      });
      authorizationUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }

    return { authorizationUrl, state };
  }

  /**
   * Handles the OAuth callback from provider.
   */
  async handleCallback(
    provider: string,
    query: {
      code?: string | undefined;
      state?: string | undefined;
      error?: string | undefined;
      error_description?: string | undefined;
    },
    cookieState?: string | undefined,
  ): Promise<OAuthCallbackResult> {
    const frontendBase = env.FRONTEND_URL.replace(/\/+$/, '');

    // 1. Check for provider access denied / error
    if (query.error) {
      logger.warn({ error: query.error, provider }, 'OAuth provider returned error');
      return {
        isLinking: false,
        redirectUrl: `${frontendBase}/login?error=oauth_denied`,
      };
    }

    if (provider !== 'github' && provider !== 'google') {
      return {
        isLinking: false,
        redirectUrl: `${frontendBase}/login?error=unsupported_provider`,
      };
    }

    const { code, state } = query;
    if (!code || !state) {
      return {
        isLinking: false,
        redirectUrl: `${frontendBase}/login?error=missing_callback_parameters`,
      };
    }

    // 2. Fetch and consume stored state record (single-use enforcement)
    const storedState = await this.consumeState(state);
    if (!storedState) {
      logger.warn({ state, provider }, 'OAuth state not found, expired, or replayed');
      return {
        isLinking: false,
        redirectUrl: `${frontendBase}/login?error=invalid_or_expired_state`,
      };
    }

    // 3. Verify state in constant time against stored state and optional cookie
    if (!safeEqual(storedState.state, state)) {
      logger.warn({ provider }, 'OAuth state mismatch in constant time verification');
      return {
        isLinking: false,
        redirectUrl: `${frontendBase}/login?error=state_mismatch`,
      };
    }

    if (cookieState && !safeEqual(cookieState, state)) {
      logger.warn({ provider }, 'OAuth cookie state mismatch');
      return {
        isLinking: false,
        redirectUrl: `${frontendBase}/login?error=cookie_state_mismatch`,
      };
    }

    if (storedState.provider !== provider) {
      return {
        isLinking: false,
        redirectUrl: `${frontendBase}/login?error=provider_mismatch`,
      };
    }

    const isLinking = Boolean(storedState.linkingUserId);
    const linkingRedirectBase = `${frontendBase}/settings`;

    // 4. Exchange code for tokens and fetch profile
    let profile: NormalizedOAuthProfile;
    try {
      if (provider === 'github') {
        profile = await this.exchangeAndFetchGitHubProfile(code);
      } else {
        profile = await this.exchangeAndFetchGoogleProfile(code, storedState.codeVerifier);
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn({ err, provider }, 'OAuth exchange or profile fetch failed');

      if (errorMsg === 'email_unverified') {
        const target = isLinking ? linkingRedirectBase : `${frontendBase}/login`;
        return {
          isLinking,
          redirectUrl: `${target}?error=email_unverified`,
        };
      }

      const target = isLinking ? linkingRedirectBase : `${frontendBase}/login`;
      return {
        isLinking,
        redirectUrl: `${target}?error=oauth_exchange_failed`,
      };
    }

    // 5. Decision Logic
    const returnTo = sanitizeReturnTo(storedState.returnTo);

    if (isLinking && storedState.linkingUserId) {
      // ----------------------------------------------------------------------
      // Authenticated Account Linking
      // ----------------------------------------------------------------------
      const existingIdentity = await IdentityModel.findOne({
        provider,
        providerUserId: profile.providerUserId,
      });

      if (existingIdentity) {
        if (existingIdentity.userId.toString() !== storedState.linkingUserId) {
          // Provider account is already linked to a different user!
          return {
            isLinking: true,
            redirectUrl: `${linkingRedirectBase}?error=oauth_account_already_linked`,
          };
        }

        // Already linked to current user -> update last login and profile
        existingIdentity.lastLoginAt = new Date();
        existingIdentity.email = profile.email;
        existingIdentity.emailVerified = true;
        if (profile.avatarUrl) existingIdentity.avatarUrl = profile.avatarUrl;
        await existingIdentity.save();

        return {
          isLinking: true,
          redirectUrl: `${linkingRedirectBase}?success=oauth_linked`,
        };
      }

      // Create new identity linked to current user
      await IdentityModel.create({
        userId: new Types.ObjectId(storedState.linkingUserId),
        provider,
        providerUserId: profile.providerUserId,
        email: profile.email,
        emailVerified: true,
        avatarUrl: profile.avatarUrl,
        lastLoginAt: new Date(),
      });

      // Update user display name or avatar if not set
      const currentUser = await UserModel.findById(storedState.linkingUserId);
      if (currentUser) {
        let changed = false;
        if (!currentUser.avatarUrl && profile.avatarUrl) {
          currentUser.avatarUrl = profile.avatarUrl;
          changed = true;
        }
        if (!currentUser.displayName && profile.displayName) {
          currentUser.displayName = profile.displayName;
          changed = true;
        }
        if (changed) await currentUser.save();
      }

      return {
        isLinking: true,
        redirectUrl: `${linkingRedirectBase}?success=oauth_linked`,
      };
    }

    // ------------------------------------------------------------------------
    // Login / Registration Decision Logic
    // ------------------------------------------------------------------------

    // Step 5.1: Check if Identity exists
    const existingIdentity = await IdentityModel.findOne({
      provider,
      providerUserId: profile.providerUserId,
    });

    if (existingIdentity) {
      // Identity exists -> Log in user
      existingIdentity.lastLoginAt = new Date();
      existingIdentity.email = profile.email;
      existingIdentity.emailVerified = true;
      if (profile.avatarUrl) existingIdentity.avatarUrl = profile.avatarUrl;
      await existingIdentity.save();

      const user = await UserModel.findById(existingIdentity.userId);
      if (!user) {
        return {
          isLinking: false,
          redirectUrl: `${frontendBase}/login?error=user_not_found`,
        };
      }

      const tokens = await authService.createTokens(user.id, user.email, user.name);
      return {
        isLinking: false,
        redirectUrl: `${frontendBase}/auth/callback?next=${encodeURIComponent(returnTo)}`,
        tokens,
      };
    }

    // Step 5.2: Check if User with same email exists
    // CRITICAL SECURITY RULE: Do NOT silently link!
    const existingUser = await UserModel.findOne({ email: profile.email });
    if (existingUser) {
      return {
        isLinking: false,
        redirectUrl: `${frontendBase}/login?error=account_exists_use_password`,
      };
    }

    // Step 5.3: New User Registration
    const newUser = new UserModel({
      email: profile.email,
      name: profile.name,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      passwordHash: null,
    });
    await newUser.save();

    await IdentityModel.create({
      userId: newUser._id,
      provider,
      providerUserId: profile.providerUserId,
      email: profile.email,
      emailVerified: true,
      avatarUrl: profile.avatarUrl,
      lastLoginAt: new Date(),
    });

    // Create default workspace for user (same as password registration)
    await workspaceService.createWorkspace(newUser.id, `${newUser.name}'s Workspace`);

    const tokens = await authService.createTokens(newUser.id, newUser.email, newUser.name);

    return {
      isLinking: false,
      redirectUrl: `${frontendBase}/auth/callback?next=${encodeURIComponent(returnTo)}`,
      tokens,
    };
  }

  /**
   * Unlinks an identity from a user account.
   * Refuses if this is the user's last remaining login method.
   */
  async unlinkIdentity(userId: string, identityId: string): Promise<void> {
    const identity = await IdentityModel.findOne({
      _id: new Types.ObjectId(identityId),
      userId: new Types.ObjectId(userId),
    });

    if (!identity) {
      throw new AppError(
        'Identity not found or does not belong to this user',
        404,
        'IDENTITY_NOT_FOUND',
      );
    }

    const user = await UserModel.findById(userId);
    if (!user) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    const hasPassword = Boolean(user.passwordHash);
    const totalIdentities = await IdentityModel.countDocuments({
      userId: new Types.ObjectId(userId),
    });

    // User must always keep at least one login method
    if (!hasPassword && totalIdentities <= 1) {
      throw new AppError(
        'Cannot unlink the last login method for your account. Please set a password or connect another provider first.',
        400,
        'LAST_LOGIN_METHOD',
      );
    }

    await identity.deleteOne();
  }

  /**
   * Returns all identities linked to a user.
   */
  async getUserIdentities(userId: string): Promise<IdentityResponse[]> {
    const identities = await IdentityModel.find({
      userId: new Types.ObjectId(userId),
    }).sort({ createdAt: 1 });

    return identities.map((i) => ({
      id: i._id.toString(),
      provider: i.provider,
      email: i.email,
      avatarUrl: i.avatarUrl,
      createdAt: i.createdAt.toISOString(),
      lastLoginAt: i.lastLoginAt.toISOString(),
    }));
  }

  // --------------------------------------------------------------------------
  // Private Helper Methods
  // --------------------------------------------------------------------------

  private async storeState(state: string, data: OAuthStateData): Promise<void> {
    try {
      const redis = getRedisClient();
      await redis.set(`oauth:state:${state}`, JSON.stringify(data), 'EX', 600);
    } catch {
      // Fallback in-memory
      this.memoryStateStore.set(state, data);
      setTimeout(() => this.memoryStateStore.delete(state), 600 * 1000);
    }
  }

  private async consumeState(state: string): Promise<OAuthStateData | null> {
    try {
      const redis = getRedisClient();
      // Single use: atomic get and delete
      let raw: string | null = null;
      if (
        typeof (redis as unknown as { getdel?: (key: string) => Promise<string | null> }).getdel ===
        'function'
      ) {
        raw = await redis.getdel(`oauth:state:${state}`);
      } else {
        raw = await redis.get(`oauth:state:${state}`);
        if (raw) await redis.del(`oauth:state:${state}`);
      }

      if (raw) return JSON.parse(raw);
    } catch {
      // Fallback memory
    }

    const mem = this.memoryStateStore.get(state) || null;
    if (mem) this.memoryStateStore.delete(state);
    return mem;
  }

  /**
   * Exchanges code with GitHub and fetches verified user email and profile.
   */
  private async exchangeAndFetchGitHubProfile(code: string): Promise<NormalizedOAuthProfile> {
    const redirectUri = this.getRedirectUri('github');

    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      throw new Error(`GitHub token exchange failed: HTTP ${tokenRes.status}`);
    }

    const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenData.access_token) {
      throw new Error(`GitHub did not return an access token: ${tokenData.error || 'unknown'}`);
    }

    const accessToken = tokenData.access_token;

    // Fetch user profile
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'HookPilot-OAuth',
      },
    });

    if (!userRes.ok) {
      throw new Error(`GitHub user profile fetch failed: HTTP ${userRes.status}`);
    }

    const ghUser = (await userRes.json()) as {
      id: number;
      login: string;
      name?: string | null;
      avatar_url?: string | null;
      email?: string | null;
    };

    // Fetch user emails to locate primary verified email
    const emailsRes = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'HookPilot-OAuth',
      },
    });

    let verifiedEmail: string | null = null;
    if (emailsRes.ok) {
      const emailsList = (await emailsRes.json()) as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>;

      // Pick primary verified email, or first verified email
      const primaryVerified = emailsList.find((e) => e.primary && e.verified);
      const anyVerified = emailsList.find((e) => e.verified);
      verifiedEmail = primaryVerified?.email || anyVerified?.email || null;
    }

    if (!verifiedEmail && ghUser.email) {
      // Fallback: check if public email was provided
      verifiedEmail = ghUser.email;
    }

    if (!verifiedEmail) {
      throw new Error('email_unverified');
    }

    const cleanEmail = verifiedEmail.toLowerCase().trim().slice(0, 255);
    const cleanName = (ghUser.name || ghUser.login || 'GitHub User').trim().slice(0, 100);
    const cleanDisplayName = (ghUser.name || ghUser.login || '').trim().slice(0, 100) || null;
    const cleanAvatar = ghUser.avatar_url ? ghUser.avatar_url.trim().slice(0, 1000) : null;

    return {
      provider: 'github',
      providerUserId: String(ghUser.id).slice(0, 255),
      email: cleanEmail,
      emailVerified: true,
      name: cleanName,
      displayName: cleanDisplayName,
      avatarUrl: cleanAvatar,
    };
  }

  /**
   * Exchanges code with Google using PKCE and validates ID token claims.
   */
  private async exchangeAndFetchGoogleProfile(
    code: string,
    codeVerifier: string,
  ): Promise<NormalizedOAuthProfile> {
    const redirectUri = this.getRedirectUri('google');

    const formBody = new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    });

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody.toString(),
    });

    if (!tokenRes.ok) {
      throw new Error(`Google token exchange failed: HTTP ${tokenRes.status}`);
    }

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      id_token?: string;
      error?: string;
    };

    if (!tokenData.id_token) {
      throw new Error(`Google did not return an ID token: ${tokenData.error || 'unknown'}`);
    }

    // Decode ID token payload claims
    const decoded = jwt.decode(tokenData.id_token) as {
      sub?: string;
      email?: string;
      email_verified?: boolean | string;
      name?: string;
      picture?: string;
    } | null;

    if (!decoded || !decoded.sub || !decoded.email) {
      throw new Error('Google ID token missing required claims (sub or email)');
    }

    const isVerified = decoded.email_verified === true || decoded.email_verified === 'true';
    if (!isVerified) {
      throw new Error('email_unverified');
    }

    const cleanEmail = decoded.email.toLowerCase().trim().slice(0, 255);
    const cleanName = (decoded.name || cleanEmail.split('@')[0] || 'Google User')
      .trim()
      .slice(0, 100);
    const cleanDisplayName = decoded.name?.trim().slice(0, 100) || null;
    const cleanAvatar = decoded.picture ? decoded.picture.trim().slice(0, 1000) : null;

    return {
      provider: 'google',
      providerUserId: String(decoded.sub).slice(0, 255),
      email: cleanEmail,
      emailVerified: true,
      name: cleanName,
      displayName: cleanDisplayName,
      avatarUrl: cleanAvatar,
    };
  }
}

export const oauthService = new OAuthService();
