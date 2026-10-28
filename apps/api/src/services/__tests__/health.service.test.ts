import { describe, it, expect, vi } from 'vitest';
import { HealthService } from '../health.service.js';
import type { HealthRepository } from '../../repositories/health.repository.js';

describe('HealthService', () => {
  describe('getLiveness', () => {
    it('returns ok status with valid timestamp and uptime', () => {
      const service = new HealthService();
      const liveness = service.getLiveness();

      expect(liveness.status).toBe('ok');
      expect(typeof liveness.timestamp).toBe('string');
      expect(Number.isNaN(Date.parse(liveness.timestamp))).toBe(false);
      expect(liveness.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getReadiness', () => {
    it('returns 200 ready when both MongoDB and Redis are up', async () => {
      const mockRepo: HealthRepository = {
        checkMongo: vi.fn().mockResolvedValue({ status: 'up', latencyMs: 2 }),
        checkRedis: vi.fn().mockResolvedValue({ status: 'up', latencyMs: 1 }),
      };

      const service = new HealthService(mockRepo);
      const { statusCode, data } = await service.getReadiness();

      expect(statusCode).toBe(200);
      expect(data.status).toBe('ready');
      expect(data.components.mongodb.status).toBe('up');
      expect(data.components.redis.status).toBe('up');
    });

    it('returns 503 not_ready when MongoDB is down', async () => {
      const mockRepo: HealthRepository = {
        checkMongo: vi.fn().mockResolvedValue({ status: 'down', error: 'Connection refused' }),
        checkRedis: vi.fn().mockResolvedValue({ status: 'up', latencyMs: 1 }),
      };

      const service = new HealthService(mockRepo);
      const { statusCode, data } = await service.getReadiness();

      expect(statusCode).toBe(503);
      expect(data.status).toBe('not_ready');
      expect(data.components.mongodb.status).toBe('down');
      expect(data.components.redis.status).toBe('up');
    });

    it('returns 503 not_ready when Redis is down', async () => {
      const mockRepo: HealthRepository = {
        checkMongo: vi.fn().mockResolvedValue({ status: 'up', latencyMs: 3 }),
        checkRedis: vi.fn().mockResolvedValue({ status: 'down', error: 'Redis timeout' }),
      };

      const service = new HealthService(mockRepo);
      const { statusCode, data } = await service.getReadiness();

      expect(statusCode).toBe(503);
      expect(data.status).toBe('not_ready');
      expect(data.components.mongodb.status).toBe('up');
      expect(data.components.redis.status).toBe('down');
    });

    it('returns 503 not_ready when both dependencies are down', async () => {
      const mockRepo: HealthRepository = {
        checkMongo: vi.fn().mockResolvedValue({ status: 'down', error: 'DB down' }),
        checkRedis: vi.fn().mockResolvedValue({ status: 'down', error: 'Redis down' }),
      };

      const service = new HealthService(mockRepo);
      const { statusCode, data } = await service.getReadiness();

      expect(statusCode).toBe(503);
      expect(data.status).toBe('not_ready');
      expect(data.components.mongodb.status).toBe('down');
      expect(data.components.redis.status).toBe('down');
    });
  });
});
