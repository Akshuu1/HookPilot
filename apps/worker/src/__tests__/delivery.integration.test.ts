import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { AddressInfo } from 'node:net';
import type { Queue, Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { EventModel } from '../models/Event.js';
import { EndpointModel } from '../models/Endpoint.js';
import { DeliveryAttemptModel } from '../models/DeliveryAttempt.js';
import { DeliveryProcessor, type DeliveryJobData } from '../processors/delivery.processor.js';
import { CircuitBreaker } from '../services/circuit-breaker.js';
import * as redisConfig from '../config/redis.js';

let mongoServer: MongoMemoryServer;
const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'job-retry-1' });
const mockRedisPublish = vi.fn().mockResolvedValue(1);

class MockRedis {
  private store = new Map<string, string>();
  private ttls = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string, ...args: (string | number)[]): Promise<'OK' | null> {
    if (args.includes('NX') && this.store.has(key)) return null;
    const exIdx = args.indexOf('EX');
    if (exIdx !== -1 && args[exIdx + 1]) {
      this.ttls.set(key, Number(args[exIdx + 1]));
    }
    this.store.set(key, value);
    return 'OK';
  }
  async incr(key: string): Promise<number> {
    const next = parseInt(this.store.get(key) || '0', 10) + 1;
    this.store.set(key, next.toString());
    return next;
  }
  async ttl(key: string): Promise<number> {
    return this.ttls.get(key) ?? -2;
  }
  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const k of keys) {
      if (this.store.delete(k)) count++;
      this.ttls.delete(k);
    }
    return count;
  }
  multi() {
    const ops: (() => Promise<unknown>)[] = [];
    const proxy = {
      set: (k: string, v: string, ...args: (string | number)[]) => {
        ops.push(() => this.set(k, v, ...args));
        return proxy;
      },
      del: (...keys: string[]) => {
        ops.push(() => this.del(...keys));
        return proxy;
      },
      exec: async () => {
        for (const op of ops) await op();
        return [];
      },
    };
    return proxy;
  }
  async publish(channel: string, message: string): Promise<number> {
    return mockRedisPublish(channel, message);
  }
}

let mockRedisInstance: MockRedis;
let circuitBreakerInstance: CircuitBreaker;
let processor: DeliveryProcessor;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.ALLOW_LOCAL_DESTINATION = 'true';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  mockRedisInstance = new MockRedis();
  circuitBreakerInstance = new CircuitBreaker(mockRedisInstance as unknown as Redis, 5, 60);
  processor = new DeliveryProcessor(circuitBreakerInstance);

  vi.spyOn(redisConfig, 'getRedisClient').mockReturnValue(mockRedisInstance as unknown as Redis);
  vi.spyOn(redisConfig, 'getDeliveryQueue').mockReturnValue({
    add: mockQueueAdd,
  } as unknown as Queue);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  mockQueueAdd.mockClear();
  mockRedisPublish.mockClear();
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key]!.deleteMany({});
  }
});

async function createTestEventAndEndpoint(overrides: {
  destinationUrl: string;
  maxAttempts?: number;
  baseDelayMs?: number;
}) {
  const workspaceId = new Types.ObjectId();

  const endpoint = await EndpointModel.create({
    workspaceId,
    name: 'Test Target Endpoint',
    slug: `ep_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`.slice(0, 16),
    destinationUrl: overrides.destinationUrl,
    signatureConfig: {
      provider: 'none',
      secretEncrypted: null,
    },
    retryPolicy: {
      maxAttempts: overrides.maxAttempts ?? 3,
      baseDelayMs: overrides.baseDelayMs ?? 1000,
      maxDelayMs: 3600000,
    },
    rateLimitPerMin: 60,
    isActive: true,
    mode: 'forward',
  });

  const event = await EventModel.create({
    workspaceId,
    endpointId: endpoint._id,
    receivedAt: new Date(),
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-custom': 'val-123' },
    rawBody: JSON.stringify({ message: 'hello hookpilot' }),
    bodySize: 32,
    contentType: 'application/json',
    sourceIp: '1.2.3.4',
    signatureValid: true,
    idempotencyKey: `idemp_${Date.now()}`,
    status: 'pending',
    attemptCount: 0,
  });

  return { endpoint, event };
}

describe('Delivery Processor & Retry State Machine', () => {
  it('fails N times then succeeds: records attempts, schedules retries, and delivers', async () => {
    let requestCount = 0;
    const receivedHeaders: http.IncomingHttpHeaders[] = [];

    // Local mock server that fails twice (500) then succeeds (200)
    const server = http.createServer((req, res) => {
      requestCount++;
      receivedHeaders.push(req.headers);

      if (requestCount <= 2) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, id: 'ack_123' }));
      }
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const destinationUrl = `http://localhost:${port}/webhook`;

    try {
      const { event } = await createTestEventAndEndpoint({ destinationUrl, maxAttempts: 5 });

      // Attempt 1: Fails with 500
      const res1 = await processor.process({
        id: 'job-1',
        name: 'deliver',
        data: { eventId: event.id, attemptNumber: 1 },
      } as unknown as Job<DeliveryJobData>);

      expect(res1.status).toBe('retry_scheduled');
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);

      const updatedEvent1 = await EventModel.findById(event._id);
      expect(updatedEvent1?.status).toBe('failed');
      expect(updatedEvent1?.attemptCount).toBe(1);
      expect(updatedEvent1?.nextAttemptAt).toBeDefined();

      const attempts1 = await DeliveryAttemptModel.find({ eventId: event._id });
      expect(attempts1).toHaveLength(1);
      expect(attempts1[0]?.responseStatus).toBe(500);
      expect(attempts1[0]?.success).toBe(false);

      // Attempt 2: Fails with 500
      const res2 = await processor.process({
        id: 'job-2',
        name: 'deliver',
        data: { eventId: event.id, attemptNumber: 2 },
      } as unknown as Job<DeliveryJobData>);

      expect(res2.status).toBe('retry_scheduled');
      expect(mockQueueAdd).toHaveBeenCalledTimes(2);

      const updatedEvent2 = await EventModel.findById(event._id);
      expect(updatedEvent2?.status).toBe('failed');
      expect(updatedEvent2?.attemptCount).toBe(2);

      // Attempt 3: Succeeds with 200
      const res3 = await processor.process({
        id: 'job-3',
        name: 'deliver',
        data: { eventId: event.id, attemptNumber: 3 },
      } as unknown as Job<DeliveryJobData>);

      expect(res3.status).toBe('delivered');
      // No further retry job enqueued
      expect(mockQueueAdd).toHaveBeenCalledTimes(2);

      const finalEvent = await EventModel.findById(event._id);
      expect(finalEvent?.status).toBe('delivered');
      expect(finalEvent?.attemptCount).toBe(3);
      expect(finalEvent?.nextAttemptAt).toBeNull();

      const finalAttempts = await DeliveryAttemptModel.find({ eventId: event._id }).sort({
        attemptNumber: 1,
      });
      expect(finalAttempts).toHaveLength(3);
      expect(finalAttempts[2]?.responseStatus).toBe(200);
      expect(finalAttempts[2]?.success).toBe(true);
      expect(finalAttempts[2]?.responseBodySnippet).toContain('ack_123');

      // Verify headers were forwarded correctly
      expect(receivedHeaders[0]?.['x-hookpilot-event-id']).toBe(event.id);
      expect(receivedHeaders[0]?.['x-hookpilot-attempt']).toBe('1');
      expect(receivedHeaders[0]?.['x-hookpilot-signature']).toBeDefined();
    } finally {
      server.close();
    }
  });

  it('permanently fails on 4xx (e.g. 400): moves directly to dead state without retry and publishes event.dead', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad Request: Schema mismatch' }));
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const destinationUrl = `http://localhost:${port}/bad-request`;

    try {
      const { event } = await createTestEventAndEndpoint({ destinationUrl, maxAttempts: 5 });

      const res = await processor.process({
        id: 'job-400',
        name: 'deliver',
        data: { eventId: event.id, attemptNumber: 1 },
      } as unknown as Job<DeliveryJobData>);

      expect(res.status).toBe('dead');
      // Must NOT schedule a retry for 400!
      expect(mockQueueAdd).not.toHaveBeenCalled();

      const deadEvent = await EventModel.findById(event._id);
      expect(deadEvent?.status).toBe('dead');
      expect(deadEvent?.attemptCount).toBe(1);
      expect(deadEvent?.nextAttemptAt).toBeNull();

      const attempts = await DeliveryAttemptModel.find({ eventId: event._id });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.responseStatus).toBe(400);
      expect(attempts[0]?.success).toBe(false);

      // Verify event.dead was published to Redis 'events'
      expect(mockRedisPublish).toHaveBeenCalledWith(
        'events',
        expect.stringContaining('"type":"event.dead"'),
      );
    } finally {
      server.close();
    }
  });

  it('respects Retry-After header on 429 Too Many Requests', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '7', // 7 seconds
      });
      res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const destinationUrl = `http://localhost:${port}/rate-limit`;

    try {
      const { event } = await createTestEventAndEndpoint({
        destinationUrl,
        maxAttempts: 5,
        baseDelayMs: 100,
      });

      const res = await processor.process({
        id: 'job-429',
        name: 'deliver',
        data: { eventId: event.id, attemptNumber: 1 },
      } as unknown as Job<DeliveryJobData>);

      expect(res.status).toBe('retry_scheduled');
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);

      // Verify delay was at least 7000ms (respecting Retry-After: 7)
      const queueCallArgs = mockQueueAdd.mock.calls[0];
      const jobOptions = queueCallArgs[2];
      expect(jobOptions.delay).toBeGreaterThanOrEqual(7000);
    } finally {
      server.close();
    }
  });

  it('unreachable destination: retries until maxAttempts exhausted then transitions to dead state', async () => {
    // Pick an unallocated port that actively refuses connections
    const destinationUrl = 'http://127.0.0.1:59999/unreachable';

    const { event } = await createTestEventAndEndpoint({ destinationUrl, maxAttempts: 2 });

    // Attempt 1: Network error (refusal)
    const res1 = await processor.process({
      id: 'job-fail-1',
      name: 'deliver',
      data: { eventId: event.id, attemptNumber: 1 },
    } as unknown as Job<DeliveryJobData>);

    expect(res1.status).toBe('retry_scheduled');
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);

    const eventAttempt1 = await EventModel.findById(event._id);
    expect(eventAttempt1?.status).toBe('failed');
    expect(eventAttempt1?.attemptCount).toBe(1);

    // Attempt 2: Reaches maxAttempts (2)
    const res2 = await processor.process({
      id: 'job-fail-2',
      name: 'deliver',
      data: { eventId: event.id, attemptNumber: 2 },
    } as unknown as Job<DeliveryJobData>);

    expect(res2.status).toBe('dead');

    const deadEvent = await EventModel.findById(event._id);
    expect(deadEvent?.status).toBe('dead');
    expect(deadEvent?.attemptCount).toBe(2);
    expect(deadEvent?.nextAttemptAt).toBeNull();

    // Verify event.dead was published
    expect(mockRedisPublish).toHaveBeenCalledWith(
      'events',
      expect.stringContaining('"type":"event.dead"'),
    );
  });

  it('rejects SSRF cloud metadata address at delivery time and moves to dead without network call', async () => {
    const destinationUrl = 'http://169.254.169.254/latest/meta-data';
    const { event } = await createTestEventAndEndpoint({ destinationUrl, maxAttempts: 5 });

    const res = await processor.process({
      id: 'job-ssrf',
      name: 'deliver',
      data: { eventId: event.id, attemptNumber: 1 },
    } as unknown as Job<DeliveryJobData>);

    expect(res.status).toBe('ssrf_rejected');
    expect(mockQueueAdd).not.toHaveBeenCalled();

    const deadEvent = await EventModel.findById(event._id);
    expect(deadEvent?.status).toBe('dead');

    const attempts = await DeliveryAttemptModel.find({ eventId: event._id });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.error).toContain('SSRF guard');
    expect(attempts[0]?.success).toBe(false);

    expect(mockRedisPublish).toHaveBeenCalledWith(
      'events',
      expect.stringContaining('"type":"event.dead"'),
    );
  });
});
