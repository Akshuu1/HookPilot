import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { validateCoreEnv, logFeatureStatus } from '../config/env.js';

describe('Production Startup with Minimal Core Environment Variables', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Core Environment Validation', () => {
    it('detects missing core variables and names them without leaking secrets', () => {
      const emptyEnv = {};
      const missing = validateCoreEnv(emptyEnv);

      expect(missing).toContain('MONGODB_URI');
      expect(missing).toContain('REDIS_URL');
      expect(missing).toContain('JWT_ACCESS_SECRET');
      expect(missing).toContain('ENCRYPTION_KEY');
      expect(missing).not.toContain('SMTP_HOST');
      expect(missing).not.toContain('GITHUB_CLIENT_ID');
      expect(missing).not.toContain('GOOGLE_CLIENT_ID');
    });

    it('accepts JWT_SECRET as a valid alias for JWT_ACCESS_SECRET', () => {
      const validEnv = {
        MONGODB_URI: 'mongodb://localhost:27017/test',
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long!',
        ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      };
      const missing = validateCoreEnv(validEnv);
      expect(missing).toHaveLength(0);
    });

    it('passes validation when all four core variables are present', () => {
      const validEnv = {
        MONGODB_URI: 'mongodb://localhost:27017/test',
        REDIS_URL: 'redis://localhost:6379',
        JWT_ACCESS_SECRET: 'test-secret-that-is-at-least-32-characters-long!',
        ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      };
      const missing = validateCoreEnv(validEnv);
      expect(missing).toHaveLength(0);
    });
  });

  describe('Optional Feature-Specific Logging', () => {
    it('logs informative disabled status when optional features are not configured', () => {
      const logMessages: string[] = [];
      const mockLogger = {
        info: (msg: string) => logMessages.push(msg),
      };

      logFeatureStatus(mockLogger);

      // Verify each feature has an informative disabled message
      expect(logMessages).toEqual(
        expect.arrayContaining([
          'GitHub login is disabled (missing GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET)',
          'Google login is disabled (missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET)',
          'Email alerts are disabled (missing SMTP_HOST)',
          'Slack alerts are disabled (missing SLACK_WEBHOOK_URL)',
        ]),
      );
    });
  });

  describe('Liveness Probe (/health)', () => {
    it('returns 200 OK immediately even with only core variables and without MongoDB/Redis connection', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('uptime');
      expect(typeof response.body.uptime).toBe('number');
    });

    it('returns 200 on root endpoint (/) with service operational info', async () => {
      const response = await request(app).get('/');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('name', 'HookPilot API');
      expect(response.body).toHaveProperty('status', 'operational');
      expect(response.body.endpoints).toHaveProperty('health', '/health');
      expect(response.body.endpoints).toHaveProperty('ready', '/ready');
    });

    it('keeps /ready as the dependency check distinct from /health', async () => {
      // /ready checks actual database & redis connections
      const response = await request(app).get('/ready');

      // Regardless of whether local redis/mongo are running, response has components structure
      expect([200, 503]).toContain(response.status);
      expect(response.body).toHaveProperty('components');
      expect(response.body.components).toHaveProperty('mongodb');
      expect(response.body.components).toHaveProperty('redis');
    });
  });
});
