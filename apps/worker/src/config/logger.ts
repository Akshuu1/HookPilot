import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'headers.authorization',
      'headers.cookie',
      'headers["x-api-key"]',
      'headers["x-hookpilot-signature"]',
      'headers["stripe-signature"]',
      'password',
      'secret',
      'secretEncrypted',
      'token',
      'accessToken',
      'refreshToken',
      'apiKey',
      'key',
      'keyHash',
      '*.password',
      '*.secret',
      '*.secretEncrypted',
      '*.token',
      '*.apiKey',
      '*.keyHash',
    ],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
