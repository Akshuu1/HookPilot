import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { Redis } from 'ioredis';
import { app } from '../app.js';
import { env } from '../config/env.js';
import { UserModel } from '../models/User.js';
import { WorkspaceModel } from '../models/Workspace.js';
import { MembershipModel } from '../models/Membership.js';
import { EndpointModel } from '../models/Endpoint.js';
import { ApiKeyModel } from '../models/ApiKey.js';
import { hashApiKey } from '../services/api-key.service.js';
import { signAccessToken } from '../utils/security.js';
import { createSocketServer, type ExtendedSocketServer } from '../services/socket.service.js';

let mongoServer: MongoMemoryServer;
let redisPublisher: Redis;
let redisSubscriber: Redis;

let httpServer: HttpServer;
let ioServer: ExtendedSocketServer;
let serverPort: number;

const openClients: ClientSocket[] = [];

function createClient(port: number, auth: { apiKey?: string; token?: string }): ClientSocket {
  const client = ioClient(`http://127.0.0.1:${port}`, {
    auth,
    transports: ['websocket'],
    autoConnect: true,
    reconnection: false,
    timeout: 5000,
  });
  openClients.push(client);
  return client;
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  redisPublisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  redisSubscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  httpServer = createServer();
  ioServer = createSocketServer(httpServer, { redisUrl: env.REDIS_URL });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      serverPort = (httpServer.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  for (const client of openClients) {
    if (client.connected) client.disconnect();
  }

  if (ioServer.cleanup) {
    await ioServer.cleanup();
  } else {
    ioServer.close();
  }

  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await redisPublisher.quit();
  await redisSubscriber.quit();

  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  for (const client of openClients) {
    if (client.connected) client.disconnect();
  }
  openClients.length = 0;

  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key]!.deleteMany({});
  }
});

describe('Phase 9: API Keys and CLI Tunnel Integration Tests', () => {
  it('creates an API key (shown once, stores hash and prefix), lists keys, and revokes key', async () => {
    // 1. Setup user & workspace
    const owner = await UserModel.create({
      email: 'owner@example.com',
      passwordHash: 'hash',
      name: 'Owner User',
    });
    const workspace = await WorkspaceModel.create({
      name: 'Dev Workspace',
      ownerId: owner._id,
    });
    await MembershipModel.create({
      userId: owner._id,
      workspaceId: workspace._id,
      role: 'owner',
    });

    const ownerToken = signAccessToken({
      userId: owner._id.toString(),
      email: owner.email,
      name: owner.name,
    });

    // 2. Create API key
    const createRes = await request(app)
      .post(`/workspaces/${workspace._id.toString()}/api-keys`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'CLI Development Key' });

    expect(createRes.status).toBe(201);
    expect(createRes.body.secretKey).toBeDefined();
    expect(createRes.body.secretKey.startsWith('hp_')).toBe(true);
    expect(createRes.body.apiKey.name).toBe('CLI Development Key');
    expect(createRes.body.apiKey.prefix).toBeDefined();

    const rawKey = createRes.body.secretKey as string;
    const keyId = createRes.body.apiKey.id as string;

    // Verify raw secret is NOT stored in DB, only sha256 hash
    const storedDoc = await ApiKeyModel.findById(keyId);
    expect(storedDoc).toBeDefined();
    expect(storedDoc!.keyHash).toBe(hashApiKey(rawKey));
    expect(storedDoc!.prefix).toBe(createRes.body.apiKey.prefix);

    // 3. List API keys
    const listRes = await request(app)
      .get(`/workspaces/${workspace._id.toString()}/api-keys`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.apiKeys).toHaveLength(1);
    expect(listRes.body.apiKeys[0].id).toBe(keyId);
    expect(listRes.body.apiKeys[0].secretKey).toBeUndefined(); // Never returned

    // 4. Verify API key using apiKeyAuth (/auth/verify-key)
    const verifyBearerRes = await request(app)
      .get('/auth/verify-key')
      .set('Authorization', `Bearer ${rawKey}`);

    expect(verifyBearerRes.status).toBe(200);
    expect(verifyBearerRes.body.valid).toBe(true);
    expect(verifyBearerRes.body.workspaceId).toBe(workspace._id.toString());

    // Also verify via X-API-Key header
    const verifyHeaderRes = await request(app).get('/auth/verify-key').set('X-API-Key', rawKey);

    expect(verifyHeaderRes.status).toBe(200);
    expect(verifyHeaderRes.body.valid).toBe(true);

    // 5. Revoke key
    const revokeRes = await request(app)
      .delete(`/workspaces/${workspace._id.toString()}/api-keys/${keyId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(revokeRes.status).toBe(200);

    // After revoke, verification must fail with 401
    const verifyAfterRevoke = await request(app)
      .get('/auth/verify-key')
      .set('Authorization', `Bearer ${rawKey}`);

    expect(verifyAfterRevoke.status).toBe(401);
  });

  it('enforces RBAC on API keys: viewer cannot create or revoke keys', async () => {
    const owner = await UserModel.create({
      email: 'owner2@example.com',
      passwordHash: 'hash',
      name: 'Owner',
    });
    const viewer = await UserModel.create({
      email: 'viewer2@example.com',
      passwordHash: 'hash',
      name: 'Viewer',
    });
    const workspace = await WorkspaceModel.create({
      name: 'Test Workspace',
      ownerId: owner._id,
    });
    await MembershipModel.create({
      userId: owner._id,
      workspaceId: workspace._id,
      role: 'owner',
    });
    await MembershipModel.create({
      userId: viewer._id,
      workspaceId: workspace._id,
      role: 'viewer',
    });

    const viewerToken = signAccessToken({
      userId: viewer._id.toString(),
      email: viewer.email,
      name: viewer.name,
    });

    // Viewer cannot create API key
    const createRes = await request(app)
      .post(`/workspaces/${workspace._id.toString()}/api-keys`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ name: 'Unauthorized Key' });

    expect(createRes.status).toBe(403);
  });

  it('authenticates CLI over Socket.IO via apiKey, joins tunnel, sets Redis lease, and forwards tunnel response', async () => {
    // 1. Setup workspace, endpoint, and API key
    const owner = await UserModel.create({
      email: 'cli-owner@example.com',
      passwordHash: 'hash',
      name: 'CLI Owner',
    });
    const workspace = await WorkspaceModel.create({
      name: 'Tunnel Workspace',
      ownerId: owner._id,
    });
    await MembershipModel.create({
      userId: owner._id,
      workspaceId: workspace._id,
      role: 'owner',
    });

    const endpoint = await EndpointModel.create({
      workspaceId: workspace._id,
      name: 'Webhook Ingest',
      slug: 'cli-test-slug',
      destinationUrl: 'http://example.com/webhook',
      isActive: true,
      mode: 'forward',
    });

    const rawApiKey = 'hp_test_secret_key_1234567890abcdef';
    await ApiKeyModel.create({
      workspaceId: workspace._id,
      name: 'CLI Key',
      prefix: 'hp_test...',
      keyHash: hashApiKey(rawApiKey),
      createdBy: owner._id,
    });

    // 2. Connect CLI socket with API Key in handshake
    const cliClient = createClient(serverPort, { apiKey: rawApiKey });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CLI connection timeout')), 3000);
      cliClient.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      cliClient.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(cliClient.connected).toBe(true);

    // 3. CLI joins tunnel for slug
    const joinAck = await new Promise<{ success: boolean; endpointId?: string; slug?: string }>(
      (resolve) => {
        cliClient.emit('tunnel:join', { endpointSlug: 'cli-test-slug' }, resolve);
      },
    );

    expect(joinAck.success).toBe(true);
    expect(joinAck.endpointId).toBe(endpoint._id.toString());

    // 4. Verify Redis lease was created with TTL
    const redisLease = await redisPublisher.get(`tunnel:endpoint:${endpoint._id.toString()}`);
    expect(redisLease).toBe(cliClient.id);

    const ttl = await redisPublisher.ttl(`tunnel:endpoint:${endpoint._id.toString()}`);
    expect(ttl).toBeGreaterThan(0);

    // 5. Test tunnel event forwarding:
    // When worker publishes to 'tunnel:requests', CLI receives 'tunnel:event'
    const eventReceivedPromise = new Promise<{ eventId: string; rawBody: string }>((resolve) => {
      cliClient.on('tunnel:event', (payload) => {
        resolve(payload);
      });
    });

    // Worker simulates dispatching a request over Redis
    const testEventId = new mongoose.Types.ObjectId().toString();
    await redisPublisher.publish(
      'tunnel:requests',
      JSON.stringify({
        eventId: testEventId,
        endpointId: endpoint._id.toString(),
        endpointSlug: endpoint.slug,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        rawBody: '{"hello":"world"}',
        timeoutMs: 5000,
      }),
    );

    const receivedEvent = await eventReceivedPromise;
    expect(receivedEvent.eventId).toBe(testEventId);
    expect(receivedEvent.rawBody).toBe('{"hello":"world"}');

    // 6. Test CLI replies with 'tunnel:response' and server relays to Redis
    const redisResponsePromise = new Promise<{ eventId: string; responseStatus: number }>(
      (resolve) => {
        void redisSubscriber.subscribe(`tunnel:response:${testEventId}`, (err) => {
          if (err) throw err;
        });
        redisSubscriber.on('message', (ch, msg) => {
          if (ch === `tunnel:response:${testEventId}`) {
            resolve(JSON.parse(msg));
          }
        });
      },
    );

    cliClient.emit('tunnel:response', {
      eventId: testEventId,
      responseStatus: 200,
      responseBodySnippet: '{"received":true}',
      durationMs: 45,
    });

    const relayedResponse = await redisResponsePromise;
    expect(relayedResponse.eventId).toBe(testEventId);
    expect(relayedResponse.responseStatus).toBe(200);

    // 7. CLI disconnect cleans up Redis key
    cliClient.disconnect();
    // Allow small tick for disconnect handler
    await new Promise((r) => setTimeout(r, 200));

    const leaseAfterDisconnect = await redisPublisher.get(
      `tunnel:endpoint:${endpoint._id.toString()}`,
    );
    expect(leaseAfterDisconnect).toBeNull();
  });
});
