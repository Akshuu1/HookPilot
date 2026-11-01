/**
 * Extracts explicit idempotency key for an incoming webhook.
 * In strict order of precedence:
 * 1. The Idempotency-Key header (or X-Idempotency-Key)
 * 2. X-GitHub-Delivery for GitHub
 * 3. The event id in the body (body.id) when a Stripe signature header is present (stripe-signature)
 * 4. The Webhook-Id header (Standard Webhooks)
 *
 * If no explicit key is found, returns null. NEVER derives a body-hash key!
 */
export function extractIdempotencyKey(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  _endpointId?: string,
): string | null {
  // Normalize header keys
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) {
      normalized[k.toLowerCase()] = Array.isArray(v) ? v[0] || '' : v;
    }
  }

  // 1. Idempotency-Key header (or x-idempotency-key)
  const idempotencyHeader = normalized['idempotency-key'] || normalized['x-idempotency-key'];
  if (idempotencyHeader && idempotencyHeader.trim().length > 0) {
    return idempotencyHeader.trim();
  }

  // 2. X-GitHub-Delivery for GitHub
  const githubDelivery = normalized['x-github-delivery'];
  if (githubDelivery && githubDelivery.trim().length > 0) {
    return githubDelivery.trim();
  }

  // 3. Event id in the body (body.id) when a Stripe signature header is present
  if (normalized['stripe-signature']) {
    try {
      const parsed = JSON.parse(rawBody) as { id?: unknown };
      if (typeof parsed.id === 'string' && parsed.id.trim().length > 0) {
        return parsed.id.trim();
      }
    } catch {
      // Body is not valid JSON
    }
  }

  // 4. Webhook-Id header (Standard Webhooks)
  const webhookId = normalized['webhook-id'];
  if (webhookId && webhookId.trim().length > 0) {
    return webhookId.trim();
  }

  // No explicit key
  return null;
}
