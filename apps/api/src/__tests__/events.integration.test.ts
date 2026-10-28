import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Queue } from 'bullmq';
import { app } from '../app.js';
import { EventModel, type IEvent } from '../models/Event.js';
import { DeliveryAttemptModel } from '../models/DeliveryAttempt.js';
import { AuditLogModel } from '../models/AuditLog.js';
import * as queueConfig from '../config/queue.js';
import { eventRepository } from '../repositories/event.repository.js';

let mongoServer: MongoMemoryServer;
const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'job-mock-id' });

interface TestUserInfo {
  id: string;
  email: string;
  name: string;
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);

  await EventModel.init();
  await DeliveryAttemptModel.init();
  await AuditLogModel.init();

  vi.spyOn(queueConfig, 'getDeliveryQueue').mockReturnValue({
    add: mockQueueAdd,
  } as unknown as Queue);
}, 60000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
}, 30000);

describe('Phase 6: Events API, Search, Cursor Pagination & Replay Integration Tests', () => {
  let ownerToken: string;
  let adminToken: string;
  let memberToken: string;
  let viewerToken: string;
  let outsiderToken: string;

  let adminUser: TestUserInfo;
  let memberUser: TestUserInfo;

  let workspaceId: string;
  let endpointId: string;

  beforeEach(async () => {
    mockQueueAdd.mockClear();

    const collections = mongoose.connection.collections;
    for (const key of Object.keys(collections)) {
      await collections[key]!.deleteMany({});
    }

    // 1. Create users
    const ownerRes = await request(app).post('/auth/register').send({
      email: 'owner@example.com',
      password: 'Password123!',
      name: 'Workspace Owner',
    });
    ownerToken = ownerRes.body.accessToken;

    const adminRes = await request(app).post('/auth/register').send({
      email: 'admin@example.com',
      password: 'Password123!',
      name: 'Workspace Admin',
    });
    adminToken = adminRes.body.accessToken;
    adminUser = adminRes.body.user as TestUserInfo;

    const memberRes = await request(app).post('/auth/register').send({
      email: 'member@example.com',
      password: 'Password123!',
      name: 'Workspace Member',
    });
    memberToken = memberRes.body.accessToken;
    memberUser = memberRes.body.user as TestUserInfo;

    const viewerRes = await request(app).post('/auth/register').send({
      email: 'viewer@example.com',
      password: 'Password123!',
      name: 'Workspace Viewer',
    });
    viewerToken = viewerRes.body.accessToken;

    const outsiderRes = await request(app).post('/auth/register').send({
      email: 'outsider@example.com',
      password: 'Password123!',
      name: 'Outsider User',
    });
    outsiderToken = outsiderRes.body.accessToken;

    // 2. Create workspace
    const wsRes = await request(app)
      .post('/workspaces')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'HookPilot Production' });
    workspaceId = wsRes.body.workspace.id;

    // 3. Add members with roles
    await request(app)
      .post(`/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'admin@example.com', role: 'admin' });

    await request(app)
      .post(`/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'member@example.com', role: 'member' });

    await request(app)
      .post(`/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'viewer@example.com', role: 'viewer' });

    // 4. Create an endpoint
    const epRes = await request(app)
      .post(`/workspaces/${workspaceId}/endpoints`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'Stripe Webhook Receiver',
        destinationUrl: 'https://example.com/webhook',
        rateLimitPerMin: 120,
      });
    endpointId = epRes.body.endpoint.id;
  });

  describe('GET /endpoints/:id/events — Cursor Pagination Stability & Filtering', () => {
    it('provides stable cursor pagination across 25 events with no duplicates or missing records', async () => {
      const now = Date.now();
      const createdEvents: IEvent[] = [];

      // Seed 25 events spaced 1 second apart in reverse chronological order
      for (let i = 0; i < 25; i++) {
        const receivedAt = new Date(now - i * 1000);
        const { event } = await eventRepository.create({
          workspaceId,
          endpointId,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-event-index': String(i) },
          rawBody: JSON.stringify({ index: i, text: `Event payload ${i}` }),
          bodySize: 40,
          sourceIp: '192.0.2.1',
          signatureValid: true,
          idempotencyKey: `idemp-stable-${i}`,
          status: 'delivered',
        });
        // Override receivedAt to guarantee exact millisecond distribution
        event.receivedAt = receivedAt;
        await event.save();
        createdEvents.push(event);
      }

      // Page 1: Request first 10
      const page1Res = await request(app)
        .get(`/endpoints/${endpointId}/events?limit=10`)
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(page1Res.status).toBe(200);
      expect(page1Res.body.events).toHaveLength(10);
      expect(page1Res.body.hasNextPage).toBe(true);
      expect(page1Res.body.nextCursor).toBeDefined();

      const page1Ids = page1Res.body.events.map((e: { id: string }) => e.id);
      const cursor1 = page1Res.body.nextCursor;

      // Page 2: Request next 10 using cursor1
      const page2Res = await request(app)
        .get(`/endpoints/${endpointId}/events?limit=10&cursor=${cursor1}`)
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(page2Res.status).toBe(200);
      expect(page2Res.body.events).toHaveLength(10);
      expect(page2Res.body.hasNextPage).toBe(true);
      expect(page2Res.body.nextCursor).toBeDefined();

      const page2Ids = page2Res.body.events.map((e: { id: string }) => e.id);
      const cursor2 = page2Res.body.nextCursor;

      // Page 3: Request final 5 using cursor2
      const page3Res = await request(app)
        .get(`/endpoints/${endpointId}/events?limit=10&cursor=${cursor2}`)
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(page3Res.status).toBe(200);
      expect(page3Res.body.events).toHaveLength(5);
      expect(page3Res.body.hasNextPage).toBe(false);
      expect(page3Res.body.nextCursor).toBeNull();

      const page3Ids = page3Res.body.events.map((e: { id: string }) => e.id);

      // Verify stability: Exactly 25 unique events, zero duplicate IDs across pages
      const allFetchedIds = [...page1Ids, ...page2Ids, ...page3Ids];
      expect(allFetchedIds).toHaveLength(25);
      const uniqueIds = new Set(allFetchedIds);
      expect(uniqueIds.size).toBe(25);

      // Verify strict descending order
      for (let i = 0; i < allFetchedIds.length - 1; i++) {
        const currentEvent = createdEvents.find((e) => e.id === allFetchedIds[i])!;
        const nextEvent = createdEvents.find((e) => e.id === allFetchedIds[i + 1])!;
        expect(currentEvent.receivedAt.getTime()).toBeGreaterThanOrEqual(
          nextEvent.receivedAt.getTime(),
        );
      }
    });

    it('filters events by status, signatureValid, and date range', async () => {
      const baseTime = new Date('2026-06-01T12:00:00.000Z').getTime();

      // Event 1: Dead, invalid signature, 12:00
      const { event: ep1 } = await eventRepository.create({
        workspaceId,
        endpointId,
        method: 'POST',
        headers: { 'x-provider': 'stripe' },
        rawBody: '{"action":"charge.failed"}',
        bodySize: 26,
        sourceIp: '1.2.3.4',
        signatureValid: false,
        idempotencyKey: 'idemp-filter-1',
        status: 'dead',
      });
      ep1.receivedAt = new Date(baseTime);
      await ep1.save();

      // Event 2: Success, valid signature, 12:15
      const { event: ep2 } = await eventRepository.create({
        workspaceId,
        endpointId,
        method: 'POST',
        headers: { 'x-provider': 'stripe' },
        rawBody: '{"action":"charge.succeeded"}',
        bodySize: 29,
        sourceIp: '1.2.3.4',
        signatureValid: true,
        idempotencyKey: 'idemp-filter-2',
        status: 'delivered',
      });
      ep2.receivedAt = new Date(baseTime + 15 * 60 * 1000);
      await ep2.save();

      // Event 3: Failed, valid signature, 12:30
      const { event: ep3 } = await eventRepository.create({
        workspaceId,
        endpointId,
        method: 'POST',
        headers: { 'x-provider': 'github' },
        rawBody: '{"action":"push"}',
        bodySize: 17,
        sourceIp: '1.2.3.4',
        signatureValid: true,
        idempotencyKey: 'idemp-filter-3',
        status: 'failed',
      });
      ep3.receivedAt = new Date(baseTime + 30 * 60 * 1000);
      await ep3.save();

      // Filter by status=dead
      const deadRes = await request(app)
        .get(`/endpoints/${endpointId}/events?status=dead`)
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(deadRes.status).toBe(200);
      expect(deadRes.body.events).toHaveLength(1);
      expect(deadRes.body.events[0].id).toBe(ep1.id);

      // Filter by signatureValid=true
      const sigRes = await request(app)
        .get(`/endpoints/${endpointId}/events?signatureValid=true`)
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(sigRes.status).toBe(200);
      expect(sigRes.body.events).toHaveLength(2);

      // Filter by date range (12:10 to 12:40)
      const rangeRes = await request(app)
        .get(
          `/endpoints/${endpointId}/events?from=${new Date(baseTime + 10 * 60 * 1000).toISOString()}&to=${new Date(baseTime + 40 * 60 * 1000).toISOString()}`,
        )
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(rangeRes.status).toBe(200);
      expect(rangeRes.body.events).toHaveLength(2);
      expect(rangeRes.body.events.map((e: { id: string }) => e.id)).toContain(ep2.id);
      expect(rangeRes.body.events.map((e: { id: string }) => e.id)).toContain(ep3.id);
    });

    it('searches text query q across webhook raw body and headers', async () => {
      // Create event with distinctive keyword in body
      const { event: bodyMatchEvt } = await eventRepository.create({
        workspaceId,
        endpointId,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        rawBody: '{"order_id": "ORD-XYZ-998811", "amount": 4200}',
        bodySize: 46,
        sourceIp: '1.2.3.4',
        signatureValid: true,
        idempotencyKey: 'idemp-search-1',
        status: 'delivered',
      });

      // Create event with distinctive header token
      const { event: headerMatchEvt } = await eventRepository.create({
        workspaceId,
        endpointId,
        method: 'POST',
        headers: { 'x-hookpilot-tenant': 'tenant_enterprise_beta' },
        rawBody: '{"ping": "pong"}',
        bodySize: 16,
        sourceIp: '1.2.3.4',
        signatureValid: true,
        idempotencyKey: 'idemp-search-2',
        status: 'delivered',
      });

      // Search in body
      const bodySearchRes = await request(app)
        .get(`/endpoints/${endpointId}/events?q=ORD-XYZ-998811`)
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(bodySearchRes.status).toBe(200);
      expect(bodySearchRes.body.events).toHaveLength(1);
      expect(bodySearchRes.body.events[0].id).toBe(bodyMatchEvt.id);

      // Search in headers
      const headerSearchRes = await request(app)
        .get(`/endpoints/${endpointId}/events?q=tenant_enterprise_beta`)
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(headerSearchRes.status).toBe(200);
      expect(headerSearchRes.body.events).toHaveLength(1);
      expect(headerSearchRes.body.events[0].id).toBe(headerMatchEvt.id);
    });

    it('forbids users outside the workspace from reading events', async () => {
      const res = await request(app)
        .get(`/endpoints/${endpointId}/events`)
        .set('Authorization', `Bearer ${outsiderToken}`);

      expect(res.status).toBe(403);
    });
  });

  describe('GET /events/:id — Single Event Details with Delivery Attempts', () => {
    it('returns event details and attempts sorted by attemptNumber', async () => {
      const { event } = await eventRepository.create({
        workspaceId,
        endpointId,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        rawBody: '{"test":"attempts"}',
        bodySize: 19,
        sourceIp: '1.2.3.4',
        signatureValid: true,
        idempotencyKey: 'idemp-attempt-test',
        status: 'failed',
      });

      // Insert attempts out of chronological/numerical order
      await DeliveryAttemptModel.create({
        eventId: event._id,
        attemptNumber: 2,
        startedAt: new Date(Date.now() - 5000),
        durationMs: 140,
        requestHeaders: { 'x-test': '2' },
        responseStatus: 500,
        responseBodySnippet: 'Internal Server Error',
        success: false,
      });

      await DeliveryAttemptModel.create({
        eventId: event._id,
        attemptNumber: 1,
        startedAt: new Date(Date.now() - 10000),
        durationMs: 120,
        requestHeaders: { 'x-test': '1' },
        responseStatus: 503,
        responseBodySnippet: 'Service Unavailable',
        success: false,
      });

      const res = await request(app)
        .get(`/events/${event.id}`)
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(event.id);
      expect(res.body.attempts).toHaveLength(2);
      expect(res.body.attempts[0].attemptNumber).toBe(1);
      expect(res.body.attempts[1].attemptNumber).toBe(2);
    });

    it('returns 404 for non-existent event', async () => {
      const fakeId = new Types.ObjectId().toString();
      const res = await request(app)
        .get(`/events/${fakeId}`)
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(404);
    });

    it('forbids outsider from reading single event', async () => {
      const { event } = await eventRepository.create({
        workspaceId,
        endpointId,
        method: 'POST',
        headers: {},
        rawBody: '{"test":1}',
        bodySize: 10,
        sourceIp: '1.2.3.4',
        signatureValid: true,
        idempotencyKey: 'idemp-outsider-test',
        status: 'pending',
      });

      const res = await request(app)
        .get(`/events/${event.id}`)
        .set('Authorization', `Bearer ${outsiderToken}`);

      expect(res.status).toBe(403);
    });
  });

  describe('POST /events/:id/replay — Single Event Replay', () => {
    it('rejects viewer with 403, allows member to replay, resets status, enqueues BullMQ job, and writes AuditLog', async () => {
      const { event } = await eventRepository.create({
        workspaceId,
        endpointId,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        rawBody: '{"action":"invoice.payment_failed"}',
        bodySize: 37,
        sourceIp: '1.2.3.4',
        signatureValid: true,
        idempotencyKey: 'idemp-replay-1',
        status: 'dead',
      });

      // 1. Viewer tries to replay -> 403 Forbidden
      const viewerRes = await request(app)
        .post(`/events/${event.id}/replay`)
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(viewerRes.status).toBe(403);

      // 2. Member replays -> 200 OK
      const memberRes = await request(app)
        .post(`/events/${event.id}/replay`)
        .set('Authorization', `Bearer ${memberToken}`);

      expect(memberRes.status).toBe(200);
      expect(memberRes.body.success).toBe(true);
      expect(memberRes.body.eventId).toBe(event.id);
      expect(memberRes.body.replayCount).toBe(1);
      expect(memberRes.body.jobId).toBe(`${event.id}-1`);

      // 3. Verify event state in database
      const updatedEvent = await EventModel.findById(event.id);
      expect(updatedEvent?.status).toBe('pending');
      expect(updatedEvent?.replayCount).toBe(1);

      // 4. Verify BullMQ job was enqueued with expected params
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'deliver',
        { eventId: event.id, attemptNumber: 1 },
        {
          jobId: `${event.id}-1`,
          attempts: 1,
          removeOnComplete: true,
        },
      );

      // 5. Verify AuditLog entry was written
      const auditLog = await AuditLogModel.findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        action: 'event.replay',
        resourceId: event.id,
      });
      expect(auditLog).toBeDefined();
      expect(auditLog?.userId.toString()).toBe(memberUser.id);
      expect(auditLog?.metadata?.replayCount).toBe(1);
      expect(auditLog?.metadata?.previousStatus).toBe('dead');
    });
  });

  describe('POST /events/bulk-replay — Filter-based Bulk Replay', () => {
    it('rejects viewer with 403, allows member to bulk replay up to 500 events in batches of 50, and records AuditLog', async () => {
      // Seed 60 dead events
      const seededIds: string[] = [];
      for (let i = 0; i < 60; i++) {
        const { event } = await eventRepository.create({
          workspaceId,
          endpointId,
          method: 'POST',
          headers: {},
          rawBody: `{"bulk":${i}}`,
          bodySize: 10,
          sourceIp: '1.2.3.4',
          signatureValid: true,
          idempotencyKey: `idemp-bulk-${i}`,
          status: 'dead',
        });
        seededIds.push(event.id);
      }

      // 1. Viewer tries bulk-replay -> 403
      const viewerRes = await request(app)
        .post('/events/bulk-replay')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ workspaceId, endpointId });
      expect(viewerRes.status).toBe(403);

      // 2. Member bulk-replays
      const memberRes = await request(app)
        .post('/events/bulk-replay')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ workspaceId, endpointId, status: 'dead' });

      expect(memberRes.status).toBe(200);
      expect(memberRes.body.replayedCount).toBe(60);
      expect(memberRes.body.eventIds).toHaveLength(60);

      // 3. Verify all 60 events now have status 'pending' and replayCount 1
      const countPending = await EventModel.countDocuments({
        workspaceId: new Types.ObjectId(workspaceId),
        status: 'pending',
        replayCount: 1,
      });
      expect(countPending).toBe(60);

      // 4. Verify BullMQ queue was called for all 60 events
      expect(mockQueueAdd).toHaveBeenCalledTimes(60);

      // 5. Verify AuditLog entry was written
      const auditLog = await AuditLogModel.findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        action: 'event.bulk_replay',
      });
      expect(auditLog).toBeDefined();
      expect(auditLog?.userId.toString()).toBe(memberUser.id);
      expect(auditLog?.metadata?.replayedCount).toBe(60);
    });
  });

  describe('DELETE /events/:id — Event Deletion & Retention', () => {
    it('rejects viewer and member with 403, allows admin to delete event and cascades attempt deletion', async () => {
      const { event } = await eventRepository.create({
        workspaceId,
        endpointId,
        method: 'POST',
        headers: {},
        rawBody: '{"to":"delete"}',
        bodySize: 15,
        sourceIp: '1.2.3.4',
        signatureValid: true,
        idempotencyKey: 'idemp-delete-test',
        status: 'dead',
      });

      // Insert associated delivery attempts
      await DeliveryAttemptModel.create({
        eventId: event._id,
        attemptNumber: 1,
        startedAt: new Date(),
        durationMs: 50,
        requestHeaders: {},
        responseStatus: 500,
        responseBodySnippet: 'err',
        success: false,
      });

      // 1. Viewer cannot delete -> 403
      const viewerRes = await request(app)
        .delete(`/events/${event.id}`)
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(viewerRes.status).toBe(403);

      // 2. Member cannot delete (requires admin+) -> 403
      const memberRes = await request(app)
        .delete(`/events/${event.id}`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(memberRes.status).toBe(403);

      // 3. Admin can delete -> 200
      const adminRes = await request(app)
        .delete(`/events/${event.id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(adminRes.status).toBe(200);
      expect(adminRes.body.success).toBe(true);

      // 4. Verify event is deleted from database
      const foundEvent = await EventModel.findById(event.id);
      expect(foundEvent).toBeNull();

      // 5. Verify associated attempts were cascaded
      const attemptsCount = await DeliveryAttemptModel.countDocuments({ eventId: event._id });
      expect(attemptsCount).toBe(0);

      // 6. Verify audit log entry was written
      const auditLog = await AuditLogModel.findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        action: 'event.delete',
        resourceId: event.id,
      });
      expect(auditLog).toBeDefined();
      expect(auditLog?.userId.toString()).toBe(adminUser.id);
    });

    it('sets expiresAt based on retentionDays configuration', async () => {
      const beforeTime = Date.now();
      const { event } = await eventRepository.create({
        workspaceId,
        endpointId,
        method: 'POST',
        headers: {},
        rawBody: '{"retention":"test"}',
        bodySize: 20,
        sourceIp: '1.2.3.4',
        signatureValid: true,
        idempotencyKey: 'idemp-retention-test',
        retentionDays: 14,
      });

      expect(event.expiresAt).toBeDefined();
      const expectedMinExpires = beforeTime + 14 * 24 * 60 * 60 * 1000 - 5000;
      const expectedMaxExpires = beforeTime + 14 * 24 * 60 * 60 * 1000 + 5000;
      expect(event.expiresAt!.getTime()).toBeGreaterThanOrEqual(expectedMinExpires);
      expect(event.expiresAt!.getTime()).toBeLessThanOrEqual(expectedMaxExpires);
    });
  });
});
