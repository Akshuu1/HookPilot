import { createHmac } from 'node:crypto';
import type { IEvent } from '../models/Event.js';
import type { IEndpoint } from '../models/Endpoint.js';
import { decryptSecret } from '../utils/crypto.js';
import { getRedisClient } from '../config/redis.js';
import { logger } from '../config/logger.js';

export type DeliveryClassification = 'success' | 'retryable' | 'permanent';

export interface DeliveryResult {
  status: number;
  durationMs: number;
  responseBodySnippet: string;
  error?: string | null;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  retryAfterSec?: number | null;
}

const HOP_BY_HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
]);

/**
 * Classifies HTTP response status:
 * - 2xx: success
 * - 408, 429, 5xx, or 0 (network/timeout): retryable
 * - other 4xx: permanent failure
 */
export function classifyResponse(status: number): DeliveryClassification {
  if (status >= 200 && status < 300) {
    return 'success';
  }
  if (status === 408 || status === 429 || (status >= 500 && status < 600) || status === 0) {
    return 'retryable';
  }
  if (status >= 400 && status < 500) {
    return 'permanent';
  }
  return 'retryable';
}

/**
 * Parses Retry-After header (supports either integer seconds or HTTP date string).
 */
export function parseRetryAfter(headerValue?: string | null): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();

  // Try parsing integer seconds
  const seconds = parseInt(trimmed, 10);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds;
  }

  // Try parsing HTTP date
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diffSec = Math.ceil((dateMs - Date.now()) / 1000);
    return Math.max(0, diffSec);
  }

  return null;
}

/**
 * Filters out hop-by-hop headers and adds HookPilot tracing and signature headers.
 */
export function buildForwardHeaders(
  event: IEvent,
  endpoint: IEndpoint,
  attemptNumber: number,
  timestamp: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const safeHeaders: Record<string, string> = {};

  // Convert event.headers (Map or Record) to safe headers
  const sourceHeaders =
    event.headers instanceof Map ? Object.fromEntries(event.headers) : event.headers || {};

  for (const [key, value] of Object.entries(sourceHeaders)) {
    const lowerKey = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lowerKey) && typeof value === 'string') {
      safeHeaders[lowerKey] = value;
    }
  }

  if (event.contentType && !safeHeaders['content-type']) {
    safeHeaders['content-type'] = event.contentType;
  }

  const eventIdStr = event._id ? event._id.toString() : event.id;
  safeHeaders['x-hookpilot-event-id'] = eventIdStr;
  safeHeaders['x-hookpilot-attempt'] = attemptNumber.toString();

  // Compute outbound HMAC signature: t=${timestamp},v1=${hmac}
  let signingSecret: string = endpoint.slug;
  if (endpoint.signatureConfig?.secretEncrypted) {
    try {
      signingSecret = decryptSecret(endpoint.signatureConfig.secretEncrypted);
    } catch {
      signingSecret = endpoint.slug;
    }
  }

  const signaturePayload = `${timestamp}.${event.rawBody}`;
  const hmac = createHmac('sha256', signingSecret).update(signaturePayload).digest('hex');
  safeHeaders['x-hookpilot-signature'] = `t=${timestamp},v1=${hmac}`;

  return safeHeaders;
}

/**
 * Performs HTTP POST delivery to destination URL with 10s AbortController timeout.
 */
export async function performDelivery(
  event: IEvent,
  endpoint: IEndpoint,
  attemptNumber: number,
  timeoutMs = 10000,
): Promise<DeliveryResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  const requestHeaders = buildForwardHeaders(event, endpoint, attemptNumber, timestamp);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const startTime = Date.now();

  try {
    const response = await fetch(endpoint.destinationUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: event.rawBody,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;

    // Read max 2 KB (2048 bytes) of response body snippet
    let responseBodySnippet = '';
    try {
      const fullText = await response.text();
      responseBodySnippet = fullText.slice(0, 2048);
    } catch {
      responseBodySnippet = '';
    }

    // Extract response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });

    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterSec = parseRetryAfter(retryAfterHeader);

    return {
      status: response.status,
      durationMs,
      responseBodySnippet,
      error: response.ok ? null : `HTTP ${response.status}`,
      requestHeaders,
      responseHeaders,
      retryAfterSec,
    };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;
    const errorObj = err as Error;

    let errorMessage = errorObj.message || 'Unknown network error';
    if (errorObj.name === 'AbortError') {
      errorMessage = `Delivery timed out after ${timeoutMs}ms`;
    }

    return {
      status: 0,
      durationMs,
      responseBodySnippet: '',
      error: errorMessage,
      requestHeaders,
      responseHeaders: {},
      retryAfterSec: null,
    };
  }
}

/**
 * Forwards event to an active CLI tunnel session via Redis pub/sub.
 * Waits up to timeoutMs (default 15s) for a 'tunnel:response'.
 * Returns null if no CLI is active or if the tunnel request timed out.
 */
export async function performTunnelDelivery(
  event: IEvent,
  endpoint: IEndpoint,
  attemptNumber: number,
  timeoutMs = 15000,
): Promise<DeliveryResult | null> {
  const redis = getRedisClient();
  const eventIdStr = event._id ? event._id.toString() : event.id;
  const endpointIdStr = endpoint._id ? endpoint._id.toString() : endpoint.id;

  try {
    const activeSocketId = await redis.get(`tunnel:endpoint:${endpointIdStr}`);
    if (!activeSocketId) {
      return null;
    }

    logger.info(
      { eventId: eventIdStr, endpointId: endpointIdStr, activeSocketId },
      'Active CLI session detected, routing delivery to tunnel',
    );

    const timestamp = Math.floor(Date.now() / 1000);
    const requestHeaders = buildForwardHeaders(event, endpoint, attemptNumber, timestamp);

    const subClient = redis.duplicate();
    subClient.on('error', (err) => {
      logger.warn({ err }, 'Tunnel subscriber redis client error');
    });

    const responseChannel = `tunnel:response:${eventIdStr}`;

    return await new Promise<DeliveryResult | null>((resolve) => {
      let resolved = false;

      const cleanup = async () => {
        try {
          await subClient.unsubscribe(responseChannel);
          await subClient.quit();
        } catch {
          subClient.disconnect();
        }
      };

      const timer = setTimeout(async () => {
        if (resolved) return;
        resolved = true;
        logger.warn(
          { eventId: eventIdStr, timeoutMs },
          'Tunnel response timed out; will fall back to remote delivery',
        );
        await cleanup();
        resolve(null);
      }, timeoutMs);

      subClient.subscribe(responseChannel, (err) => {
        if (err) {
          logger.error({ err, responseChannel }, 'Failed to subscribe to tunnel response channel');
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            void cleanup();
            resolve(null);
          }
          return;
        }

        const tunnelReq = {
          eventId: eventIdStr,
          endpointId: endpointIdStr,
          endpointSlug: endpoint.slug,
          method: event.method || 'POST',
          path: '/',
          headers: requestHeaders,
          rawBody: event.rawBody,
          timeoutMs,
        };

        void redis.publish('tunnel:requests', JSON.stringify(tunnelReq));
      });

      subClient.on('message', async (ch, message) => {
        if (ch !== responseChannel || resolved) return;
        resolved = true;
        clearTimeout(timer);

        try {
          const data = JSON.parse(message);
          await cleanup();
          resolve({
            status: Number(data.responseStatus) || 200,
            durationMs: Number(data.durationMs) || 0,
            responseBodySnippet:
              typeof data.responseBodySnippet === 'string' ? data.responseBodySnippet : '',
            error:
              data.error ||
              (Number(data.responseStatus) >= 400 ? `HTTP ${data.responseStatus}` : null),
            requestHeaders,
            responseHeaders: data.responseHeaders || {},
          });
        } catch (parseErr) {
          logger.error({ parseErr }, 'Error parsing tunnel response message');
          await cleanup();
          resolve(null);
        }
      });
    });
  } catch (err) {
    logger.error({ err, eventId: eventIdStr }, 'Unexpected error in performTunnelDelivery');
    return null;
  }
}
