import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getRedisClient } from '../config/redis.js';
import { env } from '../config/env.js';

export function createAuthRateLimiter() {
  if (env.NODE_ENV === 'test') {
    // In test environment, allow high capacity so test suites execute without artificial throttling
    return rateLimit({
      windowMs: 60 * 1000,
      limit: 1000,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    });
  }

  const client = getRedisClient();

  return rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 50, // Limit each IP to 50 auth requests per window
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many authentication attempts, please try again later.',
      },
    },
    store: new RedisStore({
      // @ts-expect-error RedisStoresendCommand typing compatibility with ioredis
      sendCommand: (...args: string[]) => client.call(...args),
      prefix: 'rl:auth:',
    }),
  });
}

export const authRateLimiter = createAuthRateLimiter();
