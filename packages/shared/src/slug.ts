import { randomBytes } from 'node:crypto';

/**
 * Generates a cryptographically random, URL-safe slug.
 * Defaults to 12 characters (base64url encoded).
 */
export function generateSlug(length = 12): string {
  // 9 bytes produces exactly 12 base64url characters without padding
  const byteLength = Math.ceil((length * 3) / 4);
  return randomBytes(byteLength).toString('base64url').slice(0, length);
}
