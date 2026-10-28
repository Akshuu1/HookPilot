import { describe, it, expect } from 'vitest';
import { redactHeaders } from '../headers.js';

describe('redactHeaders', () => {
  it('masks sensitive authorization, cookie, and api-key headers', () => {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret-jwt-token',
      Cookie: 'session=abc123xyz',
      'X-Api-Key': 'key_live_998877',
      'X-Signature': 'sha256=123456',
    };

    const redacted = redactHeaders(headers);

    expect(redacted['content-type']).toBe('application/json');
    expect(redacted['authorization']).toBe('[REDACTED]');
    expect(redacted['cookie']).toBe('[REDACTED]');
    expect(redacted['x-api-key']).toBe('[REDACTED]');
    expect(redacted['x-signature']).toBe('sha256=123456');
  });

  it('handles array headers cleanly', () => {
    const headers = {
      Accept: ['application/json', 'text/plain'],
    };
    const redacted = redactHeaders(headers);
    expect(redacted['accept']).toBe('application/json, text/plain');
  });
});
