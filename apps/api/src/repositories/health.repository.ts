import mongoose from 'mongoose';
import { getRedisClient } from '../config/redis.js';

export interface ComponentCheckResult {
  status: 'up' | 'down';
  latencyMs?: number;
  error?: string;
}

export interface HealthRepository {
  checkMongo(): Promise<ComponentCheckResult>;
  checkRedis(): Promise<ComponentCheckResult>;
}

export class DefaultHealthRepository implements HealthRepository {
  async checkMongo(): Promise<ComponentCheckResult> {
    const start = Date.now();
    try {
      const isConnected = mongoose.connection.readyState === 1;
      if (!isConnected) {
        return {
          status: 'down',
          error: `Mongoose connection state is ${mongoose.connection.readyState}`,
        };
      }
      if (mongoose.connection.db) {
        await mongoose.connection.db.admin().ping();
      }
      return {
        status: 'up',
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        status: 'down',
        error: err instanceof Error ? err.message : 'Unknown MongoDB error',
      };
    }
  }

  async checkRedis(): Promise<ComponentCheckResult> {
    const start = Date.now();
    try {
      const client = getRedisClient();
      const response = await client.ping();
      if (response === 'PONG') {
        return {
          status: 'up',
          latencyMs: Date.now() - start,
        };
      }
      return {
        status: 'down',
        error: `Unexpected Redis ping response: ${response}`,
      };
    } catch (err) {
      return {
        status: 'down',
        error: err instanceof Error ? err.message : 'Unknown Redis error',
      };
    }
  }
}

export const defaultHealthRepository = new DefaultHealthRepository();
