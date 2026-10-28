import type { HealthStatus, ReadyStatus } from '@hookpilot/shared';
import {
  type HealthRepository,
  defaultHealthRepository,
} from '../repositories/health.repository.js';

export interface ReadinessResult {
  statusCode: number;
  data: ReadyStatus;
}

export class HealthService {
  constructor(private readonly healthRepo: HealthRepository = defaultHealthRepository) {}

  getLiveness(): HealthStatus {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }

  async getReadiness(): Promise<ReadinessResult> {
    const [mongodb, redis] = await Promise.all([
      this.healthRepo.checkMongo(),
      this.healthRepo.checkRedis(),
    ]);

    const isHealthy = mongodb.status === 'up' && redis.status === 'up';

    return {
      statusCode: isHealthy ? 200 : 503,
      data: {
        status: isHealthy ? 'ready' : 'not_ready',
        timestamp: new Date().toISOString(),
        components: {
          mongodb,
          redis,
        },
      },
    };
  }
}

export const healthService = new HealthService();
