import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { isOriginAllowed } from './config/cors.js';
import { requestIdMiddleware } from './middlewares/request-id.js';
import { httpLogger } from './middlewares/logger.js';
import { errorHandler, AppError } from './middlewares/error-handler.js';
import { healthRouter } from './routes/health.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { workspaceRouter } from './routes/workspace.routes.js';
import { endpointRouter } from './routes/endpoint.routes.js';
import { ingestRouter } from './routes/ingest.routes.js';
import { eventRouter } from './routes/event.routes.js';

export function createApp(): Express {
  const app = express();

  // Security headers via Helmet
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Strict CORS allowlist with credentials
  app.use(
    cors({
      origin: (origin, callback) => {
        if (isOriginAllowed(origin)) {
          callback(null, true);
        } else {
          callback(
            new AppError(`Origin '${origin}' not allowed by CORS policy`, 403, 'CORS_ERROR'),
          );
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'X-API-Key',
        'X-Idempotency-Key',
        'Stripe-Signature',
        'X-HookPilot-Signature',
      ],
      exposedHeaders: [
        'X-Request-Id',
        'RateLimit-Limit',
        'RateLimit-Remaining',
        'RateLimit-Reset',
        'Retry-After',
      ],
      maxAge: 86400,
    }),
  );

  // Tracing & logging
  app.use(requestIdMiddleware);
  app.use(httpLogger);

  // PUBLIC INGEST ROUTE: Mounted BEFORE the JSON body parser to capture exact raw bytes!
  app.use('/in', ingestRouter);

  // Body parsing for API / Dashboard routes
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser(env.COOKIE_SECRET));

  // Dashboard & Management Routes
  app.use('/auth', authRouter);
  app.use('/workspaces', workspaceRouter);
  app.use('/endpoints', endpointRouter);
  app.use('/events', eventRouter);
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
