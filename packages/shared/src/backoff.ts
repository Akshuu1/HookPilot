/**
 * Computes exponential backoff with full jitter.
 * Formula: min(maxMs, baseMs * 2^(attempt - 1)) with uniform random jitter in [0, ceiling].
 *
 * @param attempt 1-indexed attempt number (e.g., 1, 2, 3...)
 * @param baseMs Base backoff duration in milliseconds (e.g., 1000)
 * @param maxMs Maximum backoff duration ceiling in milliseconds (e.g., 60000)
 * @param randomFn Optional random generator (defaults to Math.random)
 * @returns Delay in milliseconds between 0 and min(maxMs, baseMs * 2^(attempt - 1))
 */
export function computeBackoff(
  attempt: number,
  baseMs: number,
  maxMs: number,
  randomFn: () => number = Math.random,
): number {
  if (baseMs <= 0 || maxMs <= 0) {
    return 0;
  }

  const safeAttempt = Math.max(1, Math.floor(attempt));
  const exponentialDelay = baseMs * Math.pow(2, safeAttempt - 1);
  const ceiling = Math.min(maxMs, exponentialDelay);

  // Full jitter: uniformly distributed between 0 and ceiling
  const jitter = Math.max(0, Math.min(1, randomFn()));
  const delay = Math.floor(jitter * (ceiling + 1));
  return Math.min(ceiling, delay);
}
