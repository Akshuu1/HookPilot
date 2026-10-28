import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env.js';
import { requestIdMiddleware } from './middlewares/request-id.js';
import { httpLogger } from './middlewares/logger.js';
import { errorHandler, AppError } from './middlewares/error-handler.js';
import { healthRouter } from './routes/health.routes.js';

export function createApp(): Express {
  const app = express();

  // Security & parsing
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Tracing & logging
  app.use(requestIdMiddleware);
  app.use(httpLogger);

  // Routes
  app.use('/', healthRouter);

  // 404 Handler
  app.use((req, _res, next) => {
    next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404, 'NOT_FOUND'));
  });

  // Central error handler
  app.use(errorHandler);

  return app;
}

export const app = createApp();
