import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { UserModel } from '../models/User.js';
import { WorkspaceModel } from '../models/Workspace.js';
import { MembershipModel } from '../models/Membership.js';
import { signAccessToken } from '../utils/security.js';
import { createSocketServer, type ExtendedSocketServer } from '../services/socket.service.js';
import type { EventPubSubMessage } from '@hookpilot/shared';

let mongoServer: MongoMemoryServer;
let redisPublisher: Redis;

let server1: HttpServer;
let server2: HttpServer;
let io1: ExtendedSocketServer;
let io2: ExtendedSocketServer;
let port1: number;
let port2: number;

const openClients: ClientSocket[] = [];

function createClient(port: number, auth: { token?: string; workspaceId?: string }): ClientSocket {
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

  // Instance 1
  server1 = createServer();
  io1 = createSocketServer(server1, { redisUrl: env.REDIS_URL });
  await new Promise<void>((resolve) => {
    server1.listen(0, () => {
      port1 = (server1.address() as AddressInfo).port;
      resolve();
    });
  });

  // Instance 2 (shares the same Redis adapter)
  server2 = createServer();
  io2 = createSocketServer(server2, { redisUrl: env.REDIS_URL });
  await new Promise<void>((resolve) => {
    server2.listen(0, () => {
      port2 = (server2.address() as AddressInfo).port;
      resolve();
    });
  });
}, 60000);

afterAll(async () => {
  for (const client of openClients) {
    if (client.connected) {
      client.disconnect();
    }
  }

  await io1.cleanup?.();
  await io2.cleanup?.();

  await new Promise<void>((resolve) => server1.close(() => resolve()));
  await new Promise<void>((resolve) => server2.close(() => resolve()));

  if (redisPublisher) {
    try {
      await redisPublisher.quit();
    } catch {
      redisPublisher.disconnect();
    }
  }

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
}, 30000);

beforeEach(async () => {
  for (const client of openClients) {
    if (client.connected) {
      client.disconnect();
    }
  }
  openClients.length = 0;

  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key]!.deleteMany({});
  }
});

describe('Phase 7: Socket.IO Realtime & Multi-Instance Redis Adapter Integration Tests', () => {
  it('rejects connection when handshake token is missing or invalid', async () => {
    // 1. Missing token
    const clientNoToken = createClient(port1, {});
    const missingTokenErr = await new Promise<string>((resolve) => {
      clientNoToken.on('connect_error', (err) => resolve(err.message));
    });
    expect(missingTokenErr).toContain('Authentication required. Missing token.');

    // 2. Invalid token
    const clientBadToken = createClient(port1, { token: 'invalid.jwt.token' });
    const badTokenErr = await new Promise<string>((resolve) => {
      clientBadToken.on('connect_error', (err) => resolve(err.message));
    });
    expect(badTokenErr).toContain('Invalid or expired token.');
  });

  it('connects successfully with valid JWT token', async () => {
    const user = await UserModel.create({
      email: 'socket-user@example.com',
      passwordHash: 'hash',
      name: 'Socket User',
    });

    const token = signAccessToken({
      userId: user.id,
      email: user.email,
      name: user.name,
    });

    const client = createClient(port1, { token });
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('connect_error', (err) => reject(err));
    });

    expect(client.connected).toBe(true);
  });

  it('prevents user from joining workspace room without membership, and allows member to join', async () => {
    // Create User A & User B
    const userA = await UserModel.create({
      email: 'usera@example.com',
      passwordHash: 'hash',
      name: 'User A',
    });

    const userB = await UserModel.create({
      email: 'userb@example.com',
      passwordHash: 'hash',
      name: 'User B',
    });

    // Create Workspace A and Workspace B
    const workspaceA = await WorkspaceModel.create({
      name: 'Workspace A',
      ownerId: userA._id,
    });

    const workspaceB = await WorkspaceModel.create({
      name: 'Workspace B',
      ownerId: userB._id,
    });

    // Assign memberships
    await MembershipModel.create({
      workspaceId: workspaceA._id,
      userId: userA._id,
      role: 'owner',
    });

    await MembershipModel.create({
      workspaceId: workspaceB._id,
      userId: userB._id,
      role: 'owner',
    });

    const tokenA = signAccessToken({
      userId: userA.id,
      email: userA.email,
      name: userA.name,
    });

    const clientA = createClient(port1, { token: tokenA });
    await new Promise<void>((resolve) => clientA.on('connect', resolve));

    // 1. User A attempts to join Workspace B (forbidden)
    const joinBResult = await new Promise<{ success: boolean; error?: string }>((resolve) => {
      clientA.emit(
        'join:workspace',
        { workspaceId: workspaceB.id },
        (res: { success: boolean; error?: string }) => resolve(res),
      );
    });
    expect(joinBResult.success).toBe(false);
    expect(joinBResult.error).toBe('FORBIDDEN');

    // 2. User A joins Workspace A (authorized)
    const joinAResult = await new Promise<{ success: boolean; error?: string }>((resolve) => {
      clientA.emit(
        'join:workspace',
        { workspaceId: workspaceA.id },
        (res: { success: boolean; error?: string }) => resolve(res),
      );
    });
    expect(joinAResult.success).toBe(true);
  });

  it('delivers Redis events across two API instances and strictly isolates workspace events', async () => {
    // 1. Seed two tenants (Workspace A and Workspace B)
    const userA = await UserModel.create({
      email: 'tenant-a@example.com',
      passwordHash: 'hash',
      name: 'Tenant A',
    });

    const userB = await UserModel.create({
      email: 'tenant-b@example.com',
      passwordHash: 'hash',
      name: 'Tenant B',
    });

    const workspaceA = await WorkspaceModel.create({
      name: 'Workspace Alpha',
      ownerId: userA._id,
    });

    const workspaceB = await WorkspaceModel.create({
      name: 'Workspace Beta',
      ownerId: userB._id,
    });

    await MembershipModel.create({
      workspaceId: workspaceA._id,
      userId: userA._id,
      role: 'owner',
    });

    await MembershipModel.create({
      workspaceId: workspaceB._id,
      userId: userB._id,
      role: 'owner',
    });

    const tokenA = signAccessToken({
      userId: userA.id,
      email: userA.email,
      name: userA.name,
    });

    const tokenB = signAccessToken({
      userId: userB.id,
      email: userB.email,
      name: userB.name,
    });

    // 2. Connect Client 1 to Instance 1 (Workspace A)
    const client1 = createClient(port1, { token: tokenA });
    await new Promise<void>((resolve) => client1.on('connect', resolve));
    await new Promise<void>((resolve) => {
      client1.emit('join:workspace', { workspaceId: workspaceA.id }, () => resolve());
    });

    // 3. Connect Client 2 to Instance 2 (Workspace B)
    const client2 = createClient(port2, { token: tokenB });
    await new Promise<void>((resolve) => client2.on('connect', resolve));
    await new Promise<void>((resolve) => {
      client2.emit('join:workspace', { workspaceId: workspaceB.id }, () => resolve());
    });

    // 4. Connect Client 3 to Instance 2 (Workspace A) - cross-instance verification
    const client3 = createClient(port2, { token: tokenA });
    await new Promise<void>((resolve) => client3.on('connect', resolve));
    await new Promise<void>((resolve) => {
      client3.emit('join:workspace', { workspaceId: workspaceA.id }, () => resolve());
    });

    // Setup message collectors
    const client1CreatedEvents: EventPubSubMessage[] = [];
    const client1UpdateEvents: EventPubSubMessage[] = [];
    client1.on('event:created', (data) => client1CreatedEvents.push(data));
    client1.on('event:update', (data) => client1UpdateEvents.push(data));

    const client2CreatedEvents: EventPubSubMessage[] = [];
    const client2UpdateEvents: EventPubSubMessage[] = [];
    client2.on('event:created', (data) => client2CreatedEvents.push(data));
    client2.on('event:update', (data) => client2UpdateEvents.push(data));

    const client3CreatedEvents: EventPubSubMessage[] = [];
    const client3UpdateEvents: EventPubSubMessage[] = [];
    client3.on('event:created', (data) => client3CreatedEvents.push(data));
    client3.on('event:update', (data) => client3UpdateEvents.push(data));

    // Wait 100ms for subscription setup
    await new Promise((r) => setTimeout(r, 100));

    // 5. INGEST: Publish 'event.created' to Redis for Workspace A
    const eventCreatedMsg: EventPubSubMessage = {
      type: 'event.created',
      eventId: 'evt-alpha-001',
      endpointId: 'ep-alpha-001',
      workspaceId: workspaceA.id,
      status: 'pending',
      attemptCount: 0,
      timestamp: new Date().toISOString(),
    };
    await redisPublisher.publish('events', JSON.stringify(eventCreatedMsg));

    // 6. WORKER: Publish 'event.status_changed' to Redis for Workspace A
    const eventUpdateMsg: EventPubSubMessage = {
      type: 'event.status_changed',
      eventId: 'evt-alpha-001',
      endpointId: 'ep-alpha-001',
      workspaceId: workspaceA.id,
      status: 'delivered',
      attemptCount: 1,
      timestamp: new Date().toISOString(),
    };
    await redisPublisher.publish('events', JSON.stringify(eventUpdateMsg));

    // 7. WORKER: Publish 'event.dead' to Redis for Workspace B
    const eventDeadBetaMsg: EventPubSubMessage = {
      type: 'event.dead',
      eventId: 'evt-beta-999',
      endpointId: 'ep-beta-999',
      workspaceId: workspaceB.id,
      status: 'dead',
      attemptCount: 8,
      timestamp: new Date().toISOString(),
      error: 'Destination connection refused',
    };
    await redisPublisher.publish('events', JSON.stringify(eventDeadBetaMsg));

    // Allow messages to propagate through Redis adapter and event loops
    await new Promise((r) => setTimeout(r, 400));

    // VERIFICATION 1: Client 1 (Instance 1, Workspace A) receives Workspace A events
    expect(client1CreatedEvents).toHaveLength(1);
    expect(client1CreatedEvents[0].eventId).toBe('evt-alpha-001');
    expect(client1UpdateEvents).toHaveLength(1);
    expect(client1UpdateEvents[0].status).toBe('delivered');

    // VERIFICATION 2: Client 3 (Instance 2, Workspace A) ALSO receives Workspace A events via Redis adapter
    expect(client3CreatedEvents).toHaveLength(1);
    expect(client3CreatedEvents[0].eventId).toBe('evt-alpha-001');
    expect(client3UpdateEvents).toHaveLength(1);
    expect(client3UpdateEvents[0].status).toBe('delivered');

    // VERIFICATION 3 (ACCEPTANCE): Client in Workspace A NEVER receives Workspace B events!
    const client1AllIds = [
      ...client1CreatedEvents.map((e) => e.eventId),
      ...client1UpdateEvents.map((e) => e.eventId),
    ];
    const client3AllIds = [
      ...client3CreatedEvents.map((e) => e.eventId),
      ...client3UpdateEvents.map((e) => e.eventId),
    ];
    expect(client1AllIds).not.toContain('evt-beta-999');
    expect(client3AllIds).not.toContain('evt-beta-999');

    // VERIFICATION 4 (ACCEPTANCE): Client 2 (Workspace B) ONLY receives Workspace B events, NEVER Workspace A!
    expect(client2CreatedEvents).toHaveLength(0);
    expect(client2UpdateEvents).toHaveLength(1);
    expect(client2UpdateEvents[0].eventId).toBe('evt-beta-999');
    expect(client2UpdateEvents[0].status).toBe('dead');
  });

  it('verifies Redis adapter broadcasts room emissions from Instance 1 to sockets on Instance 2', async () => {
    const user = await UserModel.create({
      email: 'adapter-user@example.com',
      passwordHash: 'hash',
      name: 'Adapter User',
    });

    const workspace = await WorkspaceModel.create({
      name: 'Adapter Workspace',
      ownerId: user._id,
    });

    await MembershipModel.create({
      workspaceId: workspace._id,
      userId: user._id,
      role: 'owner',
    });

    const token = signAccessToken({
      userId: user.id,
      email: user.email,
      name: user.name,
    });

    // Client connects to Instance 2
    const clientOnInstance2 = createClient(port2, { token, workspaceId: workspace.id });
    await new Promise<void>((resolve) => clientOnInstance2.on('connect', resolve));

    const receivedMessages: Array<{ text: string }> = [];
    clientOnInstance2.on('adapter:test', (data) => receivedMessages.push(data));

    // Wait 100ms for room join to register in adapter
    await new Promise((r) => setTimeout(r, 100));

    // Instance 1 emits to room ws:<workspace.id>
    io1.to(`ws:${workspace.id}`).emit('adapter:test', { text: 'Cross-instance broadcast!' });

    // Allow Redis adapter to transport packet across instances
    await new Promise((r) => setTimeout(r, 300));

    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0].text).toBe('Cross-instance broadcast!');
  });

  it('supports reconnecting client joining workspace with no lingering in-memory state', async () => {
    const user = await UserModel.create({
      email: 'reconnect-user@example.com',
      passwordHash: 'hash',
      name: 'Reconnect User',
    });

    const workspace = await WorkspaceModel.create({
      name: 'Reconnect Workspace',
      ownerId: user._id,
    });

    await MembershipModel.create({
      workspaceId: workspace._id,
      userId: user._id,
      role: 'owner',
    });

    const token = signAccessToken({
      userId: user.id,
      email: user.email,
      name: user.name,
    });

    // 1. Connect first time to Instance 1
    const clientFirst = createClient(port1, { token, workspaceId: workspace.id });
    await new Promise<void>((resolve) => clientFirst.on('connect', resolve));

    // Disconnect
    clientFirst.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    // 2. Reconnect to a different instance (Instance 2) with handshake auto-join
    const clientReconnected = createClient(port2, { token, workspaceId: workspace.id });
    await new Promise<void>((resolve) => clientReconnected.on('connect', resolve));

    const receivedEvents: EventPubSubMessage[] = [];
    clientReconnected.on('event:created', (data) => receivedEvents.push(data));

    await new Promise((r) => setTimeout(r, 100));

    const msg: EventPubSubMessage = {
      type: 'event.created',
      eventId: 'evt-reconnect-123',
      endpointId: 'ep-123',
      workspaceId: workspace.id,
      status: 'pending',
      attemptCount: 0,
      timestamp: new Date().toISOString(),
    };
    await redisPublisher.publish('events', JSON.stringify(msg));

    await new Promise((r) => setTimeout(r, 300));

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].eventId).toBe('evt-reconnect-123');
  });
});
