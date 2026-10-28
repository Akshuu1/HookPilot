import { createHash } from 'node:crypto';

/**
 * Extracts or derives an idempotency key for an incoming webhook.
 * Precedence:
 * 1. Standard headers (Idempotency-Key, X-Idempotency-Key, X-GitHub-Delivery, etc.)
 * 2. Provider event ID in JSON payload (e.g. Stripe's `evt_...`)
 * 3. Fallback: SHA-256 hash of endpointId + rawBody
 */
export function extractIdempotencyKey(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  endpointId: string,
): string {
  // Normalize header keys
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) {
      normalized[k.toLowerCase()] = Array.isArray(v) ? v[0] || '' : v;
    }
  }

  // Check headers
  const headerKey =
    normalized['idempotency-key'] ||
    normalized['x-idempotency-key'] ||
    normalized['x-github-delivery'] ||
    normalized['x-shopify-webhook-id'];

  if (headerKey && headerKey.trim().length > 0) {
    return headerKey.trim();
  }

  // Attempt to parse JSON to find event ID
  if (rawBody.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(rawBody) as { id?: unknown; event_id?: unknown };
      if (typeof parsed.id === 'string' && parsed.id.trim().length > 0) {
        return parsed.id.trim();
      }
      if (typeof parsed.event_id === 'string' && parsed.event_id.trim().length > 0) {
        return parsed.event_id.trim();
      }
    } catch {
      // Body is not valid JSON, proceed to fallback
    }
  }

  // Deterministic fallback: sha256(endpointId + rawBody)
  return createHash('sha256').update(`${endpointId}:${rawBody}`).digest('hex');
}
