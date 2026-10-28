import type { Response } from 'express';
import { getRedisClient } from '../config/redis.js';
import { env } from '../config/env.js';

/**
 * Sliding-window rate limiter per endpoint using Redis sorted sets.
 * If limit is exceeded, responds 429 with Retry-After header.
 */
export async function checkEndpointRateLimit(
  endpointId: string,
  rateLimitPerMin: number,
  res: Response,
): Promise<boolean> {
  if (env.NODE_ENV === 'test') {
    return true; // Bypass rate limiting during test executions
  }

  try {
    const redis = getRedisClient();
    const key = `rl:endpoint:${endpointId}`;
    const now = Date.now();
    const windowStart = now - 60000; // 60-second sliding window

    // Remove expired entries
    await redis.zremrangebyscore(key, 0, windowStart);

    // Count hits in current window
    const currentHits = await redis.zcard(key);

    if (currentHits >= rateLimitPerMin) {
      // Find oldest entry in current window to calculate Retry-After
      const oldestEntries = await redis.zrange(key, 0, 0, 'WITHSCORES');
      let retryAfterSec = 60;
      if (oldestEntries.length >= 2) {
        const oldestScore = parseInt(oldestEntries[1]!, 10);
        if (!Number.isNaN(oldestScore)) {
          const waitMs = oldestScore + 60000 - now;
          retryAfterSec = Math.max(1, Math.ceil(waitMs / 1000));
        }
      }

      res.setHeader('Retry-After', retryAfterSec.toString());
      res.status(429).json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Endpoint rate limit of ${rateLimitPerMin} req/min exceeded.`,
          retryAfter: retryAfterSec,
        },
      });
      return false;
    }

    // Record this hit
    const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;
    await redis.zadd(key, now, member);
    await redis.expire(key, 65); // Expire slightly after the window

    return true;
  } catch {
    // If Redis encounters a failure, fail open to avoid dropping webhooks
    return true;
  }
}
