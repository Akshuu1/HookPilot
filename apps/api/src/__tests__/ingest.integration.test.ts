import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createHmac, randomBytes } from 'node:crypto';
import type { Queue } from 'bullmq';
import { app } from '../app.js';
import { getRedisClient } from '../config/redis.js';
import { EndpointModel } from '../models/Endpoint.js';
import { EventModel } from '../models/Event.js';
import { WorkspaceModel } from '../models/Workspace.js';
import { UserModel } from '../models/User.js';
import { encryptSecret } from '../utils/crypto.js';
import * as queueConfig from '../config/queue.js';

let mongoServer: MongoMemoryServer;
const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'job-1' });

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);

  // Ensure indexes (especially unique index on endpointId + idempotencyKey) are built
  await EventModel.init();

  // Mock BullMQ queue in tests to verify job enqueue calls without a live Redis server
  vi.spyOn(queueConfig, 'getDeliveryQueue').mockReturnValue({
    add: mockQueueAdd,
  } as unknown as Queue);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  mockQueueAdd.mockClear();
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key]!.deleteMany({});
  }

  // Clear any cached endpoint slugs in Redis to prevent cross-test interference
  try {
    const redis = getRedisClient();
    const keys = await redis.keys('ep:slug:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch {
    // Non-blocking in test setup
  }
});

async function createTestEndpoint(overrides: Record<string, unknown> = {}) {
  const user = await UserModel.create({
    email: `test-${Date.now()}@example.com`,
    passwordHash: 'hash',
    name: 'Test',
  });

  const workspace = await WorkspaceModel.create({
    name: 'Workspace',
    ownerId: user._id,
  });

  const randomSuffix = randomBytes(3).toString('hex'); // 6 chars
  const prefix = overrides.slug ? overrides.slug.slice(0, 9) : 'slug';
  const slug = `${prefix}_${randomSuffix}`.slice(0, 16);

  const endpoint = await EndpointModel.create({
    workspaceId: workspace._id,
    name: 'Test Ingest Endpoint',
    slug,
    destinationUrl: 'https://example.com/dest',
    signatureConfig: overrides.signatureConfig || {
      provider: 'none',
      secretEncrypted: null,
      enforce: false,
    },
    retryPolicy: { maxAttempts: 8, baseDelayMs: 1000, maxDelayMs: 3600000 },
    rateLimitPerMin: 60,
    isActive: overrides.isActive ?? true,
    mode: overrides.mode || 'forward',
  });

  return { user, workspace, endpoint };
}

describe('Ingest Route Integration Tests (POST|PUT|PATCH /in/:slug)', () => {
  it('accepts valid Stripe-style signed payload and marks signatureValid=true', async () => {
    const rawSecret = 'whsec_stripe_test_secret_12345';
    const secretEncrypted = encryptSecret(rawSecret);

    const { endpoint } = await createTestEndpoint({
      slug: 'stripe_ep_12',
      signatureConfig: {
        provider: 'stripe',
        secretEncrypted,
        enforce: false,
      },
    });

    const payload = JSON.stringify({
      id: 'evt_stripe_payment_success',
      type: 'payment_intent.succeeded',
      amount: 4200,
    });

    const now = Math.floor(Date.now() / 1000);
    const v1Signature = createHmac('sha256', rawSecret).update(`${now}.${payload}`).digest('hex');

    const res = await request(app)
      .post(`/in/${endpoint.slug}`)
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', `t=${now},v1=${v1Signature}`)
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.eventId).toBeDefined();

    // Verify stored event in MongoDB
    const savedEvent = await EventModel.findById(res.body.eventId);
    expect(savedEvent).not.toBeNull();
    expect(savedEvent!.signatureValid).toBe(true);
    expect(savedEvent!.status).toBe('pending');
    expect(savedEvent!.idempotencyKey).toBe('evt_stripe_payment_success');
    expect(savedEvent!.rawBody).toBe(payload);

    // Verify delivery job was enqueued
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'deliver',
      { eventId: savedEvent!.id },
      expect.objectContaining({ jobId: savedEvent!.id }),
    );
  });

  it('flags tampered payload as invalid without rejecting when enforce is false', async () => {
    const rawSecret = 'whsec_secret_flag_only';
    const secretEncrypted = encryptSecret(rawSecret);

    const { endpoint } = await createTestEndpoint({
      slug: 'tamper_ep_12',
      signatureConfig: {
        provider: 'stripe',
        secretEncrypted,
        enforce: false,
      },
    });

    const payload = JSON.stringify({ id: 'evt_tampered', amount: 50 });
    const now = Math.floor(Date.now() / 1000);
    // Bad signature
    const badSig = '0000000000000000000000000000000000000000000000000000000000000000';

    const res = await request(app)
      .post(`/in/${endpoint.slug}`)
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', `t=${now},v1=${badSig}`)
      .send(payload);

    expect(res.status).toBe(202);

    const savedEvent = await EventModel.findById(res.body.eventId);
    expect(savedEvent).not.toBeNull();
    expect(savedEvent!.signatureValid).toBe(false);
  });

  it('rejects with 401 when signature is invalid and endpoint enforces verification', async () => {
    const rawSecret = 'whsec_enforce_secret';
    const secretEncrypted = encryptSecret(rawSecret);

    const { endpoint } = await createTestEndpoint({
      slug: 'enforce_ep_1',
      signatureConfig: {
        provider: 'stripe',
        secretEncrypted,
        enforce: true, // Enforce mode enabled
      },
    });

    const payload = JSON.stringify({ id: 'evt_rejected' });

    const res = await request(app)
      .post(`/in/${endpoint.slug}`)
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 't=12345,v1=bad')
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');

    // Event should not be persisted on 401 rejection
    const eventCount = await EventModel.countDocuments({ endpointId: endpoint._id });
    expect(eventCount).toBe(0);
  });

  it('handles duplicate POST requests idempotently: returns the same eventId and creates one job', async () => {
    const { endpoint } = await createTestEndpoint({ slug: 'idempotent_12' });

    const payload = JSON.stringify({ orderId: 'ord_123', status: 'shipped' });

    // First request
    const res1 = await request(app)
      .post(`/in/${endpoint.slug}`)
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', 'unique-order-key-101')
      .send(payload);

    expect(res1.status).toBe(202);
    const eventId1 = res1.body.eventId;
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);

    // Duplicate request with exact same idempotency key
    const res2 = await request(app)
      .post(`/in/${endpoint.slug}`)
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', 'unique-order-key-101')
      .send(payload);

    expect(res2.status).toBe(202);
    const eventId2 = res2.body.eventId;

    // Must return the exact same eventId!
    expect(eventId2).toBe(eventId1);

    // Must NOT create a second queue job!
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);

    // Must only have 1 document in the database
    const totalEvents = await EventModel.countDocuments({ endpointId: endpoint._id });
    expect(totalEvents).toBe(1);
  });

  it('supports PUT and PATCH methods on /in/:slug', async () => {
    const { endpoint } = await createTestEndpoint({ slug: 'method_test_1' });

    const putRes = await request(app).put(`/in/${endpoint.slug}`).send('put-payload');
    expect(putRes.status).toBe(202);

    const patchRes = await request(app).patch(`/in/${endpoint.slug}`).send('patch-payload');
    expect(patchRes.status).toBe(202);
  });

  it('redacts sensitive headers in stored event document', async () => {
    const { endpoint } = await createTestEndpoint({ slug: 'redact_ep_12' });

    const res = await request(app)
      .post(`/in/${endpoint.slug}`)
      .set('Authorization', 'Bearer super-secret-token')
      .set('Cookie', 'auth_session=abcdef')
      .set('X-Api-Key', 'live_api_key_1234')
      .set('X-Custom-Header', 'custom-value')
      .send('hello');

    expect(res.status).toBe(202);

    const saved = await EventModel.findById(res.body.eventId);
    expect(saved).not.toBeNull();
    const headers = saved!.headers;
    expect(headers.get('authorization')).toBe('[REDACTED]');
    expect(headers.get('cookie')).toBe('[REDACTED]');
    expect(headers.get('x-api-key')).toBe('[REDACTED]');
    expect(headers.get('x-custom-header')).toBe('custom-value');
  });

  it('does not enqueue a delivery job when endpoint is in capture-only mode', async () => {
    const { endpoint } = await createTestEndpoint({
      slug: 'capture_only1',
      mode: 'capture-only',
    });

    const res = await request(app).post(`/in/${endpoint.slug}`).send('capture-only-event');

    expect(res.status).toBe(202);
    expect(mockQueueAdd).not.toHaveBeenCalled();

    const saved = await EventModel.findById(res.body.eventId);
    expect(saved).not.toBeNull();
  });

  it('returns 404 if endpoint does not exist or is inactive', async () => {
    const notFoundRes = await request(app).post('/in/non-existent-slug').send('data');
    expect(notFoundRes.status).toBe(404);

    const { endpoint: inactiveEp } = await createTestEndpoint({
      slug: 'inactive_ep1',
      isActive: false,
    });

    const inactiveRes = await request(app).post(`/in/${inactiveEp.slug}`).send('data');
    expect(inactiveRes.status).toBe(404);
  });
});
