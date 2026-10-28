import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM

function getEncryptionKeyBuffer(): Buffer {
  const key = env.ENCRYPTION_KEY;
  if (/^[0-9a-fA-F]{64}$/.test(key)) {
    return Buffer.from(key, 'hex');
  }
  return Buffer.from(key.padEnd(32, '0').slice(0, 32), 'utf8');
}

/**
 * Encrypts a plaintext secret using AES-256-GCM.
 * Output format: iv_hex:auth_tag_hex:ciphertext_hex
 */
export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKeyBuffer();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts an AES-256-GCM encrypted payload.
 */
export function decryptSecret(payload: string): string {
  const key = getEncryptionKeyBuffer();
  const parts = payload.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload format');
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error('Invalid encrypted payload components');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Masks a secret so the raw value is never exposed by the API.
 * Shows only the last 4 characters.
 */
export function maskSecret(secret?: string | null): string | null {
  if (!secret) return null;
  const clean = secret.trim();
  if (clean.length <= 4) {
    return '****';
  }
  return `****${clean.slice(-4)}`;
}
