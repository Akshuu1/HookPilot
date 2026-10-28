import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'req.headers["x-hookpilot-signature"]',
      'req.headers["stripe-signature"]',
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
      '*.accessToken',
      '*.refreshToken',
      '*.apiKey',
      '*.key',
      '*.keyHash',
    ],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
