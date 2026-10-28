import type { Redis } from 'ioredis';
import { getRedisClient } from '../config/redis.js';
import { logger } from '../config/logger.js';

export interface CircuitCheckResult {
  allowed: boolean;
  waitMs?: number;
  reason?: string;
}

export class CircuitBreaker {
  private readonly redis: Redis;
  private readonly failureThreshold: number;
  private readonly cooldownSeconds: number;

  constructor(redisClient?: Redis, failureThreshold = 5, cooldownSeconds = 60) {
    this.redis = redisClient || getRedisClient();
    this.failureThreshold = failureThreshold;
    this.cooldownSeconds = cooldownSeconds;
  }

  private failureKey(endpointId: string): string {
    return `cb:${endpointId}:failures`;
  }

  private stateKey(endpointId: string): string {
    return `cb:${endpointId}:state`;
  }

  private cooldownKey(endpointId: string): string {
    return `cb:${endpointId}:cooldown`;
  }

  private probeKey(endpointId: string): string {
    return `cb:${endpointId}:probe`;
  }

  /**
   * Checks whether delivery can proceed for an endpoint.
   * If circuit is OPEN during cooldown, delivery is paused.
   * After 60s cooldown, allows exactly one probe through (HALF_OPEN).
   */
  async canExecute(endpointId: string): Promise<CircuitCheckResult> {
    const state = await this.redis.get(this.stateKey(endpointId));

    if (!state || state === 'CLOSED') {
      return { allowed: true };
    }

    if (state === 'OPEN') {
      const ttl = await this.redis.ttl(this.cooldownKey(endpointId));
      if (ttl > 0) {
        return {
          allowed: false,
          waitMs: ttl * 1000,
          reason: `Circuit breaker OPEN: paused for ${ttl}s cooldown`,
        };
      }

      // Cooldown expired; transition to HALF_OPEN to allow one probe
      await this.redis.set(this.stateKey(endpointId), 'HALF_OPEN');
      const acquired = await this.redis.set(this.probeKey(endpointId), '1', 'EX', 15, 'NX');
      if (acquired === 'OK') {
        logger.info({ endpointId }, 'Circuit breaker transitioning to HALF_OPEN: sending probe');
        return { allowed: true };
      }

      return {
        allowed: false,
        waitMs: 5000,
        reason: 'Circuit breaker HALF_OPEN: probe already in flight',
      };
    }

    if (state === 'HALF_OPEN') {
      // Allow only one probe at a time
      const acquired = await this.redis.set(this.probeKey(endpointId), '1', 'EX', 15, 'NX');
      if (acquired === 'OK') {
        return { allowed: true };
      }
      return {
        allowed: false,
        waitMs: 5000,
        reason: 'Circuit breaker HALF_OPEN: probe in progress',
      };
    }

    return { allowed: true };
  }

  /**
   * Records a successful delivery, resetting failure counters and closing the circuit.
   */
  async recordSuccess(endpointId: string): Promise<void> {
    await this.redis
      .multi()
      .set(this.failureKey(endpointId), '0')
      .set(this.stateKey(endpointId), 'CLOSED')
      .del(this.cooldownKey(endpointId), this.probeKey(endpointId))
      .exec();
  }

  /**
   * Records a delivery failure. After 5 consecutive failures, trips the circuit
   * breaker to OPEN and pauses deliveries for 60 seconds.
   */
  async recordFailure(endpointId: string): Promise<{ tripped: boolean }> {
    const state = await this.redis.get(this.stateKey(endpointId));

    // If a probe failed in HALF_OPEN, immediately trip back to OPEN for cooldown
    if (state === 'HALF_OPEN') {
      logger.warn({ endpointId }, 'Circuit breaker probe failed: returning to OPEN for cooldown');
      await this.redis
        .multi()
        .set(this.stateKey(endpointId), 'OPEN')
        .set(this.cooldownKey(endpointId), '1', 'EX', this.cooldownSeconds)
        .del(this.probeKey(endpointId))
        .exec();
      return { tripped: true };
    }

    const failures = await this.redis.incr(this.failureKey(endpointId));

    if (failures >= this.failureThreshold) {
      logger.warn(
        { endpointId, failures },
        `Circuit breaker tripped after ${failures} consecutive failures. Pausing deliveries for ${this.cooldownSeconds}s.`,
      );

      await this.redis
        .multi()
        .set(this.stateKey(endpointId), 'OPEN')
        .set(this.cooldownKey(endpointId), '1', 'EX', this.cooldownSeconds)
        .del(this.probeKey(endpointId))
        .exec();

      return { tripped: true };
    }

    return { tripped: false };
  }

  /**
   * Resets the circuit breaker state (useful for tests or admin interventions).
   */
  async reset(endpointId: string): Promise<void> {
    await this.redis.del(
      this.failureKey(endpointId),
      this.stateKey(endpointId),
      this.cooldownKey(endpointId),
      this.probeKey(endpointId),
    );
  }
}

export const circuitBreaker = new CircuitBreaker();
