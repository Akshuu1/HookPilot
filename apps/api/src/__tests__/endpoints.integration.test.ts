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

describe('Endpoints Module Integration Tests', () => {
  let ownerToken: string;
  let memberToken: string;
  let viewerToken: string;
  let workspaceId: string;

  beforeEach(async () => {
    // 1. Register owner & create workspace
    const ownerRes = await request(app).post('/auth/register').send({
      email: 'owner@example.com',
      password: 'password123',
      name: 'Owner',
    });
    ownerToken = ownerRes.body.accessToken;

    const wsRes = await request(app)
      .post('/workspaces')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Integration Workspace' });
    workspaceId = wsRes.body.workspace.id;

    // 2. Register member
    const memberRes = await request(app).post('/auth/register').send({
      email: 'member@example.com',
      password: 'password123',
      name: 'Member',
    });
    memberToken = memberRes.body.accessToken;

    // 3. Register viewer
    const viewerRes = await request(app).post('/auth/register').send({
      email: 'viewer@example.com',
      password: 'password123',
      name: 'Viewer',
    });
    viewerToken = viewerRes.body.accessToken;

    // Add them to workspace
    await request(app)
      .post(`/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'member@example.com', role: 'member' });

    await request(app)
      .post(`/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'viewer@example.com', role: 'viewer' });
  });

  describe('Role-based Access & CRUD', () => {
    it('allows member to create endpoint with 12-char slug, default retries, and masked secret', async () => {
      const res = await request(app)
        .post(`/workspaces/${workspaceId}/endpoints`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          name: 'Stripe Ingest',
          destinationUrl: 'https://example.com/webhooks/stripe',
          signatureConfig: {
            provider: 'stripe',
            secret: 'whsec_testsecret1234',
          },
        });

      expect(res.status).toBe(201);
      const ep = res.body.endpoint;
      expect(ep.name).toBe('Stripe Ingest');
      expect(ep.slug).toHaveLength(12);
      expect(ep.retryPolicy.maxAttempts).toBe(8);
      expect(ep.retryPolicy.baseDelayMs).toBe(1000);
      expect(ep.retryPolicy.maxDelayMs).toBe(3600000);
      expect(ep.rateLimitPerMin).toBe(60);
      expect(ep.mode).toBe('forward');
      expect(ep.isActive).toBe(true);

      // Secret is masked, raw secret NEVER returned
      expect(ep.signatureConfig.secretMasked).toBe('****1234');
      expect(ep.signatureConfig.secret).toBeUndefined();
      expect(ep.signatureConfig.secretEncrypted).toBeUndefined();
    });

    it('enforces read-only permissions for viewers (cannot create, update, or delete)', async () => {
      // 1. Viewer attempts to create endpoint -> 403 Forbidden
      const createRes = await request(app)
        .post(`/workspaces/${workspaceId}/endpoints`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({
          name: 'Viewer Endpoint',
          destinationUrl: 'https://example.com/hook',
        });

      expect(createRes.status).toBe(403);
      expect(createRes.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');

      // 2. Member creates an endpoint
      const memberCreateRes = await request(app)
        .post(`/workspaces/${workspaceId}/endpoints`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          name: 'Target Endpoint',
          destinationUrl: 'https://example.com/dest',
        });
      const endpointId = memberCreateRes.body.endpoint.id;

      // 3. Viewer CAN list endpoints -> 200 OK
      const listRes = await request(app)
        .get(`/workspaces/${workspaceId}/endpoints`)
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.endpoints).toHaveLength(1);

      // 4. Viewer CAN read endpoint by ID -> 200 OK
      const getRes = await request(app)
        .get(`/endpoints/${endpointId}`)
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.endpoint.id).toBe(endpointId);

      // 5. Viewer CANNOT update endpoint -> 403 Forbidden
      const updateRes = await request(app)
        .patch(`/endpoints/${endpointId}`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ name: 'Hacked Name' });
      expect(updateRes.status).toBe(403);

      // 6. Viewer CANNOT rotate secret -> 403 Forbidden
      const rotateRes = await request(app)
        .post(`/endpoints/${endpointId}/rotate-secret`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({});
      expect(rotateRes.status).toBe(403);

      // 7. Viewer CANNOT delete endpoint -> 403 Forbidden
      const deleteRes = await request(app)
        .delete(`/endpoints/${endpointId}`)
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(deleteRes.status).toBe(403);

      // 8. Member CAN delete endpoint -> 200 OK
      const memberDeleteRes = await request(app)
        .delete(`/endpoints/${endpointId}`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(memberDeleteRes.status).toBe(200);
    });
  });

  describe('SSRF Rejection', () => {
    it('rejects loopback and private IPv4 addresses', async () => {
      const loopbackRes = await request(app)
        .post(`/workspaces/${workspaceId}/endpoints`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          name: 'Loopback Test',
          destinationUrl: 'http://127.0.0.1:8080/internal',
        });
      expect(loopbackRes.status).toBe(400);
      expect(loopbackRes.body.error.code).toBe('SSRF_DESTINATION_REJECTED');

      const privateRes = await request(app)
        .post(`/workspaces/${workspaceId}/endpoints`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          name: 'Private IP Test',
          destinationUrl: 'http://10.0.0.1/admin',
        });
      expect(privateRes.status).toBe(400);
      expect(privateRes.body.error.code).toBe('SSRF_DESTINATION_REJECTED');
    });

    it('rejects AWS/GCP/Azure cloud metadata IP 169.254.169.254', async () => {
      const res = await request(app)
        .post(`/workspaces/${workspaceId}/endpoints`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          name: 'Metadata Test',
          destinationUrl: 'http://169.254.169.254/latest/meta-data',
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('SSRF_DESTINATION_REJECTED');
    });

    it('rejects IPv6 loopback (::1) and localhost', async () => {
      const ipv6Res = await request(app)
        .post(`/workspaces/${workspaceId}/endpoints`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          name: 'IPv6 Test',
          destinationUrl: 'http://[::1]:3000/hook',
        });
      expect(ipv6Res.status).toBe(400);
      expect(ipv6Res.body.error.code).toBe('SSRF_DESTINATION_REJECTED');

      const localhostRes = await request(app)
        .post(`/workspaces/${workspaceId}/endpoints`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          name: 'Localhost Test',
          destinationUrl: 'http://localhost:5000/events',
        });
      expect(localhostRes.status).toBe(400);
      expect(localhostRes.body.error.code).toBe('SSRF_DESTINATION_REJECTED');
    });
  });

  describe('Secret Rotation & Slug Uniqueness', () => {
    it('rotates secret and returns new raw secret once while masking on subsequent reads', async () => {
      const createRes = await request(app)
        .post(`/workspaces/${workspaceId}/endpoints`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          name: 'Rotation Test',
          destinationUrl: 'https://example.com/dest',
          signatureConfig: { provider: 'github', secret: 'initial-secret-1111' },
        });

      const endpointId = createRes.body.endpoint.id;
      expect(createRes.body.endpoint.signatureConfig.secretMasked).toBe('****1111');

      // Rotate secret
      const rotateRes = await request(app)
        .post(`/endpoints/${endpointId}/rotate-secret`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ secret: 'rotated-secret-8888' });

      expect(rotateRes.status).toBe(200);
      expect(rotateRes.body.secret).toBe('rotated-secret-8888');
      expect(rotateRes.body.secretMasked).toBe('****8888');

      // Subsequent GET should show updated masked secret, NEVER raw secret
      const getRes = await request(app)
        .get(`/endpoints/${endpointId}`)
        .set('Authorization', `Bearer ${memberToken}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.endpoint.signatureConfig.secretMasked).toBe('****8888');
      expect(getRes.body.endpoint.signatureConfig.secret).toBeUndefined();
    });

    it('guarantees unique slugs for multiple endpoints in the same workspace', async () => {
      const slugs = new Set<string>();

      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .post(`/workspaces/${workspaceId}/endpoints`)
          .set('Authorization', `Bearer ${memberToken}`)
          .send({
            name: `Endpoint ${i}`,
            destinationUrl: `https://example.com/dest-${i}`,
          });

        expect(res.status).toBe(201);
        slugs.add(res.body.endpoint.slug);
      }

      expect(slugs.size).toBe(5);
    });
  });
});
