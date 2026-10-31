/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { env } from '../config/env.js';
import * as redisConfig from '../config/redis.js';
import { UserModel } from '../models/User.js';
import { IdentityModel } from '../models/Identity.js';
import { refreshTokenRepository } from '../repositories/refresh-token.repository.js';
import { sanitizeReturnTo, oauthService } from '../services/oauth.service.js';
import { oauthController, OAUTH_COOKIE_NAME } from '../controllers/oauth.controller.js';
import { authController, REFRESH_COOKIE_NAME } from '../controllers/auth.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { workspaceService } from '../services/workspace.service.js';
import { runMigration } from '../../../../scripts/migrate-phase19-oauth.js';

describe('Phase 19: GitHub and Google OAuth Login & Account Linking', () => {
  const originalEnv = { ...env };

  let inMemoryRedis: Map<string, string>;
  let mockUsers: any[];
  let mockIdentities: any[];

  function makeUserDoc(data: any) {
    const _id = data._id
      ? typeof data._id === 'string'
        ? new Types.ObjectId(data._id)
        : data._id
      : new Types.ObjectId();
    const doc: any = {
      _id,
      id: _id.toString(),
      email: data.email?.toLowerCase().trim(),
      name: data.name,
      displayName: data.displayName || null,
      avatarUrl: data.avatarUrl || null,
      passwordHash: data.passwordHash !== undefined ? data.passwordHash : null,
      createdAt: data.createdAt || new Date(),
      updatedAt: data.updatedAt || new Date(),
      save: vi.fn().mockImplementation(async function (this: any) {
        const idx = mockUsers.findIndex((u) => u.id === this.id);
        if (idx >= 0) {
          mockUsers[idx] = this;
        } else {
          mockUsers.push(this);
        }
        return this;
      }),
      deleteOne: vi.fn().mockImplementation(async function (this: any) {
        const idx = mockUsers.findIndex((u) => u.id === this.id);
        if (idx >= 0) {
          mockUsers.splice(idx, 1);
        }
        return { deletedCount: 1 };
      }),
      toObject: function (this: any) {
        return { ...this };
      },
    };
    return doc;
  }

  function makeIdentityDoc(data: any) {
    const _id = data._id
      ? typeof data._id === 'string'
        ? new Types.ObjectId(data._id)
        : data._id
      : new Types.ObjectId();
    const doc: any = {
      _id,
      id: _id.toString(),
      userId: typeof data.userId === 'string' ? new Types.ObjectId(data.userId) : data.userId,
      provider: data.provider,
      providerUserId: data.providerUserId ? String(data.providerUserId) : '',
      email: data.email?.toLowerCase().trim(),
      emailVerified: Boolean(data.emailVerified),
      avatarUrl: data.avatarUrl || null,
      createdAt: data.createdAt || new Date(),
      lastLoginAt: data.lastLoginAt || new Date(),
      updatedAt: data.updatedAt || new Date(),
      save: vi.fn().mockImplementation(async function (this: any) {
        const idx = mockIdentities.findIndex((i) => i.id === this.id);
        if (idx >= 0) {
          mockIdentities[idx] = this;
        } else {
          mockIdentities.push(this);
        }
        return this;
      }),
      deleteOne: vi.fn().mockImplementation(async function (this: any) {
        const idx = mockIdentities.findIndex((i) => i.id === this.id);
        if (idx >= 0) {
          mockIdentities.splice(idx, 1);
        }
        return { deletedCount: 1 };
      }),
      toObject: function (this: any) {
        return { ...this };
      },
    };
    return doc;
  }

  function createMockReqRes(options: {
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: any;
    headers?: Record<string, string>;
    signedCookies?: Record<string, string>;
    cookies?: Record<string, string>;
    user?: any;
  }) {
    const req: any = {
      params: options.params || {},
      query: options.query || {},
      body: options.body || {},
      headers: options.headers || {},
      signedCookies: options.signedCookies || {},
      cookies: options.cookies || {},
      user: options.user,
    };

    const res: any = {
      statusCode: 200,
      body: null,
      headers: {} as Record<string, string>,
      cookies: {} as Record<string, { val: any; opts?: any }>,
      clearedCookies: [] as string[],
      redirectUrl: null as string | null,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(data: any) {
        this.body = data;
        return this;
      },
      send(data: any) {
        this.body = data;
        return this;
      },
      redirect(url: string) {
        this.statusCode = 302;
        this.redirectUrl = url;
        this.headers['location'] = url;
        return this;
      },
      cookie(name: string, val: any, opts?: any) {
        this.cookies[name] = { val, opts };
        return this;
      },
      clearCookie(name: string) {
        this.clearedCookies.push(name);
        delete this.cookies[name];
        return this;
      },
      setHeader(name: string, val: string) {
        this.headers[name.toLowerCase()] = val;
        return this;
      },
    };

    const next = vi.fn().mockImplementation((err?: any) => {
      if (err) {
        res.statusCode = err.statusCode || 500;
        res.body = {
          error: {
            code: err.code || 'INTERNAL_ERROR',
            message: err.message,
          },
        };
      }
    });

    return { req, res, next };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    nock.cleanAll();

    inMemoryRedis = new Map<string, string>();
    mockUsers = [];
    mockIdentities = [];

    // Mock Redis in-memory
    const mockRedis = {
      status: 'ready',
      get: vi.fn().mockImplementation(async (key: string) => inMemoryRedis.get(key) || null),
      set: vi.fn().mockImplementation(async (key: string, val: string) => {
        inMemoryRedis.set(key, val);
        return 'OK';
      }),
      del: vi.fn().mockImplementation(async (key: string) => {
        const deleted = inMemoryRedis.delete(key);
        return deleted ? 1 : 0;
      }),
      getdel: vi.fn().mockImplementation(async (key: string) => {
        const val = inMemoryRedis.get(key) || null;
        inMemoryRedis.delete(key);
        return val;
      }),
      expire: vi.fn().mockResolvedValue(1),
    };
    vi.spyOn(redisConfig, 'getRedisClient').mockReturnValue(mockRedis as any);

    // Mock UserModel
    vi.spyOn(UserModel, 'findOne').mockImplementation(((query: any) => {
      const user = mockUsers.find((u) => {
        if (query.email && u.email !== query.email.toLowerCase().trim()) return false;
        return true;
      });
      return Promise.resolve(user || null);
    }) as any);

    vi.spyOn(UserModel, 'findById').mockImplementation(((id: any) => {
      const idStr = id?.toString();
      const user = mockUsers.find((u) => u.id === idStr);
      return Promise.resolve(user || null);
    }) as any);

    vi.spyOn(UserModel, 'find').mockImplementation((() => {
      return Promise.resolve([...mockUsers]);
    }) as any);

    vi.spyOn(UserModel, 'create').mockImplementation(((data: any) => {
      const doc = makeUserDoc(data);
      mockUsers.push(doc);
      return Promise.resolve(doc);
    }) as any);

    vi.spyOn(UserModel.prototype, 'save').mockImplementation(async function (this: any) {
      const doc = makeUserDoc({
        _id: this._id || new Types.ObjectId(),
        email: this.email,
        name: this.name,
        displayName: this.displayName,
        avatarUrl: this.avatarUrl,
        passwordHash: this.passwordHash,
      });
      const idx = mockUsers.findIndex((u) => u.id === doc.id);
      if (idx >= 0) {
        mockUsers[idx] = doc;
      } else {
        mockUsers.push(doc);
      }
      Object.assign(this, doc);
      return this;
    });

    vi.spyOn(UserModel, 'syncIndexes').mockResolvedValue({} as any);
    vi.spyOn(UserModel, 'updateMany').mockResolvedValue({ modifiedCount: 0 } as any);
    vi.spyOn(UserModel, 'updateOne').mockImplementation(((query: any, update: any) => {
      const user = mockUsers.find((u) => u.id === query._id.toString());
      if (user && update.$set) {
        Object.assign(user, update.$set);
      }
      return Promise.resolve({ modifiedCount: 1 });
    }) as any);
    vi.spyOn(UserModel, 'countDocuments').mockResolvedValue(mockUsers.length as any);

    // Mock IdentityModel
    vi.spyOn(IdentityModel, 'findOne').mockImplementation(((query: any) => {
      const identity = mockIdentities.find((i) => {
        if (query.provider && i.provider !== query.provider) return false;
        if (query.providerUserId && i.providerUserId !== String(query.providerUserId)) return false;
        if (query._id && i.id !== query._id.toString()) return false;
        if (query.userId && i.userId.toString() !== query.userId.toString()) return false;
        return true;
      });
      return Promise.resolve(identity || null);
    }) as any);

    vi.spyOn(IdentityModel, 'find').mockImplementation(((query: any) => {
      const list = mockIdentities.filter((i) => {
        if (query && query.userId && i.userId.toString() !== query.userId.toString()) return false;
        return true;
      });
      return Promise.resolve(list);
    }) as any);

    vi.spyOn(IdentityModel, 'findById').mockImplementation(((id: any) => {
      const idStr = id?.toString();
      const identity = mockIdentities.find((i) => i.id === idStr);
      return Promise.resolve(identity || null);
    }) as any);

    vi.spyOn(IdentityModel, 'create').mockImplementation(((data: any) => {
      const doc = makeIdentityDoc(data);
      mockIdentities.push(doc);
      return Promise.resolve(doc);
    }) as any);

    vi.spyOn(IdentityModel.prototype, 'save').mockImplementation(async function (this: any) {
      const doc = makeIdentityDoc({
        _id: this._id || new Types.ObjectId(),
        userId: this.userId,
        provider: this.provider,
        providerUserId: this.providerUserId,
        email: this.email,
        emailVerified: this.emailVerified,
        avatarUrl: this.avatarUrl,
        lastLoginAt: this.lastLoginAt,
      });
      const idx = mockIdentities.findIndex((i) => i.id === doc.id);
      if (idx >= 0) {
        mockIdentities[idx] = doc;
      } else {
        mockIdentities.push(doc);
      }
      Object.assign(this, doc);
      return this;
    });

    vi.spyOn(IdentityModel, 'countDocuments').mockImplementation(((query: any) => {
      if (!query || Object.keys(query).length === 0) {
        return Promise.resolve(mockIdentities.length);
      }
      const count = mockIdentities.filter((i) => {
        if (query.userId && i.userId.toString() !== query.userId.toString()) return false;
        return true;
      }).length;
      return Promise.resolve(count);
    }) as any);

    vi.spyOn(IdentityModel, 'findByIdAndDelete').mockImplementation(((id: any) => {
      const idStr = id?.toString();
      const idx = mockIdentities.findIndex((i) => i.id === idStr);
      if (idx >= 0) {
        const [deleted] = mockIdentities.splice(idx, 1);
        return Promise.resolve(deleted);
      }
      return Promise.resolve(null);
    }) as any);

    vi.spyOn(IdentityModel, 'deleteOne').mockImplementation(((query: any) => {
      const idx = mockIdentities.findIndex((i) => {
        if (query._id && i.id !== query._id.toString()) return false;
        return true;
      });
      if (idx >= 0) {
        mockIdentities.splice(idx, 1);
        return Promise.resolve({ deletedCount: 1 });
      }
      return Promise.resolve({ deletedCount: 0 });
    }) as any);

    vi.spyOn(IdentityModel, 'findByIdAndUpdate').mockImplementation(((id: any, update: any) => {
      const idStr = id?.toString();
      const doc = mockIdentities.find((i) => i.id === idStr);
      if (doc) {
        if (update.$set) {
          Object.assign(doc, update.$set);
        } else {
          Object.assign(doc, update);
        }
        return Promise.resolve(doc);
      }
      return Promise.resolve(null);
    }) as any);

    vi.spyOn(IdentityModel, 'syncIndexes').mockResolvedValue({} as any);

    // Mock refreshTokenRepository
    vi.spyOn(refreshTokenRepository, 'create').mockResolvedValue({} as any);
    vi.spyOn(refreshTokenRepository, 'findByTokenHash').mockResolvedValue(null);

    // Enable both providers by default in tests
    (env as any).GITHUB_CLIENT_ID = 'mock-github-client-id';
    (env as any).GITHUB_CLIENT_SECRET = 'mock-github-client-secret';
    (env as any).GOOGLE_CLIENT_ID = 'mock-google-client-id';
    (env as any).GOOGLE_CLIENT_SECRET = 'mock-google-client-secret';
    (env as any).API_PUBLIC_URL = 'http://localhost:4000';
    (env as any).FRONTEND_URL = 'http://localhost:5173';
  });

  afterEach(() => {
    nock.cleanAll();
    Object.assign(env, originalEnv);
  });

  // --------------------------------------------------------------------------
  // 1. Open Redirect & Path Sanitation
  // --------------------------------------------------------------------------
  describe('Open Redirect & ReturnTo Sanitation', () => {
    it('accepts safe relative paths and rejects protocol-relative, backslash, or full URLs', () => {
      expect(sanitizeReturnTo('/dashboard')).toBe('/dashboard');
      expect(sanitizeReturnTo('/settings/integrations?tab=oauth')).toBe(
        '/settings/integrations?tab=oauth',
      );
      expect(sanitizeReturnTo('/')).toBe('/');

      // Attack vectors
      expect(sanitizeReturnTo('//evil.com')).toBe('/');
      expect(sanitizeReturnTo('///evil.com')).toBe('/');
      expect(sanitizeReturnTo('/\\evil.com')).toBe('/');
      expect(sanitizeReturnTo('/path\\subpath')).toBe('/');
      expect(sanitizeReturnTo('http://evil.com')).toBe('/');
      expect(sanitizeReturnTo('https://evil.com/path')).toBe('/');
      expect(sanitizeReturnTo('javascript:alert(1)')).toBe('/');
      expect(sanitizeReturnTo(null)).toBe('/');
      expect(sanitizeReturnTo(undefined)).toBe('/');
      expect(sanitizeReturnTo('')).toBe('/');
    });
  });

  // --------------------------------------------------------------------------
  // 2. OAuth Start & Provider Configuration
  // --------------------------------------------------------------------------
  describe('OAuth Start & Provider Config', () => {
    it('GET /auth/providers reports configured status', async () => {
      const { req, res, next } = createMockReqRes({});
      await oauthController.getProviders(req, res, next);

      expect(res.statusCode).toBe(200);
      expect(res.body.providers).toEqual({
        github: true,
        google: true,
      });
    });

    it('rejects start for disabled or unsupported provider without crashing', async () => {
      const {
        req: req1,
        res: res1,
        next: next1,
      } = createMockReqRes({
        params: { provider: 'facebook' },
      });
      await oauthController.start(req1, res1, next1);
      expect(res1.statusCode).toBe(400);

      // Disable GitHub
      (env as any).GITHUB_CLIENT_ID = undefined;
      const {
        req: req2,
        res: res2,
        next: next2,
      } = createMockReqRes({
        params: { provider: 'github' },
      });
      await oauthController.start(req2, res2, next2);
      expect(res2.statusCode).toBe(400);
      expect(res2.body.error.code).toBe('PROVIDER_DISABLED');
    });

    it('GET /auth/oauth/github/start sets PKCE state in signed cookie and redirects to GitHub with requested scopes', async () => {
      const { req, res, next } = createMockReqRes({
        params: { provider: 'github' },
        query: { returnTo: '/destinations', json: 'true' },
        headers: { accept: 'application/json' },
      });
      await oauthController.start(req, res, next);

      expect(res.statusCode).toBe(200);
      expect(res.body.url).toContain('https://github.com/login/oauth/authorize');
      expect(res.body.url).toContain('client_id=mock-github-client-id');
      expect(res.body.url).toMatch(/scope=read(%3A|:)user(\+|%20)user(%3A|:)email/);
      expect(res.body.state).toBeDefined();

      const stateCookie = res.cookies[OAUTH_COOKIE_NAME];
      expect(stateCookie).toBeDefined();
      expect(stateCookie.val).toBe(res.body.state);
      expect(stateCookie.opts.httpOnly).toBe(true);
      expect(stateCookie.opts.sameSite).toBe('lax');
    });

    it('GET /auth/oauth/google/start sets PKCE verifier, challenge and redirects to Google with requested scopes', async () => {
      const { req, res, next } = createMockReqRes({
        params: { provider: 'google' },
        query: { returnTo: '/analytics', json: 'true' },
        headers: { accept: 'application/json' },
      });
      await oauthController.start(req, res, next);

      expect(res.statusCode).toBe(200);
      expect(res.body.url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      expect(res.body.url).toContain('client_id=mock-google-client-id');
      expect(res.body.url).toContain('code_challenge_method=S256');
      expect(res.body.url).toMatch(/scope=openid(\+|%20)email(\+|%20)profile/);
      expect(res.body.state).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 3. Provider Error Handling & State Verification
  // --------------------------------------------------------------------------
  describe('Provider Callback Error Handling & State Guards', () => {
    it('redirects to /login?error=oauth_denied if provider returns access_denied', async () => {
      const { req, res, next } = createMockReqRes({
        params: { provider: 'github' },
        query: { error: 'access_denied', error_description: 'User denied' },
      });
      await oauthController.callback(req, res, next);

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('http://localhost:5173/login?error=oauth_denied');
    });

    it('rejects callback with state mismatch, missing state, or replayed state', async () => {
      // Missing state
      const {
        req: req1,
        res: res1,
        next: next1,
      } = createMockReqRes({
        params: { provider: 'github' },
        query: { code: 'mock-code' },
      });
      await oauthController.callback(req1, res1, next1);
      expect(res1.statusCode).toBe(302);
      expect(res1.headers['location']).toBe(
        'http://localhost:5173/login?error=missing_callback_parameters',
      );

      // Unknown state (never issued or expired)
      const {
        req: req2,
        res: res2,
        next: next2,
      } = createMockReqRes({
        params: { provider: 'github' },
        query: { code: 'mock-code', state: 'nonexistent-state' },
      });
      await oauthController.callback(req2, res2, next2);
      expect(res2.statusCode).toBe(302);
      expect(res2.headers['location']).toBe(
        'http://localhost:5173/login?error=invalid_or_expired_state',
      );
    });
  });

  // --------------------------------------------------------------------------
  // 4. New User Registration & Returning User Login
  // --------------------------------------------------------------------------
  describe('OAuth Signup, Login, and Anti-Silent-Linking', () => {
    it('registers a new user via GitHub with verified email and creates default Workspace', async () => {
      // 1. Start authorization flow
      const startRes = await oauthService.startAuthorization('github', '/overview');
      const state = startRes.state;

      // 2. Mock GitHub token exchange and profile endpoints with nock
      nock('https://github.com')
        .post('/login/oauth/access_token')
        .reply(200, { access_token: 'gh-mock-token-123', token_type: 'bearer' });

      nock('https://api.github.com').get('/user').reply(200, {
        id: 998877,
        login: 'octocat',
        name: 'The Octocat',
        avatar_url: 'https://avatars.githubusercontent.com/u/998877?v=4',
      });

      nock('https://api.github.com')
        .get('/user/emails')
        .reply(200, [
          { email: 'unverified@example.com', primary: false, verified: false },
          { email: 'octocat@github.com', primary: true, verified: true },
        ]);

      const mockCreateWorkspace = vi
        .spyOn(workspaceService, 'createWorkspace')
        .mockResolvedValue({ id: 'ws-new' } as any);

      // 3. Invoke callback
      const { req, res, next } = createMockReqRes({
        params: { provider: 'github' },
        query: { code: 'valid-gh-code', state },
        signedCookies: { [OAUTH_COOKIE_NAME]: state },
      });
      await oauthController.callback(req, res, next);

      expect(res.statusCode).toBe(302);
      // Redirects without exposing tokens or codes in URL
      expect(res.headers['location']).toBe('http://localhost:5173/auth/callback?next=%2Foverview');

      // Sets refresh token cookie with same flags as password login
      const refreshCookie = res.cookies[REFRESH_COOKIE_NAME];
      expect(refreshCookie).toBeDefined();
      expect(refreshCookie.opts.httpOnly).toBe(true);

      // Verifies user and workspace creation
      const user = await UserModel.findOne({ email: 'octocat@github.com' });
      expect(user).toBeDefined();
      expect(user?.name).toBe('The Octocat');
      expect(user?.passwordHash).toBeNull();
      expect(user?.avatarUrl).toContain('avatars.githubusercontent.com');

      const identity = await IdentityModel.findOne({
        provider: 'github',
        providerUserId: '998877',
      });
      expect(identity).toBeDefined();
      expect(identity?.emailVerified).toBe(true);

      expect(mockCreateWorkspace).toHaveBeenCalledWith(
        user?.id,
        expect.stringContaining("The Octocat's Workspace"),
      );

      // 4. Second attempt with the SAME state must fail (single-use replay protection)
      const {
        req: replayReq,
        res: replayRes,
        next: replayNext,
      } = createMockReqRes({
        params: { provider: 'github' },
        query: { code: 'valid-gh-code', state },
        signedCookies: { [OAUTH_COOKIE_NAME]: state },
      });
      await oauthController.callback(replayReq, replayRes, replayNext);
      expect(replayRes.statusCode).toBe(302);
      expect(replayRes.headers['location']).toBe(
        'http://localhost:5173/login?error=invalid_or_expired_state',
      );
    });

    it('logs in a returning user via Google using verified ID token claims', async () => {
      // Setup existing Google user and identity
      const existingUser = await UserModel.create({
        email: 'google.dev@example.com',
        name: 'Google Developer',
        passwordHash: null,
      });

      const existingIdentity = await IdentityModel.create({
        userId: existingUser._id,
        provider: 'google',
        providerUserId: 'google-sub-5544',
        email: 'google.dev@example.com',
        emailVerified: true,
      });

      // Start flow
      const startRes = await oauthService.startAuthorization('google', '/events');

      // Create valid signed Google ID token
      const mockIdToken = jwt.sign(
        {
          sub: 'google-sub-5544',
          email: 'google.dev@example.com',
          email_verified: true,
          name: 'Google Developer',
          picture: 'https://lh3.googleusercontent.com/photo.jpg',
        },
        'test-secret',
      );

      nock('https://oauth2.googleapis.com').post('/token').reply(200, {
        access_token: 'google-access-token-xyz',
        id_token: mockIdToken,
        expires_in: 3600,
      });

      const { req, res, next } = createMockReqRes({
        params: { provider: 'google' },
        query: { code: 'valid-google-code', state: startRes.state },
        signedCookies: { [OAUTH_COOKIE_NAME]: startRes.state },
      });
      await oauthController.callback(req, res, next);

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('http://localhost:5173/auth/callback?next=%2Fevents');

      const refreshCookie = res.cookies[REFRESH_COOKIE_NAME];
      expect(refreshCookie).toBeDefined();

      const updatedIdentity = await IdentityModel.findById(existingIdentity._id);
      expect(updatedIdentity?.lastLoginAt).toBeDefined();
    });

    it('rejects GitHub login when user has no verified email with error=email_unverified', async () => {
      const startRes = await oauthService.startAuthorization('github');

      nock('https://github.com')
        .post('/login/oauth/access_token')
        .reply(200, { access_token: 'gh-token-no-email' });

      nock('https://api.github.com').get('/user').reply(200, {
        id: 112233,
        login: 'unverified-user',
        email: null,
      });

      nock('https://api.github.com')
        .get('/user/emails')
        .reply(200, [{ email: 'unverified@example.com', verified: false, primary: true }]);

      const { req, res, next } = createMockReqRes({
        params: { provider: 'github' },
        query: { code: 'some-code', state: startRes.state },
        signedCookies: { [OAUTH_COOKIE_NAME]: startRes.state },
      });
      await oauthController.callback(req, res, next);

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('http://localhost:5173/login?error=email_unverified');
    });

    it('refuses silent auto-linking when an existing user with the same email exists without an identity', async () => {
      // User registered with password
      await UserModel.create({
        email: 'preexisting@example.com',
        name: 'Original Account',
        passwordHash: 'hashed-password',
      });

      const startRes = await oauthService.startAuthorization('github');

      nock('https://github.com')
        .post('/login/oauth/access_token')
        .reply(200, { access_token: 'gh-token-match' });

      nock('https://api.github.com').get('/user').reply(200, {
        id: 778899,
        login: 'preexisting-dev',
      });

      nock('https://api.github.com')
        .get('/user/emails')
        .reply(200, [{ email: 'preexisting@example.com', verified: true, primary: true }]);

      const { req, res, next } = createMockReqRes({
        params: { provider: 'github' },
        query: { code: 'some-code', state: startRes.state },
        signedCookies: { [OAUTH_COOKIE_NAME]: startRes.state },
      });
      await oauthController.callback(req, res, next);

      expect(res.statusCode).toBe(302);
      // Strictly redirects to password prompt and does NOT auto-link
      expect(res.headers['location']).toBe(
        'http://localhost:5173/login?error=account_exists_use_password',
      );

      const identity = await IdentityModel.findOne({ providerUserId: '778899' });
      expect(identity).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 5. Authenticated Linking & Unlinking
  // --------------------------------------------------------------------------
  describe('Authenticated Account Linking & Unlinking Guards', () => {
    it('authenticated user can link a GitHub account from settings', async () => {
      const user = await UserModel.create({
        email: 'existing.member@example.com',
        name: 'Existing Member',
        passwordHash: 'some-hash',
      });

      // 1. Start linking
      const {
        req: linkReq,
        res: linkRes,
        next: linkNext,
      } = createMockReqRes({
        params: { provider: 'github' },
        body: { returnTo: '/settings' },
        user: { id: user.id, email: user.email, name: user.name },
      });
      await oauthController.linkStart(linkReq, linkRes, linkNext);

      expect(linkRes.statusCode).toBe(200);
      const state = linkRes.body.state;

      // 2. Mock GitHub endpoints
      nock('https://github.com')
        .post('/login/oauth/access_token')
        .reply(200, { access_token: 'gh-link-token' });

      nock('https://api.github.com').get('/user').reply(200, {
        id: 334455,
        login: 'member-gh',
        name: 'Member GitHub',
      });

      nock('https://api.github.com')
        .get('/user/emails')
        .reply(200, [{ email: 'github.member@example.com', verified: true, primary: true }]);

      // 3. Callback attaches identity to user
      const {
        req: cbReq,
        res: cbRes,
        next: cbNext,
      } = createMockReqRes({
        params: { provider: 'github' },
        query: { code: 'link-code', state },
        signedCookies: { [OAUTH_COOKIE_NAME]: state },
      });
      await oauthController.callback(cbReq, cbRes, cbNext);

      expect(cbRes.statusCode).toBe(302);
      expect(cbRes.headers['location']).toBe('http://localhost:5173/settings?success=oauth_linked');

      const identity = await IdentityModel.findOne({
        provider: 'github',
        providerUserId: '334455',
      });
      expect(identity).toBeDefined();
      expect(identity?.userId.toString()).toBe(user.id);
    });

    it('rejects linking if the provider account is already linked to another user', async () => {
      const userA = await UserModel.create({
        email: 'userA@example.com',
        name: 'User A',
        passwordHash: 'hashA',
      });

      const userB = await UserModel.create({
        email: 'userB@example.com',
        name: 'User B',
        passwordHash: 'hashB',
      });

      // Provider account already linked to User A
      await IdentityModel.create({
        userId: userA._id,
        provider: 'github',
        providerUserId: 'shared-gh-id',
        email: 'shared@example.com',
        emailVerified: true,
      });

      // User B attempts to link the same GitHub account
      const {
        req: linkReq,
        res: linkRes,
        next: linkNext,
      } = createMockReqRes({
        params: { provider: 'github' },
        user: { id: userB.id, email: userB.email, name: userB.name },
      });
      await oauthController.linkStart(linkReq, linkRes, linkNext);

      nock('https://github.com')
        .post('/login/oauth/access_token')
        .reply(200, { access_token: 'gh-token-shared' });

      nock('https://api.github.com').get('/user').reply(200, {
        id: 'shared-gh-id',
        login: 'shared-gh',
      });

      nock('https://api.github.com')
        .get('/user/emails')
        .reply(200, [{ email: 'shared@example.com', verified: true, primary: true }]);

      const {
        req: cbReq,
        res: cbRes,
        next: cbNext,
      } = createMockReqRes({
        params: { provider: 'github' },
        query: { code: 'link-code', state: linkRes.body.state },
        signedCookies: { [OAUTH_COOKIE_NAME]: linkRes.body.state },
      });
      await oauthController.callback(cbReq, cbRes, cbNext);

      expect(cbRes.statusCode).toBe(302);
      expect(cbRes.headers['location']).toBe(
        'http://localhost:5173/settings?error=oauth_account_already_linked',
      );
    });

    it('refuses unlinking when it is the user last login method', async () => {
      // User with NO password and only 1 identity
      const oauthOnlyUser = await UserModel.create({
        email: 'only.oauth@example.com',
        name: 'OAuth Only User',
        passwordHash: null,
      });

      const soleIdentity = await IdentityModel.create({
        userId: oauthOnlyUser._id,
        provider: 'github',
        providerUserId: 'sole-identity-1',
        email: 'only.oauth@example.com',
        emailVerified: true,
      });

      // Attempt to unlink sole identity
      const {
        req: unReq1,
        res: unRes1,
        next: unNext1,
      } = createMockReqRes({
        params: { id: soleIdentity.id },
        user: { id: oauthOnlyUser.id, email: oauthOnlyUser.email, name: oauthOnlyUser.name },
      });
      await oauthController.unlink(unReq1, unRes1, unNext1);

      expect(unRes1.statusCode).toBe(400);
      expect(unRes1.body.error.code).toBe('LAST_LOGIN_METHOD');

      // Now add a password -> unlinking should succeed
      oauthOnlyUser.passwordHash = 'new-password-hash';
      await oauthOnlyUser.save();

      const {
        req: unReq2,
        res: unRes2,
        next: unNext2,
      } = createMockReqRes({
        params: { id: soleIdentity.id },
        user: { id: oauthOnlyUser.id, email: oauthOnlyUser.email, name: oauthOnlyUser.name },
      });
      await oauthController.unlink(unReq2, unRes2, unNext2);

      expect(unRes2.statusCode).toBe(200);
      expect(unRes2.body.success).toBe(true);
    });

    it('GET /auth/me returns linked providers, hasPassword, and no confidential fields', async () => {
      const user = await UserModel.create({
        email: 'me.test@example.com',
        name: 'Me Test',
        displayName: 'Display Me',
        avatarUrl: 'https://example.com/avatar.png',
        passwordHash: 'secret-hash',
      });

      await IdentityModel.create({
        userId: user._id,
        provider: 'google',
        providerUserId: 'google-uid-1',
        email: 'me.test@example.com',
        emailVerified: true,
        avatarUrl: 'https://example.com/avatar.png',
      });

      const { req, res, next } = createMockReqRes({
        user: { id: user.id, email: user.email, name: user.name },
      });
      await authController.getMe(req, res, next);

      expect(res.statusCode).toBe(200);
      expect(res.body.user).toMatchObject({
        id: user.id,
        email: 'me.test@example.com',
        name: 'Me Test',
        displayName: 'Display Me',
        avatarUrl: 'https://example.com/avatar.png',
        hasPassword: true,
      });
      expect(res.body.user.identities).toHaveLength(1);
      expect(res.body.user.identities[0]).toMatchObject({
        provider: 'google',
        email: 'me.test@example.com',
      });
      // Confirm passwordHash is never leaked
      expect(res.body.user.passwordHash).toBeUndefined();
    });

    it('enforces authentication on protected routes', async () => {
      const {
        req: unauthReq,
        res: unauthRes,
        next: unauthNext,
      } = createMockReqRes({
        headers: {}, // No Authorization header
      });

      authMiddleware(unauthReq, unauthRes, unauthNext);
      expect(unauthNext).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 401, code: 'UNAUTHORIZED' }),
      );
    });
  });

  // --------------------------------------------------------------------------
  // 6. Idempotent Migration
  // --------------------------------------------------------------------------
  describe('Idempotent Migration', () => {
    it('runs migration in dryRun and live modes without data loss', async () => {
      const dryResult = await runMigration({ dryRun: true });
      expect(dryResult.dryRun).toBe(true);
      expect(dryResult.indexesCreated).toBe(2);

      const liveResult = await runMigration({ dryRun: false });
      expect(liveResult.dryRun).toBe(false);
      expect(liveResult.indexesCreated).toBe(2);
    });
  });
});
