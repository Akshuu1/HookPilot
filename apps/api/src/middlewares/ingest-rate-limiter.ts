import type { Response } from 'express';
import { getRedisClient } from '../config/redis.js';
import { env } from '../config/env.js';

// Pre-define Lua script for atomic sliding window evaluation in 1 network round-trip
const SLIDING_WINDOW_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])
local currentHits = redis.call('ZCARD', KEYS[1])
if currentHits >= tonumber(ARGV[4]) then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local oldestScore = oldest[2] or ARGV[2]
  return { 0, tonumber(oldestScore) }
else
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
  return { 1, currentHits + 1 }
end
`;

/**
 * Sliding-window rate limiter per endpoint using atomic Redis Lua script.
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
    const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;

    const result = (await redis.eval(
      SLIDING_WINDOW_LUA,
      1,
      key,
      windowStart,
      now,
      member,
      rateLimitPerMin,
      65,
    )) as [number, number];

    const [allowed, oldestOrCount] = result;

    if (allowed === 0) {
      const waitMs = oldestOrCount + 60000 - now;
      const retryAfterSec = Math.max(1, Math.ceil(waitMs / 1000));

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

    return true;
  } catch {
    // If Redis encounters a failure, fail open to avoid dropping webhooks
    return true;
  }
}
