import { describe, it, expect } from 'vitest';
import { computeBackoff } from '../backoff.js';
import { HealthStatusSchema, ReadyStatusSchema } from '../schemas.js';

describe('computeBackoff', () => {
  const baseMs = 1000;
  const maxMs = 30000;

  it('never exceeds maxMs across attempts 1 through 8', () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      for (let i = 0; i < 50; i++) {
        const delay = computeBackoff(attempt, baseMs, maxMs);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(maxMs);
      }
    }
  });

  it('respects exponential ceiling for attempts 1 through 8 at max jitter factor', () => {
    const maxJitter = () => 1; // Upper bound of jitter
    const expectedCeilings = [
      Math.min(maxMs, 1000 * 2 ** 0), // Attempt 1: 1000
      Math.min(maxMs, 1000 * 2 ** 1), // Attempt 2: 2000
      Math.min(maxMs, 1000 * 2 ** 2), // Attempt 3: 4000
      Math.min(maxMs, 1000 * 2 ** 3), // Attempt 4: 8000
      Math.min(maxMs, 1000 * 2 ** 4), // Attempt 5: 16000
      Math.min(maxMs, 1000 * 2 ** 5), // Attempt 6: 30000 (capped by maxMs)
      Math.min(maxMs, 1000 * 2 ** 6), // Attempt 7: 30000 (capped)
      Math.min(maxMs, 1000 * 2 ** 7), // Attempt 8: 30000 (capped)
    ];

    for (let attempt = 1; attempt <= 8; attempt++) {
      const ceiling = expectedCeilings[attempt - 1]!;
      const delay = computeBackoff(attempt, baseMs, maxMs, maxJitter);
      expect(delay).toBe(ceiling);
      expect(delay).toBeLessThanOrEqual(maxMs);
    }
  });

  it('returns 0 when jitter factor is 0', () => {
    const minJitter = () => 0;
    for (let attempt = 1; attempt <= 8; attempt++) {
      const delay = computeBackoff(attempt, baseMs, maxMs, minJitter);
      expect(delay).toBe(0);
    }
  });

  it('handles edge cases gracefully (zero or negative inputs)', () => {
    expect(computeBackoff(1, 0, maxMs)).toBe(0);
    expect(computeBackoff(1, -100, maxMs)).toBe(0);
    expect(computeBackoff(1, baseMs, 0)).toBe(0);
    expect(computeBackoff(1, baseMs, -500)).toBe(0);
    expect(computeBackoff(-5, baseMs, maxMs)).toBeGreaterThanOrEqual(0);
  });
});

describe('Sample Schemas', () => {
  it('validates HealthStatusSchema successfully', () => {
    const valid = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: 42.5,
    };
    expect(HealthStatusSchema.safeParse(valid).success).toBe(true);
  });

  it('validates ReadyStatusSchema successfully', () => {
    const valid = {
      status: 'ready',
      timestamp: new Date().toISOString(),
      components: {
        mongodb: { status: 'up', latencyMs: 3 },
        redis: { status: 'up', latencyMs: 1 },
      },
    };
    expect(ReadyStatusSchema.safeParse(valid).success).toBe(true);
  });
});
