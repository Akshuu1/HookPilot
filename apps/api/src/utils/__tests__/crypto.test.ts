import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret, maskSecret } from '../crypto.js';

describe('AES-256-GCM Encryption', () => {
  it('encrypts and decrypts secret correctly', () => {
    const rawSecret = 'whsec_9b4a1c5d8e7f2a1b9c8d7e6f5a4b3c2d';
    const encrypted = encryptSecret(rawSecret);

    expect(encrypted).not.toBe(rawSecret);
    expect(encrypted.split(':')).toHaveLength(3);

    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(rawSecret);
  });

  it('produces different ciphertexts and IVs for the same plaintext', () => {
    const raw = 'my-webhook-signing-secret';
    const enc1 = encryptSecret(raw);
    const enc2 = encryptSecret(raw);

    expect(enc1).not.toBe(enc2);
    expect(decryptSecret(enc1)).toBe(raw);
    expect(decryptSecret(enc2)).toBe(raw);
  });

  it('throws on tampered ciphertext or auth tag', () => {
    const raw = 'secret-message';
    const encrypted = encryptSecret(raw);
    const [iv, authTag, ciphertext] = encrypted.split(':');

    // Tamper with ciphertext
    const tamperedCiphertext = ciphertext!.slice(0, -2) + (ciphertext!.endsWith('a') ? 'b' : 'a');
    const tamperedPayload = `${iv}:${authTag}:${tamperedCiphertext}`;

    expect(() => decryptSecret(tamperedPayload)).toThrow();
  });
});

describe('maskSecret', () => {
  it('returns null for null or undefined input', () => {
    expect(maskSecret(null)).toBeNull();
    expect(maskSecret(undefined)).toBeNull();
  });

  it('masks secret showing only the last 4 characters', () => {
    expect(maskSecret('whsec_abcdef1234')).toBe('****1234');
    expect(maskSecret('secret12345')).toBe('****2345');
  });

  it('masks short secrets appropriately', () => {
    expect(maskSecret('abc')).toBe('****');
    expect(maskSecret('1234')).toBe('****');
  });
});
