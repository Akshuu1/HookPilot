import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR', isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function errorHandler(
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = req.id || 'unknown';

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        requestId,
        details: err.flatten(),
      },
    });
    return;
  }

  if (err instanceof AppError) {
    logger.warn({ err, requestId }, `AppError: ${err.message}`);
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        requestId,
      },
    });
    return;
  }

  // Unhandled / unexpected errors
  logger.error({ err, requestId }, `Unhandled Exception: ${err.message}`);

  const message =
    env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message || 'Internal server error';

  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message,
      requestId,
    },
  });
}
