import { createDecipheriv } from 'node:crypto';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKeyBuffer(): Buffer {
  const key = env.ENCRYPTION_KEY;
  if (/^[0-9a-fA-F]{64}$/.test(key)) {
    return Buffer.from(key, 'hex');
  }
  return Buffer.from(key.padEnd(32, '0').slice(0, 32), 'utf8');
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
