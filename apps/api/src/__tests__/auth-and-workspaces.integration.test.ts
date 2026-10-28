import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { app } from '../app.js';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key]!.deleteMany({});
  }
});

function extractCookie(res: request.Response, cookieName: string): string | undefined {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return undefined;
  const cookieHeaders = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const header of cookieHeaders) {
    if (header.startsWith(`${cookieName}=`)) {
      return header.split(';')[0]?.split('=')[1];
    }
  }
  return undefined;
}

describe('Auth Integration Tests', () => {
  it('registers a new user and sets an httpOnly refresh cookie', async () => {
    const res = await request(app).post('/auth/register').send({
      email: 'alice@example.com',
      password: 'securePassword123',
      name: 'Alice Cooper',
    });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      email: 'alice@example.com',
      name: 'Alice Cooper',
    });
    expect(res.body.accessToken).toBeDefined();

    const refreshCookie = extractCookie(res, 'refreshToken');
    expect(refreshCookie).toBeDefined();
    expect(res.headers['set-cookie']?.[0]).toContain('HttpOnly');
  });

  it('rejects duplicate email registrations with 409 Conflict', async () => {
    await request(app).post('/auth/register').send({
      email: 'duplicate@example.com',
      password: 'password123',
      name: 'User One',
    });

    const res = await request(app).post('/auth/register').send({
      email: 'duplicate@example.com',
      password: 'password123',
      name: 'User Two',
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_EXISTS');
  });

  it('logs in an existing user and returns 200 with tokens', async () => {
    await request(app).post('/auth/register').send({
      email: 'bob@example.com',
      password: 'mypassword123',
      name: 'Bob Marley',
    });

    const res = await request(app).post('/auth/login').send({
      email: 'bob@example.com',
      password: 'mypassword123',
    });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(extractCookie(res, 'refreshToken')).toBeDefined();
  });

  it('rejects login with invalid password', async () => {
    await request(app).post('/auth/register').send({
      email: 'charlie@example.com',
      password: 'correctPassword123',
      name: 'Charlie',
    });

    const res = await request(app).post('/auth/login').send({
      email: 'charlie@example.com',
      password: 'wrongPassword',
    });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('protects /auth/me with authMiddleware', async () => {
    const regRes = await request(app).post('/auth/register').send({
      email: 'me@example.com',
      password: 'password123',
      name: 'Me User',
    });

    const token = regRes.body.accessToken;

    // Successful request with token
    const meRes = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.user.email).toBe('me@example.com');

    // Missing token
    const unauthRes = await request(app).get('/auth/me');
    expect(unauthRes.status).toBe(401);

    // Invalid token
    const badTokenRes = await request(app)
      .get('/auth/me')
      .set('Authorization', 'Bearer invalid-token');
    expect(badTokenRes.status).toBe(401);
  });

  it('rotates refresh token on /auth/refresh and updates cookie', async () => {
    const loginRes = await request(app).post('/auth/register').send({
      email: 'rotate@example.com',
      password: 'password123',
      name: 'Rotate User',
    });

    const firstRefreshToken = extractCookie(loginRes, 'refreshToken')!;

    const refreshRes = await request(app)
      .post('/auth/refresh')
      .set('Cookie', [`refreshToken=${firstRefreshToken}`]);

    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.accessToken).toBeDefined();

    const secondRefreshToken = extractCookie(refreshRes, 'refreshToken')!;
    expect(secondRefreshToken).toBeDefined();
    expect(secondRefreshToken).not.toBe(firstRefreshToken);
  });

  it('detects refresh token reuse and revokes ALL user sessions', async () => {
    const regRes = await request(app).post('/auth/register').send({
      email: 'reuse@example.com',
      password: 'password123',
      name: 'Reuse User',
    });

    const tokenR1 = extractCookie(regRes, 'refreshToken')!;

    // Step 1: Normal refresh -> rotates R1 to R2
    const refreshRes1 = await request(app)
      .post('/auth/refresh')
      .set('Cookie', [`refreshToken=${tokenR1}`]);

    expect(refreshRes1.status).toBe(200);
    const tokenR2 = extractCookie(refreshRes1, 'refreshToken')!;
    expect(tokenR2).not.toBe(tokenR1);

    // Step 2: Attacker replays old revoked token R1
    const reuseAttackRes = await request(app)
      .post('/auth/refresh')
      .set('Cookie', [`refreshToken=${tokenR1}`]);

    expect(reuseAttackRes.status).toBe(401);
    expect(reuseAttackRes.body.error.code).toBe('TOKEN_REUSE_DETECTED');

    // Step 3: Legitimate user tries to use token R2 - it must now ALSO be rejected!
    const legitUserRes = await request(app)
      .post('/auth/refresh')
      .set('Cookie', [`refreshToken=${tokenR2}`]);

    expect(legitUserRes.status).toBe(401);
  });

  it('clears cookie and revokes token on logout', async () => {
    const regRes = await request(app).post('/auth/register').send({
      email: 'logout@example.com',
      password: 'password123',
      name: 'Logout User',
    });

    const token = extractCookie(regRes, 'refreshToken')!;

    const logoutRes = await request(app)
      .post('/auth/logout')
      .set('Cookie', [`refreshToken=${token}`]);

    expect(logoutRes.status).toBe(200);

    // Refreshing after logout fails
    const refreshRes = await request(app)
      .post('/auth/refresh')
      .set('Cookie', [`refreshToken=${token}`]);

    expect(refreshRes.status).toBe(401);
  });
});

describe('Workspace & RBAC Integration Tests', () => {
  it('creates a workspace and assigns creator as owner', async () => {
    const reg = await request(app).post('/auth/register').send({
      email: 'owner@example.com',
      password: 'password123',
      name: 'Owner User',
    });

    const token = reg.body.accessToken;

    const res = await request(app)
      .post('/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Acme Corp' });

    expect(res.status).toBe(201);
    expect(res.body.workspace).toMatchObject({
      name: 'Acme Corp',
      role: 'owner',
    });

    // List workspaces
    const listRes = await request(app).get('/workspaces').set('Authorization', `Bearer ${token}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.workspaces).toHaveLength(1);
    expect(listRes.body.workspaces[0]).toMatchObject({
      name: 'Acme Corp',
      role: 'owner',
    });
  });

  it('enforces RBAC: admin can change roles, but a VIEWER CANNOT CHANGE ROLES', async () => {
    // 1. Create owner
    const ownerRes = await request(app).post('/auth/register').send({
      email: 'ws-owner@example.com',
      password: 'password123',
      name: 'Owner',
    });
    const ownerToken = ownerRes.body.accessToken;

    // 2. Create workspace
    const wsRes = await request(app)
      .post('/workspaces')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Security Workspace' });
    const workspaceId = wsRes.body.workspace.id;

    // 3. Register user2 (will be admin)
    const adminUserRes = await request(app).post('/auth/register').send({
      email: 'admin@example.com',
      password: 'password123',
      name: 'Admin User',
    });
    const adminToken = adminUserRes.body.accessToken;

    // 4. Register user3 (will be viewer)
    const viewerUserRes = await request(app).post('/auth/register').send({
      email: 'viewer@example.com',
      password: 'password123',
      name: 'Viewer User',
    });
    const viewerToken = viewerUserRes.body.accessToken;

    // 5. Register user4 (target member)
    const targetUserRes = await request(app).post('/auth/register').send({
      email: 'target@example.com',
      password: 'password123',
      name: 'Target User',
    });
    const targetUserId = targetUserRes.body.user.id;

    // Owner adds admin, viewer, and target
    await request(app)
      .post(`/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'admin@example.com', role: 'admin' });

    await request(app)
      .post(`/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'viewer@example.com', role: 'viewer' });

    await request(app)
      .post(`/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'target@example.com', role: 'member' });

    // 6. Admin CAN change role of target user to 'viewer'
    const adminChangeRes = await request(app)
      .patch(`/workspaces/${workspaceId}/members/${targetUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'viewer' });

    expect(adminChangeRes.status).toBe(200);
    expect(adminChangeRes.body.member.role).toBe('viewer');

    // 7. CRITICAL ACCEPTANCE CHECK: VIEWER CANNOT CHANGE ROLES (must return 403 Forbidden)
    const viewerChangeRes = await request(app)
      .patch(`/workspaces/${workspaceId}/members/${targetUserId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ role: 'admin' });

    expect(viewerChangeRes.status).toBe(403);
    expect(viewerChangeRes.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');

    // Viewer cannot add members
    const viewerAddRes = await request(app)
      .post(`/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ email: 'another@example.com', role: 'viewer' });

    expect(viewerAddRes.status).toBe(403);

    // Viewer cannot remove members
    const viewerRemoveRes = await request(app)
      .delete(`/workspaces/${workspaceId}/members/${targetUserId}`)
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(viewerRemoveRes.status).toBe(403);

    // Admin CAN remove member
    const adminRemoveRes = await request(app)
      .delete(`/workspaces/${workspaceId}/members/${targetUserId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(adminRemoveRes.status).toBe(200);
    expect(adminRemoveRes.body.message).toBe('Member removed successfully');
  });
});
