import type { Request, Response, NextFunction } from 'express';
import { AppError } from './error-handler.js';

const ONE_MB = 1024 * 1024;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBodyBuffer?: Buffer;
      rawBody?: string;
    }
  }
}

/**
 * Middleware capturing the exact raw bytes of the incoming request body before any parser.
 * Limits payload to 1 MB.
 */
export function rawBodyCapture(req: Request, _res: Response, next: NextFunction): void {
  // If already parsed, skip
  if (req.rawBodyBuffer) {
    next();
    return;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  req.on('data', (chunk: Buffer) => {
    totalBytes += chunk.length;
    if (totalBytes > ONE_MB) {
      req.destroy();
      next(
        new AppError('Payload Too Large: Maximum allowed size is 1 MB', 413, 'PAYLOAD_TOO_LARGE'),
      );
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    const rawBuffer = Buffer.concat(chunks);
    req.rawBodyBuffer = rawBuffer;
    req.rawBody = rawBuffer.toString('utf8');
    next();
  });

  req.on('error', (err) => {
    next(err);
  });
}
