import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { performTunnelDelivery } from '../services/delivery.service.js';
import type { IEvent } from '../models/Event.js';
import type { IEndpoint } from '../models/Endpoint.js';

let mongoServer: MongoMemoryServer;
let redisHelper: Redis;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  redisHelper = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
});

afterAll(async () => {
  await redisHelper.quit();
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  // Clean up any test keys
  const keys = await redisHelper.keys('tunnel:*');
  if (keys.length > 0) {
    await redisHelper.del(...keys);
  }
});

describe('Worker Tunnel Delivery Routing', () => {
  it('returns null immediately when no CLI session is registered in Redis', async () => {
    const fakeEvent = {
      _id: new mongoose.Types.ObjectId(),
      id: 'evt-1',
      rawBody: '{"test":123}',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    } as unknown as IEvent;

    const fakeEndpoint = {
      _id: new mongoose.Types.ObjectId(),
      id: 'ep-1',
      slug: 'my-slug',
      destinationUrl: 'http://example.com/dest',
    } as unknown as IEndpoint;

    const result = await performTunnelDelivery(fakeEvent, fakeEndpoint, 1, 1000);
    expect(result).toBeNull();
  });

  it('routes to tunnel and resolves response when CLI responds via Redis', async () => {
    const endpointId = new mongoose.Types.ObjectId();
    const eventId = new mongoose.Types.ObjectId();

    // Register active CLI session in Redis
    await redisHelper.set(`tunnel:endpoint:${endpointId.toString()}`, 'mock-socket-id', 'EX', 30);

    const fakeEvent = {
      _id: eventId,
      id: eventId.toString(),
      rawBody: '{"hello":"cli"}',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    } as unknown as IEvent;

    const fakeEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      slug: 'cli-endpoint',
      destinationUrl: 'http://example.com/dest',
    } as unknown as IEndpoint;

    // Simulate mock CLI responding over Redis
    const cliSub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    cliSub.subscribe('tunnel:requests', () => {});
    cliSub.on('message', async (channel, msg) => {
      if (channel === 'tunnel:requests') {
        const req = JSON.parse(msg);
        if (req.eventId === eventId.toString()) {
          const cliPub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
          await cliPub.publish(
            `tunnel:response:${eventId.toString()}`,
            JSON.stringify({
              eventId: eventId.toString(),
              responseStatus: 200,
              responseBodySnippet: '{"ok":true}',
              durationMs: 12,
              responseHeaders: { 'x-powered-by': 'local-express' },
            }),
          );
          await cliPub.quit();
        }
      }
    });

    const result = await performTunnelDelivery(fakeEvent, fakeEndpoint, 1, 5000);

    await cliSub.unsubscribe();
    await cliSub.quit();

    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);
    expect(result!.responseBodySnippet).toBe('{"ok":true}');
    expect(result!.durationMs).toBe(12);
  });

  it('returns null on timeout so processor falls back to normal delivery', async () => {
    const endpointId = new mongoose.Types.ObjectId();
    const eventId = new mongoose.Types.ObjectId();

    // Register active CLI session in Redis, but do not respond
    await redisHelper.set(`tunnel:endpoint:${endpointId.toString()}`, 'mock-socket-id', 'EX', 30);

    const fakeEvent = {
      _id: eventId,
      id: eventId.toString(),
      rawBody: '{"hello":"timeout"}',
      method: 'POST',
      headers: {},
    } as unknown as IEvent;

    const fakeEndpoint = {
      _id: endpointId,
      id: endpointId.toString(),
      slug: 'timeout-endpoint',
      destinationUrl: 'http://example.com/dest',
    } as unknown as IEndpoint;

    // Short timeout of 200ms
    const result = await performTunnelDelivery(fakeEvent, fakeEndpoint, 1, 200);
    expect(result).toBeNull();
  });
});
