import { describe, it, expect, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { CircuitBreaker } from '../services/circuit-breaker.js';

class MockRedis {
  private store = new Map<string, string>();
  private ttls = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<'OK' | null> {
    const isNx = args.includes('NX');
    if (isNx && this.store.has(key)) {
      return null;
    }

    const exIndex = args.indexOf('EX');
    if (exIndex !== -1 && args[exIndex + 1]) {
      this.ttls.set(key, Number(args[exIndex + 1]));
    }

    this.store.set(key, value);
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    const current = parseInt(this.store.get(key) || '0', 10);
    const next = current + 1;
    this.store.set(key, next.toString());
    return next;
  }

  async ttl(key: string): Promise<number> {
    return this.ttls.get(key) ?? -2;
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
      this.ttls.delete(key);
    }
    return count;
  }

  multi() {
    const commands: (() => Promise<unknown>)[] = [];
    const proxy = {
      set: (key: string, val: string, ...args: (string | number)[]) => {
        commands.push(() => this.set(key, val, ...args));
        return proxy;
      },
      del: (...keys: string[]) => {
        commands.push(() => this.del(...keys));
        return proxy;
      },
      exec: async () => {
        for (const cmd of commands) {
          await cmd();
        }
        return [];
      },
    };
    return proxy;
  }

  // Helper for tests to simulate time passing
  expireCooldown(key: string) {
    this.ttls.set(key, 0);
  }
}

describe('CircuitBreaker', () => {
  let mockRedis: MockRedis;
  let cb: CircuitBreaker;
  const endpointId = 'ep_test_cb_123';

  beforeEach(() => {
    mockRedis = new MockRedis();
    cb = new CircuitBreaker(mockRedis as unknown as Redis, 5, 60);
  });

  it('initially allows deliveries in CLOSED state', async () => {
    const check = await cb.canExecute(endpointId);
    expect(check.allowed).toBe(true);
  });

  it('trips to OPEN after 5 consecutive failures and pauses deliveries for 60s', async () => {
    // 4 failures: should not trip yet
    for (let i = 1; i <= 4; i++) {
      const result = await cb.recordFailure(endpointId);
      expect(result.tripped).toBe(false);
      const check = await cb.canExecute(endpointId);
      expect(check.allowed).toBe(true);
    }

    // 5th failure: trips circuit breaker
    const tripResult = await cb.recordFailure(endpointId);
    expect(tripResult.tripped).toBe(true);

    // Next check should be disallowed
    const blockedCheck = await cb.canExecute(endpointId);
    expect(blockedCheck.allowed).toBe(false);
    expect(blockedCheck.waitMs).toBe(60000);
    expect(blockedCheck.reason).toContain('Circuit breaker OPEN');
  });

  it('allows one probe when cooldown expires and transitions to HALF_OPEN', async () => {
    // Trip to OPEN
    for (let i = 0; i < 5; i++) {
      await cb.recordFailure(endpointId);
    }

    // Simulate cooldown expiring
    mockRedis.expireCooldown(`cb:${endpointId}:cooldown`);

    // First check after cooldown should be allowed as probe
    const probeCheck = await cb.canExecute(endpointId);
    expect(probeCheck.allowed).toBe(true);

    // Second check while probe is in flight should be blocked
    const concurrentCheck = await cb.canExecute(endpointId);
    expect(concurrentCheck.allowed).toBe(false);
    expect(concurrentCheck.reason).toContain('HALF_OPEN');
  });

  it('resets to CLOSED when probe succeeds', async () => {
    // Trip to OPEN then expire cooldown
    for (let i = 0; i < 5; i++) {
      await cb.recordFailure(endpointId);
    }
    mockRedis.expireCooldown(`cb:${endpointId}:cooldown`);
    await cb.canExecute(endpointId); // triggers HALF_OPEN probe

    // Probe succeeds!
    await cb.recordSuccess(endpointId);

    // Should now be back in normal CLOSED state
    const afterSuccessCheck = await cb.canExecute(endpointId);
    expect(afterSuccessCheck.allowed).toBe(true);
  });

  it('re-trips to OPEN for another 60s cooldown if probe fails in HALF_OPEN', async () => {
    // Trip to OPEN then expire cooldown
    for (let i = 0; i < 5; i++) {
      await cb.recordFailure(endpointId);
    }
    mockRedis.expireCooldown(`cb:${endpointId}:cooldown`);
    await cb.canExecute(endpointId); // triggers HALF_OPEN probe

    // Probe fails!
    const tripResult = await cb.recordFailure(endpointId);
    expect(tripResult.tripped).toBe(true);

    // Should be blocked again
    const reblockedCheck = await cb.canExecute(endpointId);
    expect(reblockedCheck.allowed).toBe(false);
    expect(reblockedCheck.waitMs).toBe(60000);
  });
});
