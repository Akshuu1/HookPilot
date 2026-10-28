import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Redis } from 'ioredis';
import { app } from '../app.js';
import { env } from '../config/env.js';
import { UserModel } from '../models/User.js';
import { WorkspaceModel } from '../models/Workspace.js';
import { MembershipModel } from '../models/Membership.js';
import { EndpointModel } from '../models/Endpoint.js';
import { EventModel } from '../models/Event.js';
import { DeliveryAttemptModel } from '../models/DeliveryAttempt.js';
import { signAccessToken } from '../utils/security.js';

let mongoServer: MongoMemoryServer;
let redisClient: Redis;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  redisClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
});

afterAll(async () => {
  await redisClient.quit();
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key]!.deleteMany({});
  }

  // Clear analytics redis cache keys
  const keys = await redisClient.keys('cache:analytics:*');
  if (keys.length > 0) {
    await redisClient.del(...keys);
  }
});

describe('Phase 10: Analytics and Observability Integration Tests', () => {
  it('GET /metrics returns Prometheus formatted metrics including ingest, queue depth, and dlq', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');

    const text = res.text;
    expect(text).toContain('ingest_requests_total');
    expect(text).toContain('ingest_duration_seconds');
    expect(text).toContain('delivery_attempts_total');
    expect(text).toContain('queue_depth');
    expect(text).toContain('dlq_size');
  });

  it('GET /workspaces/:id/analytics aggregates summary, timeseries, latency percentiles, and top failures', async () => {
    // 1. Setup workspace & user
    const user = await UserModel.create({
      email: 'analyst@example.com',
      passwordHash: 'hash',
      name: 'Analyst User',
    });
    const workspace = await WorkspaceModel.create({
      name: 'Analytics Workspace',
      ownerId: user._id,
    });
    await MembershipModel.create({
      userId: user._id,
      workspaceId: workspace._id,
      role: 'owner',
    });

    const token = signAccessToken({
      userId: user._id.toString(),
      email: user.email,
      name: user.name,
    });

    const endpoint = await EndpointModel.create({
      workspaceId: workspace._id,
      name: 'Analytics Endpoint',
      slug: 'analytics-slug',
      destinationUrl: 'http://example.com/dest',
      isActive: true,
      mode: 'forward',
    });

    // 2. Populate synthetic events
    const now = new Date();

    // 3 delivered events
    const event1 = await EventModel.create({
      workspaceId: workspace._id,
      endpointId: endpoint._id,
      receivedAt: now,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{"event":1}',
      bodySize: 11,
      sourceIp: '127.0.0.1',
      signatureValid: true,
      idempotencyKey: 'idemp-1',
      status: 'delivered',
      attemptCount: 1,
      searchIndex: 'post 127.0.0.1',
    });

    const event2 = await EventModel.create({
      workspaceId: workspace._id,
      endpointId: endpoint._id,
      receivedAt: now,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{"event":2}',
      bodySize: 11,
      sourceIp: '127.0.0.1',
      signatureValid: true,
      idempotencyKey: 'idemp-2',
      status: 'delivered',
      attemptCount: 1,
      searchIndex: 'post 127.0.0.1',
    });

    // 1 dead / failed event
    const event3 = await EventModel.create({
      workspaceId: workspace._id,
      endpointId: endpoint._id,
      receivedAt: now,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{"event":3}',
      bodySize: 11,
      sourceIp: '127.0.0.1',
      signatureValid: true,
      idempotencyKey: 'idemp-3',
      status: 'dead',
      attemptCount: 8,
      searchIndex: 'post 127.0.0.1',
    });

    // 3. Populate delivery attempts for latency and failure statistics
    await DeliveryAttemptModel.create({
      eventId: event1._id,
      attemptNumber: 1,
      startedAt: now,
      durationMs: 45,
      requestHeaders: {},
      responseStatus: 200,
      responseBodySnippet: 'OK',
      success: true,
    });

    await DeliveryAttemptModel.create({
      eventId: event2._id,
      attemptNumber: 1,
      startedAt: now,
      durationMs: 95,
      requestHeaders: {},
      responseStatus: 200,
      responseBodySnippet: 'OK',
      success: true,
    });

    await DeliveryAttemptModel.create({
      eventId: event3._id,
      attemptNumber: 1,
      startedAt: now,
      durationMs: 150,
      requestHeaders: {},
      responseStatus: 504,
      responseBodySnippet: 'Gateway Timeout',
      error: 'HTTP 504 Gateway Timeout',
      success: false,
    });

    // 4. Request Analytics (First call: Cache miss)
    const res = await request(app)
      .get(`/workspaces/${workspace._id.toString()}/analytics?range=24h`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(res.body.summary).toMatchObject({
      total: 3,
      delivered: 2,
      failed: 1,
      successRate: 66.7,
    });

    expect(res.body.timeseries).toBeInstanceOf(Array);
    expect(res.body.timeseries.length).toBeGreaterThan(0);

    expect(res.body.latency.p50).toBeGreaterThanOrEqual(45);
    expect(res.body.latency.p95).toBeGreaterThanOrEqual(95);

    expect(res.body.topFailures).toHaveLength(1);
    expect(res.body.topFailures[0]).toMatchObject({
      reason: 'HTTP 504 Gateway Timeout',
      count: 1,
    });

    // 5. Second call within 30s: Cache hit
    const cachedRes = await request(app)
      .get(`/workspaces/${workspace._id.toString()}/analytics?range=24h`)
      .set('Authorization', `Bearer ${token}`);

    expect(cachedRes.status).toBe(200);
    expect(cachedRes.body.cached).toBe(true);
    expect(cachedRes.body.summary.total).toBe(3);
  });

  it('forbids users outside the workspace from reading analytics', async () => {
    const owner = await UserModel.create({
      email: 'ws-owner@example.com',
      passwordHash: 'hash',
      name: 'Owner',
    });
    const outsider = await UserModel.create({
      email: 'ws-outsider@example.com',
      passwordHash: 'hash',
      name: 'Outsider',
    });
    const workspace = await WorkspaceModel.create({
      name: 'Private Workspace',
      ownerId: owner._id,
    });
    await MembershipModel.create({
      userId: owner._id,
      workspaceId: workspace._id,
      role: 'owner',
    });

    const outsiderToken = signAccessToken({
      userId: outsider._id.toString(),
      email: outsider.email,
      name: outsider.name,
    });

    const res = await request(app)
      .get(`/workspaces/${workspace._id.toString()}/analytics?range=24h`)
      .set('Authorization', `Bearer ${outsiderToken}`);

    expect(res.status).toBe(403);
  });
});
