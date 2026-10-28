import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SignatureProvider } from '@hookpilot/shared';

export interface SignatureVerificationResult {
  isValid: boolean;
  reason?: string;
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verifies inbound webhook signatures for Stripe, GitHub, or Generic providers.
 */
export function verifySignature(
  provider: SignatureProvider,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  secret?: string | null,
  headerName?: string | null,
): SignatureVerificationResult {
  if (provider === 'none') {
    return { isValid: true };
  }

  if (!secret) {
    return { isValid: false, reason: 'No secret configured for signature verification' };
  }

  // Normalize header keys
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (val !== undefined) {
      normalizedHeaders[key.toLowerCase()] = Array.isArray(val) ? val[0] || '' : val;
    }
  }

  if (provider === 'stripe') {
    const signatureHeader = normalizedHeaders['stripe-signature'];
    if (!signatureHeader) {
      return { isValid: false, reason: 'Missing Stripe-Signature header' };
    }

    const parts = signatureHeader.split(',');
    let timestamp: string | undefined;
    const v1Signatures: string[] = [];

    for (const part of parts) {
      const [key, val] = part.trim().split('=');
      if (key === 't' && val) timestamp = val;
      if (key === 'v1' && val) v1Signatures.push(val);
    }

    if (!timestamp || v1Signatures.length === 0) {
      return { isValid: false, reason: 'Malformed Stripe-Signature header' };
    }

    // 5-minute (300 seconds) tolerance check
    const timestampSec = parseInt(timestamp, 10);
    if (Number.isNaN(timestampSec)) {
      return { isValid: false, reason: 'Invalid timestamp in Stripe-Signature' };
    }

    const currentUnix = Math.floor(Date.now() / 1000);
    if (Math.abs(currentUnix - timestampSec) > 300) {
      return { isValid: false, reason: 'Signature timestamp outside 5-minute tolerance window' };
    }

    const payload = `${timestamp}.${rawBody}`;
    const expectedSignature = createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

    const matches = v1Signatures.some((sig) => safeCompare(sig, expectedSignature));
    if (!matches) {
      return { isValid: false, reason: 'Stripe signature mismatch' };
    }
    return { isValid: true };
  }

  if (provider === 'github') {
    const signatureHeader = normalizedHeaders['x-hub-signature-256'];
    if (!signatureHeader) {
      return { isValid: false, reason: 'Missing X-Hub-Signature-256 header' };
    }

    const prefix = 'sha256=';
    if (!signatureHeader.startsWith(prefix)) {
      return { isValid: false, reason: 'Invalid GitHub signature prefix' };
    }

    const signatureHex = signatureHeader.slice(prefix.length);
    const expectedHex = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');

    const matches = safeCompare(signatureHex, expectedHex);
    if (!matches) {
      return { isValid: false, reason: 'GitHub signature mismatch' };
    }
    return { isValid: true };
  }

  if (provider === 'generic') {
    const targetHeader = (headerName || 'x-signature-256').toLowerCase();
    const signatureHeader = normalizedHeaders[targetHeader];
    if (!signatureHeader) {
      return { isValid: false, reason: `Missing ${targetHeader} signature header` };
    }

    // Support both raw hex or sha256=hex format
    const cleanSignature = signatureHeader.startsWith('sha256=')
      ? signatureHeader.slice(7)
      : signatureHeader;

    const expectedHex = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');

    const matches = safeCompare(cleanSignature, expectedHex);
    if (!matches) {
      return { isValid: false, reason: 'Generic signature mismatch' };
    }
    return { isValid: true };
  }

  return { isValid: false, reason: `Unsupported provider: ${provider}` };
}
