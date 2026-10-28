import { pinoHttp } from 'pino-http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../config/logger.js';

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req: IncomingMessage) => req.id || 'unknown-id',
  customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req: IncomingMessage, res: ServerResponse) =>
    `${req.method} ${req.url} -> ${res.statusCode}`,
  customErrorMessage: (req: IncomingMessage, res: ServerResponse, err: Error) =>
    `${req.method} ${req.url} -> ${res.statusCode}: ${err.message}`,
  serializers: {
    req(req: IncomingMessage) {
      return {
        id: req.id,
        method: req.method,
        url: req.url,
      };
    },
    res(res: ServerResponse) {
      return {
        statusCode: res.statusCode,
      };
    },
  },
});
