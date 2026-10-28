import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySignature } from '../signature.js';

describe('verifySignature Utility', () => {
  const secret = 'whsec_test_secret_key_12345';
  const rawBody = JSON.stringify({ id: 'evt_12345', type: 'payment_intent.succeeded' });

  describe('Stripe Signature', () => {
    it('verifies a valid Stripe signature within tolerance', () => {
      const now = Math.floor(Date.now() / 1000);
      const payload = `${now}.${rawBody}`;
      const v1 = createHmac('sha256', secret).update(payload).digest('hex');

      const headers = {
        'stripe-signature': `t=${now},v1=${v1}`,
      };

      const result = verifySignature('stripe', headers, rawBody, secret);
      expect(result.isValid).toBe(true);
    });

    it('rejects a tampered payload with Stripe signature', () => {
      const now = Math.floor(Date.now() / 1000);
      const payload = `${now}.${rawBody}`;
      const v1 = createHmac('sha256', secret).update(payload).digest('hex');

      const headers = {
        'stripe-signature': `t=${now},v1=${v1}`,
      };

      const tamperedBody = JSON.stringify({ id: 'evt_12345', type: 'payment_intent.failed' });
      const result = verifySignature('stripe', headers, tamperedBody, secret);
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('mismatch');
    });

    it('rejects timestamps older than 5 minutes', () => {
      const oldTime = Math.floor(Date.now() / 1000) - 305; // 5m 5s ago
      const payload = `${oldTime}.${rawBody}`;
      const v1 = createHmac('sha256', secret).update(payload).digest('hex');

      const headers = {
        'stripe-signature': `t=${oldTime},v1=${v1}`,
      };

      const result = verifySignature('stripe', headers, rawBody, secret);
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('tolerance');
    });

    it('rejects missing or malformed header', () => {
      expect(verifySignature('stripe', {}, rawBody, secret).isValid).toBe(false);
      expect(
        verifySignature('stripe', { 'stripe-signature': 'malformed' }, rawBody, secret).isValid,
      ).toBe(false);
    });
  });

  describe('GitHub Signature', () => {
    it('verifies a valid GitHub X-Hub-Signature-256', () => {
      const hex = createHmac('sha256', secret).update(rawBody).digest('hex');
      const headers = {
        'x-hub-signature-256': `sha256=${hex}`,
      };

      const result = verifySignature('github', headers, rawBody, secret);
      expect(result.isValid).toBe(true);
    });

    it('rejects tampered GitHub payload', () => {
      const hex = createHmac('sha256', secret).update(rawBody).digest('hex');
      const headers = {
        'x-hub-signature-256': `sha256=${hex}`,
      };

      const result = verifySignature('github', headers, 'tampered-body', secret);
      expect(result.isValid).toBe(false);
    });
  });

  describe('Generic Signature', () => {
    it('verifies configurable custom header', () => {
      const hex = createHmac('sha256', secret).update(rawBody).digest('hex');
      const headers = {
        'x-custom-sig': hex,
      };

      const result = verifySignature('generic', headers, rawBody, secret, 'x-custom-sig');
      expect(result.isValid).toBe(true);
    });
  });

  describe('None Provider', () => {
    it('always passes for none provider', () => {
      expect(verifySignature('none', {}, rawBody, null).isValid).toBe(true);
    });
  });
});
